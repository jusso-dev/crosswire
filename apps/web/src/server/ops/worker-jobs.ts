/**
 * Scheduling helpers for the background worker (#197). Slow jobs (scheduled searches, the daily
 * digest, the retention purge) run outside the one-minute tick, so the tick, and with it the
 * `/healthz` heartbeat, never waits on a Microsoft query or an SMTP server.
 */

/** A job that is skipped while its previous run is still going. */
export function singleFlight<T>(fn: () => Promise<T>) {
  let running: Promise<T> | null = null
  return {
    isRunning: () => running !== null,
    /** Start a run, or return null when one is already running. */
    start(): Promise<T> | null {
      if (running) return null
      const p = Promise.resolve()
        .then(fn)
        .finally(() => {
          running = null
        })
      running = p
      return p
    },
  }
}

/**
 * A once-per-local-day job. Due at or after `offsetMs` past local midnight; the day is marked done
 * only when `run` returns true, and a failed day is tried again no sooner than `retryMs` later.
 * Never two runs at once.
 */
export function dailyJob(opts: { offsetMs: number; retryMs: number; run: (day: string, now: Date) => Promise<boolean> }) {
  let doneDay = ''
  let lastAttempt = Number.NEGATIVE_INFINITY
  let running = false
  return {
    isRunning: () => running,
    doneDay: () => doneDay,
    /** Start the job for `day` when it is due, or return null. `dayStart` is local midnight of `day`. */
    maybeStart(now: Date, day: string, dayStart: Date): Promise<boolean> | null {
      const t = now.getTime()
      if (running || day === doneDay || t - dayStart.getTime() < opts.offsetMs || t - lastAttempt < opts.retryMs) return null
      lastAttempt = t
      running = true
      return Promise.resolve()
        .then(() => opts.run(day, now))
        .catch(() => false)
        .then((ok) => {
          if (ok) doneDay = day
          return ok
        })
        .finally(() => {
          running = false
        })
    },
  }
}
