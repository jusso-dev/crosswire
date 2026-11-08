import { and, eq, gt, inArray, isNotNull, isNull, lt, ne, or, sql, type SQL } from 'drizzle-orm'
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core'
import { getDb } from '../db/client'
import { agentDecisions, agentRunOutputs, auditEvents, chatMessages, chatThreads, huntEvidence, kqlProposals } from '../db/schema'
import { env } from '../env'
import { canonicalJson, sha256 } from '../agents/canonical'
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
  /** agent_run_outputs bodies whose sample arrays were cleared. The rest of the replay stays. */
  runOutputSamples: number
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

const zeroCounts = (): RetentionCounts => ({ chatThreads: 0, chatMessages: 0, agentDecisions: 0, kqlSamples: 0, evidenceSamples: 0, decisionSamples: 0, runOutputSamples: 0, auditEvents: 0 })

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
 *   agent_run_outputs keeps the replay, but sample arrays older than the cutoff are emptied and marked
 *   sampleExpired. Secrets are already redacted at write time. The content hash is recomputed.
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

/** Replace live `sample` arrays and mark the object expired. Other fields stay. */
function expireSamples(value: unknown, days: number): { value: unknown; changed: boolean } {
  if (Array.isArray(value)) {
    let changed = false
    const next = value.map((item) => {
      const child = expireSamples(item, days)
      if (child.changed) changed = true
      return child.value
    })
    return changed ? { value: next, changed: true } : { value, changed: false }
  }
  if (!value || typeof value !== 'object' || value instanceof Date) return { value, changed: false }
  const record = value as Record<string, unknown>
  let changed = false
  let expiredHere = false
  const out: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(record)) {
    if (key === 'sample' && Array.isArray(child) && record.sampleExpired !== true) {
      out.sample = []
      expiredHere = true
      changed = true
      continue
    }
    const walked = expireSamples(child, days)
    out[key] = walked.value
    if (walked.changed) changed = true
  }
  if (expiredHere) {
    out.sampleExpired = true
    out.sampleRetentionDays = days
  }
  return changed ? { value: out, changed: true } : { value, changed: false }
}

function expireSampleBody(body: string, days: number) {
  if (body[0] !== '{' && body[0] !== '[') return null
  try {
    const next = expireSamples(JSON.parse(body), days)
    return next.changed ? canonicalJson(next.value) : null
  } catch {
    return null
  }
}

/** One pass over outputs older than the cutoff. A second run finds sampleExpired and changes nothing. */
async function expireRunOutputSamples(cutoff: Date, days: number, batch: number) {
  const db = getDb()
  let total = 0
  let cursor: string | null = null
  for (;;) {
    const where: SQL = cursor ? and(lt(agentRunOutputs.createdAt, cutoff), gt(agentRunOutputs.id, cursor))! : lt(agentRunOutputs.createdAt, cutoff)
    const rows = await db.select({ id: agentRunOutputs.id, body: agentRunOutputs.body }).from(agentRunOutputs).where(where).orderBy(agentRunOutputs.id).limit(batch)
    if (rows.length === 0) return total
    for (const row of rows) {
      const body = expireSampleBody(row.body, days)
      if (!body) continue
      await db.update(agentRunOutputs).set({ body, contentSha256: sha256(body) }).where(eq(agentRunOutputs.id, row.id))
      total += 1
    }
    cursor = rows.at(-1)!.id
    if (rows.length < batch) return total
  }
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
    counts.runOutputSamples = await expireRunOutputSamples(samplesCutoff, days, batch)
  }

  const auditCutoff = cutoffFor(now, e.RETENTION_AUDIT_DAYS)
  if (auditCutoff) counts.auditEvents = await deleteInBatches(auditEvents, lt(auditEvents.createdAt, auditCutoff), batch)
}
