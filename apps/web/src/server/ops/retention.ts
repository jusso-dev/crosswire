import { and, inArray, isNotNull, isNull, lt, or, sql, type SQL } from 'drizzle-orm'
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core'
import { getDb } from '../db/client'
import { agentDecisions, auditEvents, chatMessages, chatThreads, huntEvidence, kqlProposals } from '../db/schema'
import { env } from '../env'
import { writeAudit } from '../audit'
import { logger } from '../lib/logger'

/** Rows touched per statement. Each batch is its own short statement, so no long-held locks. */
export const RETENTION_BATCH = 5000
const DAY_MS = 86_400_000

export interface RetentionCounts {
  chatThreads: number
  chatMessages: number
  agentDecisions: number
  kqlSamples: number
  evidenceSamples: number
  auditEvents: number
}

const cutoffFor = (now: Date, days: number) => (days > 0 ? new Date(now.getTime() - days * DAY_MS) : null)

/**
 * Delete matching rows in batches of `batch` (id IN (SELECT id ... LIMIT n)), looping until a batch
 * comes back short. Cascades (messages, feedback) run inside each batch's statement.
 */
async function deleteInBatches(table: PgTable & { id: PgColumn }, where: SQL, batch: number) {
  const db = getDb()
  let total = 0
  for (;;) {
    const ids = db.select({ id: table.id }).from(table).where(where).limit(batch)
    const rows = await db.delete(table).where(inArray(table.id, ids)).returning({ id: table.id })
    total += rows.length
    if (rows.length < batch) return total
  }
}

/** Update matching rows in batches, the same way deleteInBatches deletes them. */
async function updateInBatches(table: PgTable & { id: PgColumn }, where: SQL, set: Record<string, SQL>, batch: number) {
  const db = getDb()
  let total = 0
  for (;;) {
    const ids = db.select({ id: table.id }).from(table).where(where).limit(batch)
    const rows = await db.update(table).set(set).where(inArray(table.id, ids)).returning({ id: table.id })
    total += rows.length
    if (rows.length < batch) return total
  }
}

/** Replace the stored sample with an empty array, marked expired; counts and columns stay. */
const strippedSample = (column: PgColumn, days: number) =>
  sql`(${column} - 'sample') || jsonb_build_object('sample', '[]'::jsonb, 'sampleExpired', true, 'sampleRetentionDays', ${days}::int)`
/** Has a sample key and has not already been stripped (so a re-run touches nothing). */
const hasLiveSample = (column: PgColumn) => sql`(${column} -> 'sample') is not null and not (${column} @> '{"sampleExpired":true}'::jsonb)`

/**
 * Data retention purge (design doc gaps). Global maintenance job: runs across every org, which is
 * why nothing here is org-scoped. Each RETENTION_* setting of 0 keeps that category forever.
 * - chat: threads idle past the cutoff (messages and feedback cascade), then old messages in
 *   threads that are still active (their feedback cascades).
 * - decisions: agent_decisions rows past the cutoff.
 * - samples: stored result rows in kql_proposals.result_summary and kql_result / scheduled_result
 *   evidence are replaced by an empty sample with sampleExpired: true. Row counts are kept.
 * - audit: audit_events past the cutoff. The retention_purge event itself is written afterwards.
 */
export async function runRetention(now = new Date(), opts: { batch?: number } = {}): Promise<RetentionCounts> {
  const e = env()
  const batch = Math.max(1, opts.batch ?? RETENTION_BATCH)
  const counts: RetentionCounts = { chatThreads: 0, chatMessages: 0, agentDecisions: 0, kqlSamples: 0, evidenceSamples: 0, auditEvents: 0 }

  const chatCutoff = cutoffFor(now, e.RETENTION_CHAT_DAYS)
  if (chatCutoff) {
    // Smaller batches for threads: each one cascades to all of its messages and feedback.
    counts.chatThreads = await deleteInBatches(chatThreads, lt(chatThreads.updatedAt, chatCutoff), Math.max(1, Math.floor(batch / 10)))
    counts.chatMessages = await deleteInBatches(chatMessages, lt(chatMessages.createdAt, chatCutoff), batch)
  }

  const decisionsCutoff = cutoffFor(now, e.RETENTION_DECISIONS_DAYS)
  if (decisionsCutoff) counts.agentDecisions = await deleteInBatches(agentDecisions, lt(agentDecisions.createdAt, decisionsCutoff), batch)

  const samplesCutoff = cutoffFor(now, e.RETENTION_SAMPLES_DAYS)
  if (samplesCutoff) {
    const days = e.RETENTION_SAMPLES_DAYS
    const kqlWhere = and(isNotNull(kqlProposals.resultSummary), or(lt(kqlProposals.ranAt, samplesCutoff), and(isNull(kqlProposals.ranAt), lt(kqlProposals.createdAt, samplesCutoff))), hasLiveSample(kqlProposals.resultSummary))!
    counts.kqlSamples = await updateInBatches(kqlProposals, kqlWhere, { resultSummary: strippedSample(kqlProposals.resultSummary, days) }, batch)
    const evWhere = and(inArray(huntEvidence.type, ['kql_result', 'scheduled_result']), lt(huntEvidence.createdAt, samplesCutoff), hasLiveSample(huntEvidence.payload))!
    counts.evidenceSamples = await updateInBatches(huntEvidence, evWhere, { payload: strippedSample(huntEvidence.payload, days) }, batch)
  }

  const auditCutoff = cutoffFor(now, e.RETENTION_AUDIT_DAYS)
  if (auditCutoff) counts.auditEvents = await deleteInBatches(auditEvents, lt(auditEvents.createdAt, auditCutoff), batch)

  const settings = { chatDays: e.RETENTION_CHAT_DAYS, decisionsDays: e.RETENTION_DECISIONS_DAYS, samplesDays: e.RETENTION_SAMPLES_DAYS, auditDays: e.RETENTION_AUDIT_DAYS }
  await writeAudit({ category: 'system', action: 'retention_purge', actorType: 'system', data: { ...counts, settings } })
  logger.info('retention purge complete', { ...counts })
  return counts
}
