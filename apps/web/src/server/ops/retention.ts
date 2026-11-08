import { and, eq, inArray, isNotNull, isNull, lt, ne, or, sql, type SQL } from 'drizzle-orm'
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
  /** tool:get_hunt decision rows whose stored output (logged before withoutSamples) was replaced. */
  decisionSamples: number
  auditEvents: number
}

/** Stored in place of a historical tool:get_hunt output once its samples pass the cutoff. */
export const DECISION_SAMPLES_REMOVED = '[result rows removed by retention]'

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

/**
 * Delete idle chat threads in batches and count the messages each batch takes with it (the
 * cascade does not report them). One statement per batch: the count reads the same snapshot the
 * delete runs on, so it is exactly the messages of the threads removed.
 */
async function deleteThreadsInBatches(cutoff: Date, batch: number) {
  const db = getDb()
  let threads = 0
  let messages = 0
  for (;;) {
    const res = (await db.execute(sql`
      with doomed as (select ${chatThreads.id} as id from ${chatThreads} where ${chatThreads.updatedAt} < ${cutoff.toISOString()}::timestamptz limit ${batch}),
      gone as (delete from ${chatThreads} where ${chatThreads.id} in (select id from doomed) returning ${chatThreads.id} as id)
      select (select count(*) from gone)::int as threads,
             (select count(*) from ${chatMessages} where ${chatMessages.threadId} in (select id from gone))::int as messages
    `)) as unknown as CountRow[] | { rows: CountRow[] }
    const row = Array.isArray(res) ? res[0] : res.rows[0]
    const n = Number(row?.threads ?? 0)
    threads += n
    messages += Number(row?.messages ?? 0)
    if (n < batch) return { threads, messages }
  }
}
type CountRow = { threads: number | string; messages: number | string }

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

const zeroCounts = (): RetentionCounts => ({ chatThreads: 0, chatMessages: 0, agentDecisions: 0, kqlSamples: 0, evidenceSamples: 0, decisionSamples: 0, auditEvents: 0 })

/**
 * Data retention purge (design doc gaps). Global maintenance job: runs across every org, which is
 * why nothing here is org-scoped. Each RETENTION_* setting of 0 keeps that category forever.
 * - chat: threads idle past the cutoff (messages and feedback cascade), then old messages in
 *   threads that are still active (their feedback cascades).
 * - decisions: agent_decisions rows past the cutoff.
 * - samples: stored result rows in kql_proposals.result_summary and kql_result / scheduled_result
 *   evidence are replaced by an empty sample with sampleExpired: true. Row counts are kept.
 *   tool:get_hunt decision rows logged before withoutSamples existed may hold result rows, so their
 *   output_summary is replaced with DECISION_SAMPLES_REMOVED.
 * - audit: audit_events past the cutoff. The retention_purge event itself is written afterwards.
 *
 * If a stage fails, the retention_purge event is still written with the counts so far and
 * partial: true, then the error is rethrown. Every stage is idempotent, so the next run resumes.
 */
export async function runRetention(now = new Date(), opts: { batch?: number } = {}): Promise<RetentionCounts> {
  const e = env()
  const batch = Math.max(1, opts.batch ?? RETENTION_BATCH)
  const counts = zeroCounts()
  const settings = { chatDays: e.RETENTION_CHAT_DAYS, decisionsDays: e.RETENTION_DECISIONS_DAYS, samplesDays: e.RETENTION_SAMPLES_DAYS, auditDays: e.RETENTION_AUDIT_DAYS }
  try {
    await purge(now, batch, counts)
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    try {
      await writeAudit({ category: 'system', action: 'retention_purge', result: 'failure', actorType: 'system', data: { ...counts, settings, partial: true, error } })
    } catch (auditErr) {
      logger.error('retention purge audit write failed', { error: auditErr instanceof Error ? auditErr.message : String(auditErr) })
    }
    logger.error('retention purge stopped part way', { ...counts, error })
    throw err
  }
  await writeAudit({ category: 'system', action: 'retention_purge', actorType: 'system', data: { ...counts, settings } })
  logger.info('retention purge complete', { ...counts })
  return counts
}

/** The purge stages, in order. Writes into `counts` as each stage finishes, so a failure keeps the progress so far. */
async function purge(now: Date, batch: number, counts: RetentionCounts) {
  const e = env()
  const chatCutoff = cutoffFor(now, e.RETENTION_CHAT_DAYS)
  if (chatCutoff) {
    // Smaller batches for threads: each one cascades to all of its messages and feedback.
    const t = await deleteThreadsInBatches(chatCutoff, Math.max(1, Math.floor(batch / 10)))
    counts.chatThreads = t.threads
    counts.chatMessages = t.messages
    counts.chatMessages += await deleteInBatches(chatMessages, lt(chatMessages.createdAt, chatCutoff), batch)
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
    // Already-replaced rows are skipped, so a re-run touches nothing.
    const decWhere = and(eq(agentDecisions.action, 'tool:get_hunt'), lt(agentDecisions.createdAt, samplesCutoff), ne(agentDecisions.outputSummary, DECISION_SAMPLES_REMOVED))!
    counts.decisionSamples = await updateInBatches(agentDecisions, decWhere, { outputSummary: sql`${DECISION_SAMPLES_REMOVED}` }, batch)
  }

  const auditCutoff = cutoffFor(now, e.RETENTION_AUDIT_DAYS)
  if (auditCutoff) counts.auditEvents = await deleteInBatches(auditEvents, lt(auditEvents.createdAt, auditCutoff), batch)
}
