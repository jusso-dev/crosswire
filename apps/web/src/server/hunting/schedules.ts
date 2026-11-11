import { and, asc, eq, gt, lte, ne, sql } from 'drizzle-orm'
import { getDb } from '../db/client'
import { huntCases, huntSchedules, kqlProposals, orgMemberships } from '../db/schema'
import { env } from '../env'
import { recordDecision } from '../agents/decisions'
import { logger } from '../lib/logger'
import { notify } from '../notify/notify'
import { canApprove } from '../response/rbac'
import type { OrgRole } from '../orgs'
import { KQL_APPROVAL_MESSAGES, kqlApprovalBlock } from '../../shared/kql-approval'
import { assertSafeKql } from './safety'
import { huntingClient, huntingContext, sameHuntingContext, type HuntingContext, type QueryResult } from './client'
import { addEvidence, NotFoundError, recordRunAudit, StateError } from './hunts'

/**
 * Scheduled hunts (#92). A schedule is a frozen copy of KQL that a human already approved and ran.
 * Only owners/approvers create, re-approve or disable schedules; there is no agent tool. Approval
 * lasts at most 30 days, after which the schedule disables itself until a human re-approves it.
 * Creating and re-approving also apply KQL_APPROVAL_POLICY to the source search, and bind the
 * approval to the place the search ran (demo, or the connector's tenant and workspace) (#189).
 */
export const MIN_INTERVAL_MINUTES = 60
export const MAX_INTERVAL_MINUTES = 7 * 24 * 60
export const MAX_APPROVAL_DAYS = 30
/** A claimed run that has not finished after this long is considered abandoned and can be reclaimed. */
const CLAIM_LEASE_MS = 10 * 60_000

type Actor = { userId: string; role: OrgRole }

function assertApprover(actor: Actor) {
  if (!canApprove(actor.role)) throw new StateError('Only owners and approvers can manage scheduled hunts.')
}

const DUPLICATE_MESSAGE = 'This query already has an enabled schedule.'

/**
 * Approving a schedule approves its query again, so KQL_APPROVAL_POLICY applies to the search it
 * came from (#189): under `second-person`, the person who asked for the search cannot schedule or
 * re-approve it. A schedule whose source search was deleted has no requester to check, so only
 * the `member` and `approver` policies can re-approve it.
 */
function assertPolicyAllows(actor: Actor, source: Pick<typeof kqlProposals.$inferSelect, 'requestedBy' | 'proposedByType' | 'proposedById'> | null) {
  const policy = env().KQL_APPROVAL_POLICY
  if (!source) {
    if (policy === 'second-person') throw new StateError('The search this schedule came from no longer exists, so a second person cannot be checked. Propose and run the search again, then schedule that.')
    return
  }
  const block = kqlApprovalBlock(policy, actor, source, false)
  if (block) throw new StateError(KQL_APPROVAL_MESSAGES[block])
}

/**
 * Where a schedule may run now (#189). Refuses a demo-mode approval once a real connector exists,
 * so a schedule made from demo data never starts querying a real tenant.
 */
async function contextToApprove(orgId: string, ranMode: 'live' | 'demo' | undefined): Promise<HuntingContext> {
  const ctx = await huntingContext(orgId)
  if (ranMode === 'demo' && ctx.mode !== 'demo') throw new StateError('This search ran on demo data, and this organisation now uses a real tenant. Run the search again against the tenant, then schedule that.')
  return ctx
}

/** True for the partial unique index on enabled schedules (#207); drizzle wraps the driver error. */
function isDuplicateEnabled(err: unknown) {
  return /hunt_schedules_source_enabled_uq/.test(`${String(err)} ${String((err as { cause?: unknown })?.cause ?? '')}`)
}

async function assertNoOtherEnabled(orgId: string, sourceProposalId: string | null, exceptId?: string) {
  if (!sourceProposalId) return
  const [dup] = await getDb()
    .select({ id: huntSchedules.id })
    .from(huntSchedules)
    .where(and(eq(huntSchedules.orgId, orgId), eq(huntSchedules.sourceProposalId, sourceProposalId), eq(huntSchedules.enabled, true), exceptId ? ne(huntSchedules.id, exceptId) : undefined))
    .limit(1)
  if (dup) throw new StateError(DUPLICATE_MESSAGE)
}

function clampInterval(minutes: number) {
  if (!Number.isInteger(minutes) || minutes < MIN_INTERVAL_MINUTES || minutes > MAX_INTERVAL_MINUTES) {
    throw new StateError(`Interval must be a whole number of minutes between ${MIN_INTERVAL_MINUTES} and ${MAX_INTERVAL_MINUTES}.`)
  }
  return minutes
}

function approvalExpiry(days: number | undefined, from = new Date()) {
  const d = Math.min(Math.max(Math.floor(days ?? MAX_APPROVAL_DAYS), 1), MAX_APPROVAL_DAYS)
  return new Date(from.getTime() + d * 86_400_000)
}

export async function createSchedule(orgId: string, actor: Actor, input: { proposalId: string; intervalMinutes: number; approvalDays?: number }) {
  assertApprover(actor)
  const interval = clampInterval(input.intervalMinutes)
  const [p] = await getDb().select().from(kqlProposals).where(and(eq(kqlProposals.orgId, orgId), eq(kqlProposals.id, input.proposalId))).limit(1)
  if (!p) throw new NotFoundError('KQL proposal not found.')
  if (p.status !== 'run') throw new StateError('Only a query that a person approved and that ran successfully can be scheduled.')
  const kql = assertSafeKql(p.kql)
  assertPolicyAllows(actor, p)
  const context = await contextToApprove(orgId, (p.resultSummary as { mode?: 'live' | 'demo' } | null)?.mode)
  // A friendly early refusal. The partial unique index is what holds under concurrent requests.
  await assertNoOtherEnabled(orgId, p.id)
  const now = new Date()
  const inserted = await getDb()
    .insert(huntSchedules)
    .values({
      orgId,
      huntId: p.huntId,
      sourceProposalId: p.id,
      target: p.target,
      kql,
      intervalMinutes: interval,
      approvedBy: actor.userId,
      approvedAt: now,
      approvalExpiresAt: approvalExpiry(input.approvalDays, now),
      nextRunAt: new Date(now.getTime() + interval * 60_000),
      lastRowCount: (p.resultSummary as { rowCount?: number } | null)?.rowCount ?? null,
      approvedContext: context,
    })
    .returning()
    .catch((err: unknown) => {
      if (isDuplicateEnabled(err)) throw new StateError(DUPLICATE_MESSAGE)
      throw err
    })
  const row = inserted[0]
  await addEvidence(orgId, p.huntId, 'schedule_created', { scheduleId: row!.id, proposalId: p.id, kql, intervalMinutes: interval, approvalExpiresAt: row!.approvalExpiresAt.toISOString(), mode: context.mode }, { type: 'user', id: actor.userId })
  await recordDecision({ orgId, actorType: 'user', actorKey: actor.userId, action: 'schedule_kql', input: { proposalId: p.id, intervalMinutes: interval }, output: { scheduleId: row!.id }, huntId: p.huntId })
  return row!
}

async function requireSchedule(orgId: string, id: string) {
  const [s] = await getDb().select().from(huntSchedules).where(and(eq(huntSchedules.orgId, orgId), eq(huntSchedules.id, id))).limit(1)
  if (!s) throw new NotFoundError('Schedule not found.')
  return s
}

export async function disableSchedule(orgId: string, actor: Actor, id: string, reason = 'disabled by user') {
  assertApprover(actor)
  const s = await requireSchedule(orgId, id)
  await getDb().update(huntSchedules).set({ enabled: false, disabledReason: reason }).where(eq(huntSchedules.id, id))
  await addEvidence(orgId, s.huntId, 'schedule_disabled', { scheduleId: id, reason }, { type: 'user', id: actor.userId })
}

/** Re-approve: a human confirms the frozen query again, which re-enables it with a fresh expiry. */
export async function reapproveSchedule(orgId: string, actor: Actor, id: string, approvalDays?: number) {
  assertApprover(actor)
  const s = await requireSchedule(orgId, id)
  assertSafeKql(s.kql)
  const [source] = s.sourceProposalId ? await getDb().select().from(kqlProposals).where(and(eq(kqlProposals.orgId, orgId), eq(kqlProposals.id, s.sourceProposalId))).limit(1) : []
  assertPolicyAllows(actor, source ?? null)
  // The schedule's own approval mode, falling back to how the source search ran for older rows.
  const context = await contextToApprove(orgId, s.approvedContext?.mode ?? (source?.resultSummary as { mode?: 'live' | 'demo' } | null)?.mode)
  await assertNoOtherEnabled(orgId, s.sourceProposalId, id)
  const now = new Date()
  await getDb()
    .update(huntSchedules)
    .set({ enabled: true, disabledReason: null, approvedBy: actor.userId, approvedAt: now, approvalExpiresAt: approvalExpiry(approvalDays, now), nextRunAt: new Date(now.getTime() + s.intervalMinutes * 60_000), approvedContext: context })
    .where(eq(huntSchedules.id, id))
    .catch((err: unknown) => {
      if (isDuplicateEnabled(err)) throw new StateError(DUPLICATE_MESSAGE)
      throw err
    })
  await addEvidence(orgId, s.huntId, 'schedule_created', { scheduleId: id, reapproved: true, kql: s.kql, intervalMinutes: s.intervalMinutes, mode: context.mode }, { type: 'user', id: actor.userId })
  await recordDecision({ orgId, actorType: 'user', actorKey: actor.userId, action: 'reapprove_schedule', input: { scheduleId: id }, huntId: s.huntId })
}

export async function listSchedules(orgId: string, huntId: string) {
  return getDb().select().from(huntSchedules).where(and(eq(huntSchedules.orgId, orgId), eq(huntSchedules.huntId, huntId))).orderBy(asc(huntSchedules.createdAt))
}

/** Disable every enabled schedule whose human approval has lapsed. */
export async function expireScheduleApprovals(now = new Date()) {
  const rows = await getDb()
    .update(huntSchedules)
    .set({ enabled: false, disabledReason: 'approval expired; re-approve to resume' })
    .where(and(eq(huntSchedules.enabled, true), lte(huntSchedules.approvalExpiresAt, now)))
    .returning({ id: huntSchedules.id, orgId: huntSchedules.orgId, huntId: huntSchedules.huntId })
  for (const r of rows) await addEvidence(r.orgId, r.huntId, 'schedule_disabled', { scheduleId: r.id, reason: 'approval expired' }, { type: 'system', id: null })
  return rows.length
}

/**
 * Worker entry point. Claims each due schedule atomically by moving next_run_at forward (a lease) in
 * the same UPDATE that selects it with FOR UPDATE SKIP LOCKED, so two worker replicas or overlapping
 * ticks never run the same schedule twice. Each claim uses a fresh clock so a long loop never hands
 * out leases that are already in the past. `nowFn` exists for tests.
 */
export async function runDueSchedules(nowFn: () => Date = () => new Date(), limit = 20) {
  if (!env().SCHEDULED_HUNTS_ENABLED) return { ran: 0, expired: 0 }
  const expired = await expireScheduleApprovals(nowFn())
  let ran = 0
  for (let i = 0; i < limit; i++) {
    const now = nowFn()
    // Column-typed comparisons (eq/lte/gt) so Date params are serialised by Drizzle on every driver;
    // bare Date params inside raw sql break postgres-js. Closed hunts never run.
    const due = and(
      eq(huntSchedules.enabled, true),
      lte(huntSchedules.nextRunAt, now),
      gt(huntSchedules.approvalExpiresAt, now),
      sql`exists (select 1 from ${huntCases} where ${huntCases.id} = ${huntSchedules.huntId} and ${huntCases.status} = 'open')`,
    )
    const [claimed] = await getDb()
      .update(huntSchedules)
      .set({ nextRunAt: new Date(now.getTime() + CLAIM_LEASE_MS), lastStatus: 'running' })
      .where(sql`${huntSchedules.id} = (select ${huntSchedules.id} from ${huntSchedules} where ${due} order by ${huntSchedules.nextRunAt} limit 1 for update skip locked)`)
      .returning()
    if (!claimed) break
    await runOne(claimed, now)
    ran++
  }
  return { ran, expired }
}

/**
 * Why a claimed schedule must stop instead of running (#189), or null when it may run. Checked on
 * every run, so a role change, a policy change or a connector change takes effect at the next run.
 */
async function stopReason(s: typeof huntSchedules.$inferSelect): Promise<string | null> {
  const [m] = await getDb()
    .select({ role: orgMemberships.role })
    .from(orgMemberships)
    .where(and(eq(orgMemberships.orgId, s.orgId), eq(orgMemberships.userId, s.approvedBy)))
    .limit(1)
  if (!m || !canApprove(m.role)) return 'the person who approved it is no longer an owner or approver; re-approve to resume'
  const [source] = s.sourceProposalId ? await getDb().select().from(kqlProposals).where(and(eq(kqlProposals.orgId, s.orgId), eq(kqlProposals.id, s.sourceProposalId))).limit(1) : []
  try {
    assertPolicyAllows({ userId: s.approvedBy, role: m.role }, source ?? null)
  } catch {
    return 'the approval policy needs a second person to approve this search; another approver must re-approve it'
  }
  if (!s.approvedContext) return 'the approval is not tied to a tenant (approved before this check); re-approve to resume'
  if (!sameHuntingContext(s.approvedContext, await huntingContext(s.orgId))) return 'the hunting connector changed since approval (tenant, app, workspace or demo mode); re-approve to resume'
  return null
}

/** Turn off every enabled schedule this person approved (#189). Called when their role drops. */
export async function disableSchedulesApprovedBy(orgId: string, userId: string, reason: string) {
  const rows = await getDb()
    .update(huntSchedules)
    .set({ enabled: false, disabledReason: reason })
    .where(and(eq(huntSchedules.orgId, orgId), eq(huntSchedules.approvedBy, userId), eq(huntSchedules.enabled, true)))
    .returning({ id: huntSchedules.id, huntId: huntSchedules.huntId })
  for (const r of rows) await addEvidence(orgId, r.huntId, 'schedule_disabled', { scheduleId: r.id, reason }, { type: 'system', id: null })
  return rows.length
}

async function runOne(s: typeof huntSchedules.$inferSelect, claimedAt: Date) {
  const next = new Date(claimedAt.getTime() + s.intervalMinutes * 60_000)
  const now = claimedAt
  const stop = await stopReason(s)
  if (stop) {
    logger.warn('scheduled hunt stopped', { orgId: s.orgId, scheduleId: s.id, reason: stop })
    await getDb().update(huntSchedules).set({ enabled: false, disabledReason: stop, lastStatus: 'stopped' }).where(eq(huntSchedules.id, s.id))
    await addEvidence(s.orgId, s.huntId, 'schedule_disabled', { scheduleId: s.id, reason: stop }, { type: 'system', id: null })
    return
  }
  const kql = s.kql
  // Only the search itself is in the try (#206): once it has run, a failed audit write must not
  // record the run as failed.
  let result: QueryResult
  try {
    assertSafeKql(kql)
    const client = huntingClient()
    result = s.target === 'defender' ? await client.runAdvancedHunting({ orgId: s.orgId, kql }) : await client.runSentinelKql({ orgId: s.orgId, kql })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error('scheduled hunt failed', { orgId: s.orgId, scheduleId: s.id, error: message })
    await getDb().update(huntSchedules).set({ lastRunAt: now, nextRunAt: next, lastStatus: 'failed', lastError: message.slice(0, 1000) }).where(eq(huntSchedules.id, s.id))
    await addEvidence(s.orgId, s.huntId, 'scheduled_failed', { scheduleId: s.id, error: message }, { type: 'system', id: null })
    return
  }
  const summary = { mode: result.mode, rowCount: result.rowCount, truncated: result.truncated, columns: result.columns, sample: result.rows.slice(0, 20), durationMs: result.durationMs }
  await getDb().update(huntSchedules).set({ lastRunAt: now, nextRunAt: next, lastStatus: 'run', lastRowCount: result.rowCount, lastError: null }).where(eq(huntSchedules.id, s.id))
  await recordRunAudit('scheduled hunt audit write failed', { orgId: s.orgId, scheduleId: s.id }, async () => {
    await addEvidence(s.orgId, s.huntId, 'scheduled_result', { scheduleId: s.id, kql, approvedBy: s.approvedBy, previousRowCount: s.lastRowCount, ...summary }, { type: 'system', id: null })
    await recordDecision({ orgId: s.orgId, actorType: 'system', actorKey: 'scheduler', action: 'scheduled_kql', input: { scheduleId: s.id }, output: { rowCount: result.rowCount, mode: result.mode }, huntId: s.huntId })
  })
  if (result.rowCount > 0 && result.rowCount !== s.lastRowCount) {
    await recordRunAudit('scheduled hunt notification failed', { orgId: s.orgId, scheduleId: s.id }, async () => {
      await notify(s.orgId, 'scheduled_hunt', {
        title: `Scheduled hunt returned ${result.rowCount} row${result.rowCount === 1 ? '' : 's'}${s.lastRowCount === null ? '' : ` (was ${s.lastRowCount})`}`,
        lines: [`${s.target} · every ${s.intervalMinutes} min${result.mode === 'demo' ? ' · demo data' : ''}`],
        link: `/app/hunts/${s.huntId}`,
      })
    })
  }
}
