import { and, asc, count, desc, eq, lt } from 'drizzle-orm'
import { getDb } from '../db/client'
import { huntCases, huntEvidence, huntSchedules, kqlProposals, watchHits } from '../db/schema'
import { env } from '../env'
import { recordDecision } from '../agents/decisions'
import { assertSafeKql } from './safety'
import { huntingClient } from './client'
import { logger } from '../lib/logger'
import type { OrgRole } from '../orgs'
import { KQL_APPROVAL_MESSAGES, kqlApprovalBlock, type KqlApprovalPolicy } from '../../shared/kql-approval'

export type Actor = { type: 'user'; id: string } | { type: 'agent'; id: string }

export class NotFoundError extends Error {}
export class StateError extends Error {}

export async function createHunt(orgId: string, userId: string | null, input: { title: string; hypothesis?: string; threadId?: string | null; watchHitId?: string | null }) {
  const title = input.title.trim()
  if (!title) throw new StateError('Title is required.')
  const [row] = await getDb()
    .insert(huntCases)
    .values({ orgId, title: title.slice(0, 200), hypothesis: input.hypothesis?.trim() ?? '', createdBy: userId, threadId: input.threadId ?? null, watchHitId: input.watchHitId ?? null })
    .returning()
  return row!
}

export async function listHunts(orgId: string) {
  return getDb().select().from(huntCases).where(eq(huntCases.orgId, orgId)).orderBy(desc(huntCases.updatedAt)).limit(200)
}

export async function countHunts(orgId: string) {
  const [r] = await getDb().select({ n: count() }).from(huntCases).where(eq(huntCases.orgId, orgId))
  return r?.n ?? 0
}

export async function getHunt(orgId: string, huntId: string) {
  const db = getDb()
  const [hunt] = await db.select().from(huntCases).where(and(eq(huntCases.orgId, orgId), eq(huntCases.id, huntId))).limit(1)
  if (!hunt) return null
  const evidence = await db.select().from(huntEvidence).where(and(eq(huntEvidence.orgId, orgId), eq(huntEvidence.huntId, huntId))).orderBy(asc(huntEvidence.createdAt))
  const proposals = await db.select().from(kqlProposals).where(and(eq(kqlProposals.orgId, orgId), eq(kqlProposals.huntId, huntId))).orderBy(desc(kqlProposals.createdAt))
  // The watch hit this hunt started from (org-scoped, so a hit id from another org never resolves).
  const [origin] = hunt.watchHitId
    ? await db
        .select({ id: watchHits.id, title: watchHits.title, url: watchHits.url, source: watchHits.source, cveIds: watchHits.cveIds, createdAt: watchHits.createdAt })
        .from(watchHits)
        .where(and(eq(watchHits.orgId, orgId), eq(watchHits.id, hunt.watchHitId)))
        .limit(1)
    : []
  return { hunt, evidence, proposals, origin: origin ?? null }
}

export async function setHuntStatus(orgId: string, huntId: string, status: 'open' | 'closed') {
  await getDb().update(huntCases).set({ status }).where(and(eq(huntCases.orgId, orgId), eq(huntCases.id, huntId)))
  if (status === 'closed') {
    // Closing a case stops its scheduled hunts (#92); reopening needs a human to re-approve them.
    await getDb()
      .update(huntSchedules)
      .set({ enabled: false, disabledReason: 'hunt closed' })
      .where(and(eq(huntSchedules.orgId, orgId), eq(huntSchedules.huntId, huntId), eq(huntSchedules.enabled, true)))
  }
}

export async function addEvidence(orgId: string, huntId: string, type: (typeof huntEvidence.$inferInsert)['type'], payload: Record<string, unknown>, actor: Actor | { type: 'system'; id: null }) {
  await getDb().insert(huntEvidence).values({ orgId, huntId, type, payload, actorType: actor.type, actorId: actor.id })
  await getDb().update(huntCases).set({ updatedAt: new Date() }).where(eq(huntCases.id, huntId))
}

async function requireHunt(orgId: string, huntId: string) {
  const [hunt] = await getDb().select({ id: huntCases.id }).from(huntCases).where(and(eq(huntCases.orgId, orgId), eq(huntCases.id, huntId))).limit(1)
  if (!hunt) throw new NotFoundError('Hunt not found.')
}

/**
 * Propose KQL (#48). Never executes. Safety-checked up front so blocked queries never reach review.
 * `requestedBy` records the person behind the search: the user for a user actor, or the chat user an
 * agent is acting for (`input.requestedBy`). It feeds the second-person approval policy.
 */
export async function proposeKql(
  orgId: string,
  actor: Actor,
  input: { huntId: string; target: 'defender' | 'sentinel'; kql: string; rationale?: string; threadId?: string | null; requestedBy?: string | null },
) {
  await requireHunt(orgId, input.huntId)
  const kql = assertSafeKql(input.kql)
  const expiresAt = new Date(Date.now() + env().KQL_PROPOSAL_TTL_HOURS * 3600_000)
  const requestedBy = actor.type === 'user' ? actor.id : (input.requestedBy ?? null)
  const [p] = await getDb()
    .insert(kqlProposals)
    .values({ orgId, huntId: input.huntId, target: input.target, kql, originalKql: kql, rationale: input.rationale ?? '', proposedByType: actor.type, proposedById: actor.id, requestedBy, expiresAt })
    .returning()
  await addEvidence(orgId, input.huntId, 'kql_proposed', { proposalId: p!.id, target: input.target, kql, rationale: input.rationale ?? '' }, actor)
  await recordDecision({ orgId, actorType: actor.type, actorKey: actor.id, action: 'propose_kql', input: { target: input.target, kql }, output: { proposalId: p!.id }, huntId: input.huntId, threadId: input.threadId })
  return p!
}

/** Mark stale proposals expired so old KQL is never run blindly. */
export async function expireKqlProposals(now = new Date()) {
  const rows = await getDb()
    .update(kqlProposals)
    .set({ status: 'expired' })
    .where(and(eq(kqlProposals.status, 'proposed'), lt(kqlProposals.expiresAt, now)))
    .returning({ id: kqlProposals.id })
  return rows.length
}

/** Human rejects a proposal. Rejected proposals can never run. */
export async function rejectKql(orgId: string, userId: string, proposalId: string, reason?: string) {
  const [p] = await getDb()
    .update(kqlProposals)
    .set({ status: 'rejected', decidedBy: userId, decidedAt: new Date() })
    .where(and(eq(kqlProposals.orgId, orgId), eq(kqlProposals.id, proposalId), eq(kqlProposals.status, 'proposed')))
    .returning()
  if (!p) throw new StateError('Only a pending proposal can be rejected.')
  await addEvidence(orgId, p.huntId, 'kql_rejected', { proposalId, reason: reason ?? '' }, { type: 'user', id: userId })
  await recordDecision({ orgId, actorType: 'user', actorKey: userId, action: 'reject_kql', input: { proposalId, reason }, huntId: p.huntId })
  return p
}

export type { KqlApprovalPolicy }

/** KQL_APPROVAL_POLICY check, run before a proposal is claimed (rules in src/shared/kql-approval.ts). */
export function assertMayApproveKql(
  policy: KqlApprovalPolicy,
  caller: { userId: string; role: OrgRole | undefined },
  proposal: { requestedBy: string | null; proposedByType: 'user' | 'agent'; proposedById: string },
  edited: boolean,
) {
  const block = kqlApprovalBlock(policy, caller, proposal, edited)
  if (block) throw new StateError(KQL_APPROVAL_MESSAGES[block])
}

/**
 * Human approves (optionally editing) and runs a proposal. This is the ONLY path that executes KQL,
 * and it requires a human user id: agent tools cannot call it. The stored `kql` is exactly what ran.
 * `role` is the caller's org role; KQL_APPROVAL_POLICY decides whether it is needed.
 */
export async function approveAndRunKql(orgId: string, userId: string, proposalId: string, editedKql?: string, role?: OrgRole) {
  const db = getDb()
  const [existing] = await db.select().from(kqlProposals).where(and(eq(kqlProposals.orgId, orgId), eq(kqlProposals.id, proposalId))).limit(1)
  if (!existing) throw new NotFoundError('Proposal not found.')
  if (existing.status !== 'proposed') throw new StateError(`Proposal is ${existing.status}; only a pending proposal can be approved.`)
  if (existing.expiresAt.getTime() < Date.now()) {
    await db.update(kqlProposals).set({ status: 'expired' }).where(eq(kqlProposals.id, proposalId))
    throw new StateError('Proposal has expired. Propose it again to run it.')
  }
  const kql = assertSafeKql(editedKql ?? existing.kql)
  assertMayApproveKql(env().KQL_APPROVAL_POLICY, { userId, role }, existing, kql !== existing.kql)
  // Claim atomically: only one approver can move proposed -> approved.
  const [claimed] = await db
    .update(kqlProposals)
    .set({ status: 'approved', kql, decidedBy: userId, decidedAt: new Date() })
    .where(and(eq(kqlProposals.id, proposalId), eq(kqlProposals.status, 'proposed')))
    .returning()
  if (!claimed) throw new StateError('Proposal was already decided.')
  await addEvidence(orgId, existing.huntId, 'kql_approved', { proposalId, kql, edited: kql !== existing.originalKql }, { type: 'user', id: userId })

  try {
    const client = huntingClient()
    const result = existing.target === 'defender' ? await client.runAdvancedHunting({ orgId, kql }) : await client.runSentinelKql({ orgId, kql })
    const summary = { mode: result.mode, rowCount: result.rowCount, truncated: result.truncated, columns: result.columns, sample: result.rows.slice(0, 20), durationMs: result.durationMs }
    await db.update(kqlProposals).set({ status: 'run', ranAt: new Date(), resultSummary: summary }).where(eq(kqlProposals.id, proposalId))
    await addEvidence(orgId, existing.huntId, 'kql_result', { proposalId, kql, approvedBy: userId, ...summary }, { type: 'system', id: null })
    await recordDecision({ orgId, actorType: 'user', actorKey: userId, action: 'run_kql', input: { proposalId, kql }, output: { rowCount: result.rowCount, mode: result.mode }, huntId: existing.huntId })
    return { status: 'run' as const, summary }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error('hunt run_kql failed', { orgId, proposalId, target: existing.target, error: message })
    await db.update(kqlProposals).set({ status: 'failed', error: message }).where(eq(kqlProposals.id, proposalId))
    await addEvidence(orgId, existing.huntId, 'kql_failed', { proposalId, error: message }, { type: 'system', id: null })
    await recordDecision({ orgId, actorType: 'user', actorKey: userId, action: 'run_kql_failed', input: { proposalId }, output: message, huntId: existing.huntId })
    return { status: 'failed' as const, error: message }
  }
}
