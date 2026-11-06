import { createMiddleware, createStart } from '@tanstack/react-start'

/**
 * Request logging + correlation ids (#63). Every request gets an `x-request-id` (reused from the
 * proxy if it is a safe token) echoed on the response, and one structured log line with method,
 * path, status and duration. Query strings, headers and bodies are not logged.
 */
const requestLogger = createMiddleware({ type: 'request' }).server(async ({ request, next }) => {
  const { logger } = await import('./server/lib/logger')
  const incoming = request.headers.get('x-request-id')
  const requestId = incoming && /^[A-Za-z0-9._-]{8,128}$/.test(incoming) ? incoming : crypto.randomUUID()
  const started = performance.now()
  const path = new URL(request.url).pathname
  try {
    const result = await next()
    const status = result.response.status
    try {
      result.response.headers.set('x-request-id', requestId)
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
