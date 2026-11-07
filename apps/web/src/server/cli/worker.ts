import { fetchAndIngestPwnWatch } from '../ti/pwnwatch'
import { fetchAndIngestKev } from '../ti/kev'
import { runMatcher } from '../ti/matcher'
import { refreshTodayDigests, runDailyDigest, utcDay } from '../ti/digest'
import { expireProposals } from '../response/proposals'
import { expireKqlProposals } from '../hunting/hunts'
import { runDueSchedules } from '../hunting/schedules'
import { logger } from '../lib/logger'
import { closeDb } from '../db/client'

/**
 * Background worker (`pnpm worker`, or the `worker` service in Compose). Plain timers, no external
 * queue: hourly ingest + match (TTL cache keeps upstream polite), expiry and due scheduled hunts
 * every minute, digest once per UTC day after 00:05. Safe to run one replica; jobs are idempotent if two overlap.
 */
const HOUR = 3600_000
let lastDigestDay = ''
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

async function tick() {
  await safe('expire', async () => ({ response: await expireProposals(), kql: await expireKqlProposals() }))
  // Approved scheduled hunts (#92); claims are atomic, so extra replicas are safe.
  await safe('hunts:scheduled', () => runDueSchedules())
  const now = new Date()
  const day = utcDay(now)
  if (day !== lastDigestDay && now.getUTCHours() * 60 + now.getUTCMinutes() >= 5) {
    // Digest the previous full UTC day.
    const prev = utcDay(new Date(now.getTime() - 86_400_000))
    await safe('digest:daily', () => runDailyDigest(prev))
    lastDigestDay = day
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
