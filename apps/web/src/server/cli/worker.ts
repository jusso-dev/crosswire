import { fetchAndIngestPwnWatch } from '../ti/pwnwatch'
import { fetchAndIngestKev } from '../ti/kev'
import { runMatcher } from '../ti/matcher'
import { appDay, dayBounds, refreshTodayDigests, runDailyDigest } from '../ti/digest'
import { expireProposals, failStaleExecutions } from '../response/proposals'
import { expireKqlProposals } from '../hunting/hunts'
import { runDueSchedules } from '../hunting/schedules'
import { runRetention } from '../ops/retention'
import { reconcileStaleRuns } from '../agents/runs'
import { logger } from '../lib/logger'
import { closeDb } from '../db/client'
import { createWorkerHealth, workerHealthPort } from '../ops/worker-health'
import { dailyJob, singleFlight } from '../ops/worker-jobs'

/**
 * Background worker (`pnpm worker`, or the `worker` service in Compose). Plain timers, no external
 * queue: hourly ingest + match (TTL cache keeps upstream polite), expiry and due scheduled hunts
 * every minute, digest once per local day after 00:05, retention purge once per local day after 00:30. Ingest, match and digest jobs are idempotent; scheduled-hunt claims are atomic, so extra replicas are safe.
 * `GET /healthz` on WORKER_HEALTH_PORT (default 3001) reports whether a tick finished in the last 3 minutes.
 * The tick itself only runs the quick database jobs. Scheduled searches, the digest and the purge
 * start from the tick but run outside it (#197), each never twice at once, so a slow query or SMTP
 * server cannot hold the tick past the health window.
 */
const HOUR = 3600_000
/** After a failed digest or purge, wait at least this long before trying again the same day. */
const DAILY_RETRY_MS = 15 * 60_000
/** How long shutdown waits for running jobs. Under the Container Apps 30 s grace period. */
const SHUTDOWN_WAIT_MS = 25_000
let stopping = false
const health = createWorkerHealth()

/** Every job that is running now (tick, ingest cycle, retention), so shutdown can wait for all of them. */
const inFlight = new Set<Promise<unknown>>()
function track<T>(p: Promise<T>): Promise<T> {
  inFlight.add(p)
  void p.finally(() => inFlight.delete(p)).catch(() => {})
  return p
}

/** Start a job unless the worker is stopping. Tracked until it settles. */
function start(fn: () => Promise<unknown>) {
  if (stopping) return
  void track(fn())
}

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

/** Approved scheduled hunts (#92). Claims are atomic, so extra replicas are safe. */
const scheduledHunts = singleFlight(() => safe('hunts:scheduled', () => runDueSchedules()))

/**
 * Five minutes after local midnight (APP_TIMEZONE), digest the previous full local day. The day is
 * marked done only when every org's digest was sent or had nothing to send; otherwise it is retried
 * no sooner than 15 minutes later. Sends already made are not repeated (`emailed_at`).
 */
const dailyDigest = dailyJob({
  offsetMs: 5 * 60_000,
  retryMs: DAILY_RETRY_MS,
  run: async (day) => {
    const prev = appDay(new Date(dayBounds(day).start.getTime() - 1))
    let failed = 0
    const ok = await safe('digest:daily', async () => {
      const r = await runDailyDigest(prev)
      failed = r.failed
      return r
    })
    return ok && failed === 0
  },
})

/**
 * Retention purge once per local day, at or after 00:30 (APP_TIMEZONE). Batched and idempotent, so
 * a second replica running it the same day only finds nothing left to remove. The day is marked
 * done only on success; a failure is retried no sooner than 15 minutes later.
 */
const retention = dailyJob({ offsetMs: 30 * 60_000, retryMs: DAILY_RETRY_MS, run: (_day, now) => safe('retention', () => runRetention(now)) })

let ticking = false
async function tick() {
  // setInterval does not wait: skip a tick while the previous one is still running.
  if (ticking) return
  ticking = true
  try {
    await tickBody()
    health.markTick()
  } finally {
    ticking = false
  }
}

async function tickBody() {
  await safe('runs:reconcile', () => reconcileStaleRuns())
  await safe('expire', async () => ({ response: await expireProposals(), kql: await expireKqlProposals() }))
  // A live execution that never recorded its result becomes failed with "outcome unknown" (#121). Never retried.
  await safe('response:stale-executions', () => failStaleExecutions())
  if (stopping) return
  // Slow jobs run outside the tick (#197): not awaited here, tracked for shutdown, never two at once.
  const scheduled = scheduledHunts.start()
  if (scheduled) track(scheduled)
  const now = new Date()
  const day = appDay(now)
  const dayStart = dayBounds(day).start
  const digest = dailyDigest.maybeStart(now, day, dayStart)
  if (digest) track(digest)
  const purge = retention.maybeStart(now, day, dayStart)
  if (purge) track(purge)
}

let ingestTimer: ReturnType<typeof setInterval> | undefined
let tickTimer: ReturnType<typeof setInterval> | undefined

async function shutdown() {
  if (stopping) return
  stopping = true
  clearInterval(ingestTimer)
  clearInterval(tickTimer)
  logger.info('worker stopping', { running: inFlight.size })
  // Let running jobs (a digest send, a scheduled hunt, a purge batch) finish rather than cutting
  // their database connection part-way. Give up at the deadline; every job resumes on the next run.
  if (inFlight.size) {
    let timer: ReturnType<typeof setTimeout> | undefined
    const finished = await Promise.race([Promise.allSettled([...inFlight]).then(() => true), new Promise<false>((r) => (timer = setTimeout(() => r(false), SHUTDOWN_WAIT_MS)))])
    clearTimeout(timer)
    if (!finished) logger.warn('jobs still running at shutdown; stopping anyway (the next run resumes them)', { running: inFlight.size })
  }
  await health.close()
  await closeDb()
  process.exit(0)
}

async function main() {
  // Registered first, so a SIGTERM during the first ingest still waits for running jobs.
  process.on('SIGTERM', () => void shutdown())
  process.on('SIGINT', () => void shutdown())
  logger.info('worker started')
  const port = workerHealthPort()
  // A health server that cannot bind is logged, not fatal: the jobs matter more than the probe.
  await health.listen(port).then(
    () => logger.info('worker health listening', { port }),
    (err: unknown) => logger.error('worker health server did not start', { port, error: err instanceof Error ? err.message : String(err) }),
  )
  if (stopping) return
  await track(safe('runs:reconcile', () => reconcileStaleRuns()))
  // Tick first: expiry and the stale-execution sweep must not wait on upstream feeds, and the health
  // probe turns ready once a tick has finished.
  if (stopping) return
  await track(tick())
  if (stopping) return
  tickTimer = setInterval(() => start(tick), 60_000)
  await track(ingestCycle())
  if (stopping) return
  ingestTimer = setInterval(() => start(ingestCycle), HOUR)
}

void main()
