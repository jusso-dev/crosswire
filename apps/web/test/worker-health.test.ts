import { afterEach, describe, expect, it } from 'vitest'
import { createWorkerHealth, workerHealthPort } from '../src/server/ops/worker-health'

/** Worker health contract (#142): the Bicep probes and the Compose healthcheck depend on exactly this. */
describe('worker health server', () => {
  let close: (() => Promise<void>) | undefined
  afterEach(async () => {
    await close?.()
    close = undefined
  })

  async function start(now: () => number) {
    const h = createWorkerHealth({ now })
    const port = await h.listen(0, '127.0.0.1')
    close = h.close
    return { h, url: (p: string) => `http://127.0.0.1:${port}${p}` }
  }

  it('is 503 before the first tick, 200 after one, and 503 again once 3 minutes pass with no tick', async () => {
    let t = Date.parse('2026-11-11T00:00:00Z')
    const { h, url } = await start(() => t)
    let res = await fetch(url('/healthz'))
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ status: 'stale', lastTickAt: null })

    h.markTick()
    res = await fetch(url('/healthz'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok', lastTickAt: '2026-11-11T00:00:00.000Z' })
    expect(res.headers.get('cache-control')).toBe('no-store')

    t += 3 * 60_000 - 1
    expect((await fetch(url('/healthz'))).status).toBe(200)
    t += 1
    expect((await fetch(url('/healthz'))).status).toBe(503)
  })

  it('answers 404 to any other path or method and exposes nothing else', async () => {
    const { h, url } = await start(Date.now)
    h.markTick()
    expect((await fetch(url('/'))).status).toBe(404)
    expect((await fetch(url('/readyz'))).status).toBe(404)
    expect((await fetch(url('/healthz'), { method: 'POST' })).status).toBe(404)
    expect((await fetch(url('/healthz?x=1'))).status).toBe(200)
    expect(Object.keys(await (await fetch(url('/healthz'))).json()).sort()).toEqual(['lastTickAt', 'status'])
  })

  it('reads WORKER_HEALTH_PORT, defaulting to 3001', () => {
    expect(workerHealthPort(undefined)).toBe(3001)
    expect(workerHealthPort('')).toBe(3001)
    expect(workerHealthPort('8081')).toBe(8081)
    expect(workerHealthPort('nope')).toBe(3001)
    expect(workerHealthPort('70000')).toBe(3001)
  })

  it('close is safe when the server never started', async () => {
    await createWorkerHealth().close()
  })
})
