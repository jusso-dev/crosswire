import { createMiddleware, createStart } from '@tanstack/react-start'

/**
 * Request logging + correlation ids (#63). Every request gets an `x-request-id` (reused from the
 * proxy if it is a safe token) echoed on the response, and one structured log line with method,
 * path, status and duration. Query strings, headers and bodies are not logged.
 */
const requestLogger = createMiddleware({ type: 'request' }).server(async ({ request, next }) => {
  const { logger } = await import('./server/lib/logger')
  const sec = await import('./server/lib/http-security')
  const incoming = request.headers.get('x-request-id')
  const requestId = incoming && /^[A-Za-z0-9._-]{8,128}$/.test(incoming) ? incoming : crypto.randomUUID()
  const started = performance.now()
  const url = new URL(request.url)
  const path = url.pathname
  const origin = request.headers.get('origin')
  const cors = sec.corsHeaders(origin)

  // CORS preflight: only allowlisted origins (#74).
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: cors ? 204 : 403, headers: { ...(cors ?? {}), 'x-request-id': requestId } })
  }
  // Rate limit chat per client (#74). Auth uses Better Auth's limiter; TI ingest is CLI/worker only.
  if ((path === '/api/chat' || path === '/api/chat/') && request.method === 'POST') {
    const r = sec.chatRateLimiter().check(sec.clientKey(request))
    if (!r.ok) {
      logger.warn('rate limited', { requestId, path })
      return Response.json({ error: 'rate_limited' }, { status: 429, headers: { 'Retry-After': String(r.retryAfterSec), 'x-request-id': requestId } })
    }
  }
  try {
    const result = await next()
    const status = result.response.status
    const isHttps = url.protocol === 'https:' || request.headers.get('x-forwarded-proto') === 'https'
    try {
      result.response.headers.set('x-request-id', requestId)
      for (const [k, v] of Object.entries(sec.securityHeaders(isHttps))) {
        if (!result.response.headers.has(k)) result.response.headers.set(k, v)
      }
      if (cors) for (const [k, v] of Object.entries(cors)) result.response.headers.set(k, v)
    } catch {
      // Some responses have immutable headers; the log line still carries the id.
    }
    if (path !== '/healthz' && path !== '/readyz') {
      logger.info('request', { requestId, method: request.method, path, status, durationMs: Math.round(performance.now() - started) })
    }
    return result
  } catch (err) {
    logger.error('request failed', { requestId, method: request.method, path, durationMs: Math.round(performance.now() - started), error: err instanceof Error ? err.message : String(err) })
    throw err
  }
})

export const startInstance = createStart(() => ({ requestMiddleware: [requestLogger] }))
