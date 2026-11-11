import { createServer, type Server } from 'node:http'

/**
 * Worker liveness (#142). The worker records when each tick finishes; `GET /healthz` answers 200
 * while the last tick finished less than `staleAfterMs` ago and 503 otherwise (including before the
 * first tick). Anything else is 404. No auth and no other data: the probe only needs a status code.
 * The Bicep probes and the Compose healthcheck depend on exactly this contract.
 */
export const WORKER_HEALTH_STALE_MS = 3 * 60_000
export const DEFAULT_WORKER_HEALTH_PORT = 3001

export function createWorkerHealth(opts: { staleAfterMs?: number; now?: () => number } = {}) {
  const staleAfterMs = opts.staleAfterMs ?? WORKER_HEALTH_STALE_MS
  const now = opts.now ?? Date.now
  let lastTickAt: number | null = null

  function status() {
    const healthy = lastTickAt !== null && now() - lastTickAt < staleAfterMs
    return { healthy, lastTickAt: lastTickAt === null ? null : new Date(lastTickAt).toISOString() }
  }

  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0]
    if (req.method !== 'GET' || path !== '/healthz') {
      res.writeHead(404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify({ status: 'not_found' }))
      return
    }
    const s = status()
    res
      .writeHead(s.healthy ? 200 : 503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      .end(JSON.stringify({ status: s.healthy ? 'ok' : 'stale', lastTickAt: s.lastTickAt }))
  })

  return {
    server,
    status,
    /** Call when a tick has finished (whether or not each job in it succeeded). */
    markTick(at = now()) {
      lastTickAt = at
    },
    listen(port: number, host = '0.0.0.0') {
      return new Promise<number>((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, host, () => {
          server.off('error', reject)
          const addr = server.address()
          resolve(typeof addr === 'object' && addr ? addr.port : port)
        })
      })
    },
    close() {
      return new Promise<void>((resolve) => {
        if (!server.listening) return resolve()
        server.close(() => resolve())
        server.closeAllConnections?.()
      })
    },
  }
}

/** Port from WORKER_HEALTH_PORT (default 3001). An invalid value falls back to the default. */
export function workerHealthPort(raw = process.env.WORKER_HEALTH_PORT) {
  const n = Number(raw)
  return raw && Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULT_WORKER_HEALTH_PORT
}
