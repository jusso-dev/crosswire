import { fetchAndIngestPwnWatch } from '../ti/pwnwatch'
import { fetchAndIngestKev } from '../ti/kev'
import { runMatcher } from '../ti/matcher'
import { appDay, dayBounds, refreshTodayDigests, runDailyDigest } from '../ti/digest'
import { expireProposals } from '../response/proposals'
import { expireKqlProposals } from '../hunting/hunts'
import { runDueSchedules } from '../hunting/schedules'
import { runRetention } from '../ops/retention'
import { logger } from '../lib/logger'
import { closeDb } from '../db/client'

/**
 * Background worker (`pnpm worker`, or the `worker` service in Compose). Plain timers, no external
 * queue: hourly ingest + match (TTL cache keeps upstream polite), expiry and due scheduled hunts
 * every minute, digest once per local day after 00:05, retention purge once per local day after 00:30. Ingest, match and digest jobs are idempotent; scheduled-hunt claims are atomic, so extra replicas are safe.
 */
const HOUR = 3600_000
/** After a failed purge, wait at least this long before trying again the same day. */
const RETENTION_RETRY_MS = 15 * 60_000
/** How long shutdown waits for a running purge. Under the Container Apps 30 s grace period. */
const SHUTDOWN_WAIT_MS = 25_000
let lastDigestDay = ''
let lastRetentionDay = ''
let lastRetentionAttempt = 0
let retention: Promise<void> | null = null
let stopping = false

/** Run a job, logging the outcome. Never throws; returns whether the job succeeded. */
async function safe(name: string, fn: () => Promise<unknown>): Promise<boolean> {
  try {
    const result = await fn()
    logger.info(`job ${name} ok`, { result: result as Record<string, unknown> })
    return true
  } catch (err) {
    logger.error(`job ${name} failed`, { error: err instanceof Error ? err.message : String(err) })
    return false
  }
}

async function ingestCycle() {
  await safe('ingest:pwn', () => fetchAndIngestPwnWatch())
  await safe('ingest:cve', () => fetchAndIngestKev())
  await safe('match:watches', runMatcher)
  // Keep today's in-app digest current; email still goes once for the completed previous day.
  await safe('digest:today', () => refreshTodayDigests())
}

let ticking = false
async function tick() {
  // setInterval does not wait: skip a tick while the previous one is still running.
  if (ticking) return
  ticking = true
  try {
    await tickBody()
  } finally {
    ticking = false
  }
}

async function tickBody() {
  await safe('expire', async () => ({ response: await expireProposals(), kql: await expireKqlProposals() }))
  // Approved scheduled hunts (#92); claims are atomic, so extra replicas are safe.
  await safe('hunts:scheduled', () => runDueSchedules())
  const now = new Date()
  const day = appDay(now)
  // Five minutes after local midnight (APP_TIMEZONE), digest the previous full local day.
  if (day !== lastDigestDay && now.getTime() - dayBounds(day).start.getTime() >= 5 * 60_000) {
    const prev = appDay(new Date(dayBounds(day).start.getTime() - 1))
    await safe('digest:daily', () => runDailyDigest(prev))
    lastDigestDay = day
  }
  // Retention purge once per local day, at or after 00:30 (APP_TIMEZONE). It runs outside the tick
  // (not awaited) so a long first purge never delays expiry or scheduled hunts. Batched and
  // idempotent, so a second replica running it the same day only finds nothing left to remove.
  // The day is marked done only on success; a failure is retried no sooner than 15 minutes later.
  if (
    !stopping &&
    !retention &&
    day !== lastRetentionDay &&
    now.getTime() - dayBounds(day).start.getTime() >= 30 * 60_000 &&
    now.getTime() - lastRetentionAttempt >= RETENTION_RETRY_MS
  ) {
    lastRetentionAttempt = now.getTime()
    retention = safe('retention', () => runRetention(now)).then((ok) => {
      if (ok) lastRetentionDay = day
      retention = null
    })
  }
}

async function main() {
  logger.info('worker started')
  await ingestCycle()
  const ingestTimer = setInterval(() => void ingestCycle(), HOUR)
  const tickTimer = setInterval(() => void tick(), 60_000)
  await tick()
  const shutdown = async () => {
    if (stopping) return
    stopping = true
    clearInterval(ingestTimer)
    clearInterval(tickTimer)
    logger.info('worker stopping')
    // Let a running purge finish its current work rather than cutting its connection mid-batch.
    if (retention) {
      let timer: ReturnType<typeof setTimeout> | undefined
      const finished = await Promise.race([retention.then(() => true), new Promise<false>((r) => (timer = setTimeout(() => r(false), SHUTDOWN_WAIT_MS)))])
      clearTimeout(timer)
      if (!finished) logger.warn('retention purge still running at shutdown; stopping anyway (the next run resumes it)')
    }
    await closeDb()
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

void main()
