import { and, asc, count, desc, eq, isNull, lt } from 'drizzle-orm'
import { z } from 'zod'
import { getDb } from '../db/client'
import { huntCases, responseEvents, responseProposals } from '../db/schema'
import { env } from '../env'
import { writeAudit } from '../audit'
import { recordDecision } from '../agents/decisions'
import { redactValue } from '../lib/redact'
import { RESPONSE_ACTION_TYPES, type ResponseProposalView } from '../../shared/response'
import type { OrgRole } from '../orgs'
import { asJson } from '../../shared/json'
import { assertCanDecide, canApprove, ForbiddenError } from './rbac'
import { dryRun, executeLive, executorMode, type ExecutionOutcome } from './executors'

export class ProposalStateError extends Error {}
export class ProposalNotFoundError extends Error {}

const identifier = z.string().trim().min(1).max(200)

/** Create-proposal input (#50). Blast radius is mandatory; empty summaries are refused. */
export const proposalInput = z.object({
  title: z.string().trim().min(3).max(200),
  actionType: z.enum(RESPONSE_ACTION_TYPES),
  targets: z
    .object({ devices: z.array(identifier).max(50).optional(), users: z.array(identifier).max(50).optional(), incidents: z.array(identifier).max(50).optional() })
    .refine((t) => (t.devices?.length ?? 0) + (t.users?.length ?? 0) + (t.incidents?.length ?? 0) > 0, 'At least one explicit target is required.'),
  blastRadius: z.object({ summary: z.string().trim().min(10, 'Blast radius summary is required (at least 10 characters).').max(1000) }),
  payload: z.record(z.string(), z.unknown()).default({}),
  huntId: z.string().optional(),
  expiresInHours: z.number().int().positive().max(168).optional(),
})
export type ProposalInput = z.input<typeof proposalInput>

type Row = typeof responseProposals.$inferSelect

export function toView(r: Row): ResponseProposalView {
  return {
    id: r.id,
    huntId: r.huntId,
    title: r.title,
    actionType: r.actionType,
    targets: r.targets,
    blastRadius: r.blastRadius,
    payload: asJson(r.payload),
    requesterType: r.requesterType,
    requesterId: r.requesterId,
    status: r.status,
    expiresAt: r.expiresAt.toISOString(),
    createdAt: r.createdAt.toISOString(),
    decidedBy: r.decidedBy,
    decidedAt: r.decidedAt?.toISOString() ?? null,
    decisionComment: r.decisionComment,
    lastDryRun: r.lastDryRun ? asJson(r.lastDryRun) : null,
    execution: r.execution ? asJson(r.execution) : null,
    rollbackNotes: r.rollbackNotes,
  }
}

async function event(orgId: string, proposalId: string, ev: (typeof responseEvents.$inferInsert)['event'], actor: { type: 'user' | 'agent' | 'system'; id: string | null }, data: Record<string, unknown> = {}) {
  const safe = redactValue(data) as Record<string, unknown>
  await getDb().insert(responseEvents).values({ orgId, proposalId, event: ev, actorType: actor.type, actorId: actor.id, data: safe })
  await writeAudit({ category: 'response', action: ev, actorType: actor.type, actorId: actor.id, orgId, targetType: 'response_proposal', targetId: proposalId, data: safe })
}

export async function createProposal(
  orgId: string,
  requester: { type: 'user'; userId: string } | { type: 'agent'; agentKey: string; onBehalfOfUserId: string },
  raw: ProposalInput,
) {
  const input = proposalInput.parse(raw)
  if (input.huntId) {
    const [h] = await getDb().select({ id: huntCases.id }).from(huntCases).where(and(eq(huntCases.orgId, orgId), eq(huntCases.id, input.huntId))).limit(1)
    if (!h) throw new ProposalNotFoundError('Hunt not found in this org.')
  }
  const t = input.targets
  const blastRadius = { summary: input.blastRadius.summary, devices: t.devices?.length ?? 0, users: t.users?.length ?? 0, incidents: t.incidents?.length ?? 0 }
  const expiresAt = new Date(Date.now() + (input.expiresInHours ?? env().RESPONSE_PROPOSAL_TTL_HOURS) * 3600_000)
  const requesterId = requester.type === 'user' ? requester.userId : requester.agentKey
  const requestedByUserId = requester.type === 'user' ? requester.userId : requester.onBehalfOfUserId
  const [row] = await getDb()
    .insert(responseProposals)
    .values({
      orgId,
      huntId: input.huntId ?? null,
      title: input.title,
      actionType: input.actionType,
      targets: t,
      blastRadius,
      payload: redactValue(input.payload) as Record<string, unknown>,
      requesterType: requester.type,
      requesterId,
      requestedByUserId,
      expiresAt,
    })
    .returning()
  await event(orgId, row!.id, 'created', { type: requester.type, id: requesterId }, { actionType: input.actionType, blastRadius })
  return row!
}

export async function getProposal(orgId: string, id: string) {
  const [row] = await getDb().select().from(responseProposals).where(and(eq(responseProposals.orgId, orgId), eq(responseProposals.id, id))).limit(1)
  return row ?? null
}

export async function listProposals(orgId: string, status?: Row['status']) {
  const where = status ? and(eq(responseProposals.orgId, orgId), eq(responseProposals.status, status)) : eq(responseProposals.orgId, orgId)
  return getDb().select().from(responseProposals).where(where).orderBy(desc(responseProposals.createdAt)).limit(200)
}

export async function countPending(orgId: string) {
  const [r] = await getDb().select({ n: count() }).from(responseProposals).where(and(eq(responseProposals.orgId, orgId), eq(responseProposals.status, 'pending')))
  return r?.n ?? 0
}

export async function listEvents(orgId: string, proposalId: string) {
  return getDb().select().from(responseEvents).where(and(eq(responseEvents.orgId, orgId), eq(responseEvents.proposalId, proposalId))).orderBy(asc(responseEvents.createdAt))
}

/** Expiry job (#51): pending past expires_at -> expired. */
export async function expireProposals(now = new Date()) {
  const rows = await getDb()
    .update(responseProposals)
    .set({ status: 'expired' })
    .where(and(eq(responseProposals.status, 'pending'), lt(responseProposals.expiresAt, now)))
    .returning({ id: responseProposals.id, orgId: responseProposals.orgId })
  for (const r of rows) await event(r.orgId, r.id, 'expired', { type: 'system', id: null })
  return rows.length
}

async function loadPendingForDecision(orgId: string, id: string) {
  const p = await getProposal(orgId, id)
  if (!p) throw new ProposalNotFoundError('Proposal not found.')
  if (p.status === 'pending' && p.expiresAt.getTime() <= Date.now()) {
    await getDb().update(responseProposals).set({ status: 'expired' }).where(and(eq(responseProposals.id, id), eq(responseProposals.status, 'pending')))
    await event(orgId, id, 'expired', { type: 'system', id: null })
    throw new ProposalStateError('Proposal has expired and can no longer be approved or executed.')
  }
  if (p.status !== 'pending') throw new ProposalStateError(`Proposal is already ${p.status}.`)
  return p
}

/** Approve / reject (#51). Server-side transitions only; status is never client-supplied. */
export async function decideProposal(orgId: string, actor: { userId: string; role: OrgRole }, id: string, decision: 'approve' | 'reject', comment?: string) {
  const p = await loadPendingForDecision(orgId, id)
  assertCanDecide(actor.role, actor.userId, p)
  const status = decision === 'approve' ? 'approved' : 'rejected'
  const [row] = await getDb()
    .update(responseProposals)
    .set({ status, decidedBy: actor.userId, decidedAt: new Date(), decisionComment: comment?.trim() || null })
    .where(and(eq(responseProposals.id, id), eq(responseProposals.status, 'pending')))
    .returning()
  if (!row) throw new ProposalStateError('Proposal was already decided.')
  await event(orgId, id, status, { type: 'user', id: actor.userId }, { comment: comment ?? '' })
  await recordDecision({ orgId, actorType: 'user', actorKey: actor.userId, action: `${decision}_response`, input: { proposalId: id }, huntId: p.huntId })
  return row
}

/** Dry run (#53): allowed for approvers on pending or approved proposals. Never calls mutating endpoints. */
export async function dryRunProposal(orgId: string, actor: { userId: string; role: OrgRole }, id: string) {
  if (!canApprove(actor.role)) throw new ForbiddenError('Only owners and approvers can dry-run response proposals.')
  const p = await getProposal(orgId, id)
  if (!p) throw new ProposalNotFoundError('Proposal not found.')
  if (p.status !== 'pending' && p.status !== 'approved') throw new ProposalStateError(`Cannot dry-run a ${p.status} proposal.`)
  const outcome = dryRun(p)
  await getDb().update(responseProposals).set({ lastDryRun: outcome as unknown as Record<string, unknown>, rollbackNotes: outcome.rollbackNotes }).where(eq(responseProposals.id, id))
  await event(orgId, id, 'dry_run', { type: 'user', id: actor.userId }, { calls: outcome.calls.length })
  return outcome
}

/**
 * Execute (#52). Only reachable for an APPROVED, unexpired proposal by an approver. Respects executor
 * flags: `dry-run` records a dry run instead; `off` refuses. There is no agent tool that calls this.
 */
export async function executeProposal(orgId: string, actor: { userId: string; role: OrgRole }, id: string, fetchImpl: typeof fetch = fetch): Promise<ExecutionOutcome> {
  if (!canApprove(actor.role)) throw new ForbiddenError('Only owners and approvers can execute response proposals.')
  const p = await getProposal(orgId, id)
  if (!p) throw new ProposalNotFoundError('Proposal not found.')
  if (p.status !== 'approved') throw new ProposalStateError(`Only approved proposals can execute (this one is ${p.status}).`)
  if (p.expiresAt.getTime() <= Date.now()) throw new ProposalStateError('Approval window has expired; create a new proposal.')
  const mode = executorMode(p.actionType)
  if (mode === 'off') throw new ProposalStateError(`The ${p.actionType} executor is off. Set RESPONSE_EXECUTOR_* to dry-run or on.`)
  if (mode === 'dry-run') return dryRunProposal(orgId, actor, id)

  // Claim before any side effect: only one caller can set `execution` on an approved proposal.
  const [claimed] = await getDb()
    .update(responseProposals)
    .set({ execution: { status: 'in_progress', by: actor.userId, at: new Date().toISOString() } })
    .where(and(eq(responseProposals.id, id), eq(responseProposals.status, 'approved'), isNull(responseProposals.execution)))
    .returning({ id: responseProposals.id })
  if (!claimed) throw new ProposalStateError('Execution already started for this proposal.')
  await event(orgId, id, 'execute_attempt', { type: 'user', id: actor.userId }, { executor: p.actionType })
  const outcome = await executeLive(p, fetchImpl)
  const status = outcome.status === 'succeeded' || outcome.status === 'stub' ? 'executed' : 'failed'
  const [updated] = await getDb()
    .update(responseProposals)
    .set({ status, execution: outcome as unknown as Record<string, unknown>, rollbackNotes: outcome.rollbackNotes })
    .where(eq(responseProposals.id, id))
    .returning({ id: responseProposals.id })
  if (!updated) throw new ProposalNotFoundError('Proposal not found.')
  await event(orgId, id, status === 'executed' ? 'executed' : 'execute_failed', { type: 'user', id: actor.userId }, { status: outcome.status, error: outcome.error ?? null, response: outcome.response ?? null })
  await recordDecision({ orgId, actorType: 'user', actorKey: actor.userId, action: 'execute_response', input: { proposalId: id }, output: { status: outcome.status }, huntId: p.huntId })
  return outcome
}

/** JSON audit bundle for one proposal (#54). Contains no tokens: payloads are redacted on write. */
export async function auditBundle(orgId: string, id: string) {
  const p = await getProposal(orgId, id)
  if (!p) throw new ProposalNotFoundError('Proposal not found.')
  const events = await listEvents(orgId, id)
  return {
    exportedAt: new Date().toISOString(),
    proposal: toView(p),
    events: events.map((e) => ({ id: e.id, event: e.event, actorType: e.actorType, actorId: e.actorId, data: asJson(e.data), createdAt: e.createdAt.toISOString() })),
  }
}
