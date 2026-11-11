import { describe, expect, it } from 'vitest'
import { dailyJob, singleFlight } from '../src/server/ops/worker-jobs'

/** Worker scheduling (#197): slow jobs run outside the tick, never twice at once, and a failed day is retried. */
function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('singleFlight', () => {
  it('skips a start while the previous run is going, then allows the next one', async () => {
    let calls = 0
    let gate = deferred<void>()
    const job = singleFlight(async () => {
      calls++
      await gate.promise
      return calls
    })
    const first = job.start()
    expect(first).not.toBeNull()
    expect(job.start()).toBeNull()
    expect(job.isRunning()).toBe(true)
    gate.resolve()
    expect(await first).toBe(1)
    expect(job.isRunning()).toBe(false)
    gate = deferred<void>()
    const second = job.start()
    gate.resolve()
    expect(await second).toBe(2)
  })

  it('a failed run frees the guard', async () => {
    const job = singleFlight(async () => {
      throw new Error('boom')
    })
    await expect(job.start()).rejects.toThrow('boom')
    expect(job.isRunning()).toBe(false)
  })
})

describe('dailyJob', () => {
  const midnight = new Date('2026-11-11T00:00:00Z')
  const at = (min: number) => new Date(midnight.getTime() + min * 60_000)
  const DAY = '2026-11-11'

  it('waits for the offset, runs once a day, and is not started twice while running', async () => {
    const gate = deferred<boolean>()
    const days: string[] = []
    const job = dailyJob({
      offsetMs: 5 * 60_000,
      retryMs: 15 * 60_000,
      run: (day) => {
        days.push(day)
        return gate.promise
      },
    })
    expect(job.maybeStart(at(4), DAY, midnight)).toBeNull()
    const run = job.maybeStart(at(5), DAY, midnight)
    expect(run).not.toBeNull()
    expect(job.maybeStart(at(30), DAY, midnight)).toBeNull()
    gate.resolve(true)
    expect(await run).toBe(true)
    expect(job.doneDay()).toBe(DAY)
    expect(job.maybeStart(at(60), DAY, midnight)).toBeNull()
    expect(days).toEqual([DAY])
  })

  it('does not mark a failed day done, and retries no sooner than retryMs', async () => {
    let ok = false
    let runs = 0
    const job = dailyJob({
      offsetMs: 5 * 60_000,
      retryMs: 15 * 60_000,
      run: async () => {
        runs++
        return ok
      },
    })
    expect(await job.maybeStart(at(5), DAY, midnight)).toBe(false)
    expect(job.doneDay()).toBe('')
    expect(job.maybeStart(at(19), DAY, midnight)).toBeNull()
    ok = true
    expect(await job.maybeStart(at(20), DAY, midnight)).toBe(true)
    expect(job.doneDay()).toBe(DAY)
    expect(runs).toBe(2)
  })

  it('treats a thrown run as a failure and stays retryable', async () => {
    const job = dailyJob({
      offsetMs: 0,
      retryMs: 60_000,
      run: async () => {
        throw new Error('smtp down')
      },
    })
    expect(await job.maybeStart(at(1), DAY, midnight)).toBe(false)
    expect(job.isRunning()).toBe(false)
    expect(job.doneDay()).toBe('')
    expect(job.maybeStart(at(2), DAY, midnight)).not.toBeNull()
  })
})
