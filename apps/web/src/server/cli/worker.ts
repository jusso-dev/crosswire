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
let lastDigestDay = ''
let lastRetentionDay = ''
let retentionRunning = false
let stopping = false

async function safe(name: string, fn: () => Promise<unknown>) {
  try {
    const result = await fn()
    logger.info(`job ${name} ok`, { result: result as Record<string, unknown> })
  } catch (err) {
    logger.error(`job ${name} failed`, { error: err instanceof Error ? err.message : String(err) })
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
  if (!retentionRunning && day !== lastRetentionDay && now.getTime() - dayBounds(day).start.getTime() >= 30 * 60_000) {
    lastRetentionDay = day
    retentionRunning = true
    void safe('retention', () => runRetention(now)).finally(() => {
      retentionRunning = false
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
    await closeDb()
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

void main()
