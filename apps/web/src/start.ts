import { createCsrfMiddleware, createMiddleware, createStart } from '@tanstack/react-start'

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
  // Rate limit chat per client (#74), shared across replicas through the database. Auth uses
  // Better Auth's limiter; TI ingest is CLI/worker only.
  if ((path === '/api/chat' || path === '/api/chat/') && request.method === 'POST') {
    const r = await sec.chatRateLimiter().check(sec.clientKey(request))
    if (!r.ok) {
      logger.warn('rate limited', { requestId, path })
      return Response.json({ error: 'rate_limited' }, { status: 429, headers: { 'Retry-After': String(r.retryAfterSec), 'x-request-id': requestId } })
    }
  }
  // Per-request CSP nonce. src/router.tsx reads it from the global start context and hands it to
  // the router (`ssr.nonce`), which stamps it on every script it renders.
  const cspNonce = sec.newCspNonce()
  try {
    const result = await next({ context: { cspNonce } })
    const status = result.response.status
    const isHttps = url.protocol === 'https:' || request.headers.get('x-forwarded-proto') === 'https'
    try {
      result.response.headers.set('x-request-id', requestId)
      for (const [k, v] of Object.entries(sec.securityHeaders(isHttps, isHtml(result.response) ? cspNonce : undefined))) {
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

/** Only HTML documents carry the nonce; other responses get a script-src of 'self'. */
function isHtml(res: Response) {
  return (res.headers.get('content-type') ?? '').toLowerCase().includes('text/html')
}

/**
 * CSRF for server functions (#199). Setting our own request middleware turns off TanStack Start's
 * default CSRF check, so it is added back here. A POST to /_serverFn passes only when the browser
 * says it is same-origin (Sec-Fetch-Site), or, for clients that do not send that header, when Origin
 * (then Referer) is this request's origin, APP_URL or a CORS_ALLOWED_ORIGINS entry. A request with
 * none of the three is refused. Everything else is refused with 403, before any handler runs.
 * Better Auth's /api/auth/* endpoints keep their own origin check.
 */
export const csrfMiddleware = createCsrfMiddleware({
  filter: (ctx) => ctx.handlerType === 'serverFn',
  origin: async (value, ctx) => {
    if (value === new URL(ctx.request.url).origin) return true
    const { allowedOrigins } = await import('./server/lib/http-security')
    return allowedOrigins().has(value)
  },
})

export const startInstance = createStart(() => ({ requestMiddleware: [requestLogger, csrfMiddleware] }))
