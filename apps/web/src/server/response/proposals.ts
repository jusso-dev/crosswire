import { and, asc, count, desc, eq, inArray, isNull, lt, or } from 'drizzle-orm'
import { z } from 'zod'
import { getDb } from '../db/client'
import { huntCases, responseEvents, responseProposals } from '../db/schema'
import { env } from '../env'
import { writeAudit } from '../audit'
import { recordDecision } from '../agents/decisions'
import { redactValue } from '../lib/redact'
import { canonicalJson, sha256 } from '../agents/canonical'
import { RESPONSE_ACTION_TYPES, type ResponseProposalView } from '../../shared/response'
import type { OrgRole } from '../orgs'
import { asJson } from '../../shared/json'
import { assertCanDecide, canApprove, ForbiddenError } from './rbac'
import { assertExecutable, dryRun, executeLive, executorMode, loadExecContext, type ExecutionOutcome } from './executors'
import { logger } from '../lib/logger'
import { notify } from '../notify/notify'

export class ProposalStateError extends Error {}
export class ProposalNotFoundError extends Error {}

const APPROVAL_SCHEMA_VERSION = 1

/** Content the approval is bound to. Key order does not change the digest. */
export function approvalContentHash(content: { title: string; actionType: string; targets: unknown; blastRadius: unknown; payload: unknown }) {
  return sha256(
    canonicalJson({
      schemaVersion: APPROVAL_SCHEMA_VERSION,
      title: content.title,
      actionType: content.actionType,
      targets: content.targets,
      blastRadius: content.blastRadius,
      payload: content.payload,
    }),
  )
}

function assertApprovalBound(p: Row) {
  if (env().APPROVAL_BINDING === 'legacy') return
  if (!p.payloadSha256 || p.payloadSchemaVersion !== APPROVAL_SCHEMA_VERSION) {
    throw new ProposalStateError('Approval is not bound to the current content hash. Create a new proposal.')
  }
  if (approvalContentHash(p) !== p.payloadSha256) {
    throw new ProposalStateError('Approved content no longer matches the stored hash. Create a new proposal.')
  }
}

const identifier = z.string().trim().min(1).max(200)
const targetList = z
  .array(identifier)
  .max(50)
  .transform((xs) => [...new Set(xs)])
  .optional()

/** Create-proposal input (#50). Blast radius is mandatory; empty summaries are refused. */
export const proposalInput = z.object({
  title: z.string().trim().min(3).max(200),
  actionType: z.enum(RESPONSE_ACTION_TYPES),
  targets: z
    .object({ devices: targetList, users: targetList, incidents: targetList })
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
    rollbackOfId: r.rollbackOfId,
    payloadSha256: r.payloadSha256,
    payloadSchemaVersion: r.payloadSchemaVersion,
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
  opts: { rollbackOfId?: string } = {},
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
  const payload = redactValue(input.payload) as Record<string, unknown>
  const [row] = await getDb()
    .insert(responseProposals)
    .values({
      orgId,
      huntId: input.huntId ?? null,
      title: input.title,
      actionType: input.actionType,
      targets: t,
      blastRadius,
      payload,
      payloadSha256: approvalContentHash({ title: input.title, actionType: input.actionType, targets: t, blastRadius, payload }),
      payloadSchemaVersion: APPROVAL_SCHEMA_VERSION,
      requesterType: requester.type,
      requesterId,
      requestedByUserId,
      expiresAt,
      rollbackOfId: opts.rollbackOfId ?? null,
    })
    .returning()
  await event(orgId, row!.id, 'created', { type: requester.type, id: requesterId }, { actionType: input.actionType, blastRadius, rollbackOf: opts.rollbackOfId ?? null })
  await notify(orgId, 'approval_pending', {
    title: `${opts.rollbackOfId ? 'Rollback awaiting approval' : 'Response awaiting approval'}: ${row!.title}`,
    lines: [`${input.actionType} · ${blastRadius.devices} devices, ${blastRadius.users} users, ${blastRadius.incidents} incidents`, `Blast radius: ${blastRadius.summary}`],
    link: `/app/approvals/${row!.id}`,
  })
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

/**
 * Expiry job (#51): pending past expires_at -> expired. Approved-but-never-executed proposals past
 * their window also expire (v2), so a lapsed approval never blocks a new rollback or looks runnable.
 */
export async function expireProposals(now = new Date()) {
  const rows = await getDb()
    .update(responseProposals)
    .set({ status: 'expired' })
    .where(
      and(
        or(eq(responseProposals.status, 'pending'), and(eq(responseProposals.status, 'approved'), isNull(responseProposals.execution))),
        lt(responseProposals.expiresAt, now),
      ),
    )
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
  const outcome = dryRun(p, await loadExecContext(orgId))
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
  if (p.expiresAt.getTime() <= Date.now()) {
    await getDb()
      .update(responseProposals)
      .set({ status: 'expired' })
      .where(and(eq(responseProposals.id, id), eq(responseProposals.status, 'approved'), isNull(responseProposals.execution)))
    await event(orgId, id, 'expired', { type: 'system', id: null })
    throw new ProposalStateError('Approval window has expired; create a new proposal.')
  }
  assertApprovalBound(p)
  const mode = executorMode(p.actionType)
  if (mode === 'off') throw new ProposalStateError(`The ${p.actionType} executor is off. Set RESPONSE_EXECUTOR_* to dry-run or on.`)
  if (mode === 'dry-run') return dryRunProposal(orgId, actor, id)
  const ctx = await loadExecContext(orgId)
  // Refuse unexecutable proposals (allowlist, caps, config) before claiming, so they stay approved.
  try {
    assertExecutable(p, ctx)
  } catch (err) {
    throw new ProposalStateError(err instanceof Error ? err.message : String(err))
  }

  // Claim before any side effect: only one caller can set `execution` on an approved proposal.
  const [claimed] = await getDb()
    .update(responseProposals)
    .set({ execution: { status: 'in_progress', by: actor.userId, at: new Date().toISOString() } })
    .where(and(eq(responseProposals.id, id), eq(responseProposals.status, 'approved'), isNull(responseProposals.execution)))
    .returning({ id: responseProposals.id })
  if (!claimed) throw new ProposalStateError('Execution already started for this proposal.')
  await event(orgId, id, 'execute_attempt', { type: 'user', id: actor.userId }, { executor: p.actionType })
  const outcome = await executeLive(p, ctx, fetchImpl)
  // Partial success is recorded as failed (visible), but stays rollback-able for the calls that worked.
  const status = outcome.status === 'succeeded' ? 'executed' : 'failed'
  if (status === 'failed') logger.error('response execute failed', { orgId, proposalId: id, executor: p.actionType, status: outcome.status, error: outcome.error ?? null })
  const [updated] = await getDb()
    .update(responseProposals)
    .set({ status, execution: outcome as unknown as Record<string, unknown>, rollbackNotes: outcome.rollbackNotes })
    .where(eq(responseProposals.id, id))
    .returning({ id: responseProposals.id })
  if (!updated) throw new ProposalNotFoundError('Proposal not found.')
  const results = (outcome.results ?? []).map((r) => ({ target: r.target?.id ?? null, ok: r.ok, status: r.status, error: r.error ?? null }))
  await event(orgId, id, status === 'executed' ? 'executed' : 'execute_failed', { type: 'user', id: actor.userId }, { status: outcome.status, error: outcome.error ?? null, results })
  await recordDecision({ orgId, actorType: 'user', actorKey: actor.userId, action: 'execute_response', input: { proposalId: id }, output: { status: outcome.status }, huntId: p.huntId })
  await notify(orgId, 'execution', {
    title: `Response ${outcome.status}: ${p.title}`,
    lines: [`${p.actionType} · ${results.filter((r) => r.ok).length}/${results.length} calls succeeded`],
    link: `/app/approvals/${id}`,
  })
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

/** Targets that the original execution actually changed (#90). Pre-v2 outcomes had no per-call results. */
function succeededTargets(p: Row): { devices: string[]; incidents: string[] } {
  const exec = p.execution as { results?: Array<{ ok: boolean; target?: { kind: string; id: string } }> } | null
  // Pre-v2 outcomes, and executors whose calls are not per target (Logic App), act on all targets.
  if (!exec?.results || !exec.results.some((r) => r.target)) return { devices: p.targets.devices ?? [], incidents: p.targets.incidents ?? [] }
  const ok = exec.results.filter((r) => r.ok && r.target)
  return { devices: ok.filter((r) => r.target!.kind === 'device').map((r) => r.target!.id), incidents: ok.filter((r) => r.target!.kind === 'incident').map((r) => r.target!.id) }
}

/**
 * Rollback as a gated proposal (#90). Creates a NEW pending proposal linked by rollback_of_id; it goes
 * through the same approval, RBAC, self-approval, dry-run and expiry rules as any other proposal.
 * - Defender isolate -> unisolate for exactly the devices that were isolated.
 * - Playbook / Logic App runs cannot be reversed generically -> `other` (manual) carrying the notes.
 */
export async function proposeRollback(orgId: string, actor: { userId: string }, id: string) {
  const p = await getProposal(orgId, id)
  if (!p) throw new ProposalNotFoundError('Proposal not found.')
  if (p.status !== 'executed' && p.status !== 'failed') throw new ProposalStateError(`Only executed (or partly failed) proposals can be rolled back (this one is ${p.status}).`)
  if (p.rollbackOfId) throw new ProposalStateError('This proposal is itself a rollback; propose a new action instead.')
  const exec = p.execution as { mode?: string; status?: string; results?: Array<{ ok: boolean }> } | null
  const anyOk = exec?.results ? exec.results.some((r) => r.ok) : exec?.status === 'succeeded'
  if (!exec || exec.mode !== 'live' || !anyOk) throw new ProposalStateError('Nothing ran live successfully for this proposal, so there is nothing to roll back.')
  const done = succeededTargets(p)
  const [open] = await getDb()
    .select({ id: responseProposals.id, status: responseProposals.status })
    .from(responseProposals)
    .where(and(eq(responseProposals.orgId, orgId), eq(responseProposals.rollbackOfId, id), inArray(responseProposals.status, ['pending', 'approved', 'executed'])))
    .limit(1)
  if (open) throw new ProposalStateError(`A rollback already exists for this proposal (${open.status}).`)

  const isIsolate = p.actionType === 'graph_containment' && p.payload.action !== 'unisolate'
  const input: ProposalInput = isIsolate
    ? {
        title: `Rollback: release ${done.devices.length} device(s) from "${p.title}"`.slice(0, 200),
        actionType: 'graph_containment',
        targets: { devices: done.devices },
        blastRadius: { summary: `Releases ${done.devices.length} device(s) from isolation applied by proposal ${p.id}. Devices regain full network access.` },
        payload: { action: 'unisolate' },
        huntId: p.huntId ?? undefined,
      }
    : {
        title: `Rollback (manual): "${p.title}"`.slice(0, 200),
        actionType: 'other',
        targets: { devices: done.devices.length ? done.devices : undefined, incidents: done.incidents.length ? done.incidents : undefined, users: p.targets.users?.length ? p.targets.users : undefined },
        blastRadius: { summary: `Manual reversal of ${p.actionType} proposal ${p.id}. Follow the rollback notes and record what was reverted.` },
        payload: { action: 'manual_rollback', rollbackNotes: p.rollbackNotes ?? '' },
        huntId: p.huntId ?? undefined,
      }
  if (isIsolate && done.devices.length === 0) throw new ProposalStateError('No device was isolated by this proposal, so there is nothing to release.')
  let row: Row
  try {
    row = await createProposal(orgId, { type: 'user', userId: actor.userId }, input, { rollbackOfId: id })
  } catch (err) {
    // Unique partial index: a concurrent rollback won the race.
    if (/rollback_of_uq|duplicate key/i.test(String((err as { cause?: unknown })?.cause ?? err))) throw new ProposalStateError('A rollback already exists for this proposal.')
    throw err
  }
  await event(orgId, id, 'rollback_proposed', { type: 'user', id: actor.userId }, { rollbackId: row.id })
  return row
}

export async function findRollback(orgId: string, id: string) {
  const [r] = await getDb()
    .select({ id: responseProposals.id, status: responseProposals.status })
    .from(responseProposals)
    .where(and(eq(responseProposals.orgId, orgId), eq(responseProposals.rollbackOfId, id)))
    .orderBy(desc(responseProposals.createdAt))
    .limit(1)
  return r ?? null
}
