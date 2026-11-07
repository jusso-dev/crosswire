import { and, asc, eq, lte, sql } from 'drizzle-orm'
import { getDb } from '../db/client'
import { huntSchedules, kqlProposals } from '../db/schema'
import { env } from '../env'
import { recordDecision } from '../agents/decisions'
import { logger } from '../lib/logger'
import { notify } from '../notify/notify'
import { canApprove } from '../response/rbac'
import type { OrgRole } from '../orgs'
import { assertSafeKql } from './safety'
import { huntingClient } from './client'
import { addEvidence, NotFoundError, StateError } from './hunts'

/**
 * Scheduled hunts (#92). A schedule is a frozen copy of KQL that a human already approved and ran.
 * Only owners/approvers create, re-approve or disable schedules; there is no agent tool. Approval
 * lasts at most 30 days, after which the schedule disables itself until a human re-approves it.
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
  const now = new Date()
  const [row] = await getDb()
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
    })
    .returning()
  await addEvidence(orgId, p.huntId, 'schedule_created', { scheduleId: row!.id, proposalId: p.id, kql, intervalMinutes: interval, approvalExpiresAt: row!.approvalExpiresAt.toISOString() }, { type: 'user', id: actor.userId })
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
  const now = new Date()
  await getDb()
    .update(huntSchedules)
    .set({ enabled: true, disabledReason: null, approvedBy: actor.userId, approvedAt: now, approvalExpiresAt: approvalExpiry(approvalDays, now), nextRunAt: new Date(now.getTime() + s.intervalMinutes * 60_000) })
    .where(eq(huntSchedules.id, id))
  await addEvidence(orgId, s.huntId, 'schedule_created', { scheduleId: id, reapproved: true, kql: s.kql, intervalMinutes: s.intervalMinutes }, { type: 'user', id: actor.userId })
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
 * Worker entry point. Claims each due schedule atomically by moving next_run_at forward in the same
 * UPDATE that selects it, so two worker replicas never run the same schedule twice.
 */
export async function runDueSchedules(now = new Date(), limit = 20) {
  if (!env().SCHEDULED_HUNTS_ENABLED) return { ran: 0, expired: 0 }
  const expired = await expireScheduleApprovals(now)
  let ran = 0
  for (let i = 0; i < limit; i++) {
    const [claimed] = await getDb()
      .update(huntSchedules)
      // Lease: if this process dies mid-run, the schedule becomes due again after CLAIM_LEASE_MS.
      .set({ nextRunAt: new Date(now.getTime() + CLAIM_LEASE_MS), lastStatus: 'running' })
      .where(
        sql`${huntSchedules.id} = (
          select ${huntSchedules.id} from ${huntSchedules}
          where ${huntSchedules.enabled} = true and ${huntSchedules.nextRunAt} <= ${now} and ${huntSchedules.approvalExpiresAt} > ${now}
          order by ${huntSchedules.nextRunAt} limit 1 for update skip locked
        )`,
      )
      .returning()
    if (!claimed) break
    await runOne(claimed, now)
    ran++
  }
  return { ran, expired }
}

async function runOne(s: typeof huntSchedules.$inferSelect, now: Date) {
  const next = new Date(now.getTime() + s.intervalMinutes * 60_000)
  try {
    const kql = assertSafeKql(s.kql)
    const client = huntingClient()
    const result = s.target === 'defender' ? await client.runAdvancedHunting({ orgId: s.orgId, kql }) : await client.runSentinelKql({ orgId: s.orgId, kql })
    const summary = { mode: result.mode, rowCount: result.rowCount, truncated: result.truncated, columns: result.columns, sample: result.rows.slice(0, 20), durationMs: result.durationMs }
    await getDb().update(huntSchedules).set({ lastRunAt: now, nextRunAt: next, lastStatus: 'run', lastRowCount: result.rowCount, lastError: null }).where(eq(huntSchedules.id, s.id))
    await addEvidence(s.orgId, s.huntId, 'scheduled_result', { scheduleId: s.id, kql, approvedBy: s.approvedBy, previousRowCount: s.lastRowCount, ...summary }, { type: 'system', id: null })
    await recordDecision({ orgId: s.orgId, actorType: 'system', actorKey: 'scheduler', action: 'scheduled_kql', input: { scheduleId: s.id }, output: { rowCount: result.rowCount, mode: result.mode }, huntId: s.huntId })
    if (result.rowCount > 0 && result.rowCount !== s.lastRowCount) {
      await notify(s.orgId, 'scheduled_hunt', {
        title: `Scheduled hunt returned ${result.rowCount} row${result.rowCount === 1 ? '' : 's'}${s.lastRowCount === null ? '' : ` (was ${s.lastRowCount})`}`,
        lines: [`${s.target} · every ${s.intervalMinutes} min${result.mode === 'demo' ? ' · demo data' : ''}`],
        link: `/app/hunts/${s.huntId}`,
      })
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error('scheduled hunt failed', { orgId: s.orgId, scheduleId: s.id, error: message })
    await getDb().update(huntSchedules).set({ lastRunAt: now, nextRunAt: next, lastStatus: 'failed', lastError: message.slice(0, 1000) }).where(eq(huntSchedules.id, s.id))
    await addEvidence(s.orgId, s.huntId, 'scheduled_failed', { scheduleId: s.id, error: message }, { type: 'system', id: null })
  }
}
