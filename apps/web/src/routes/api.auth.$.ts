import { createFileRoute } from '@tanstack/react-router'
import { auth } from '../server/auth/auth'
import { enforceAbsoluteSessionCap } from '../server/auth/session'

/**
 * Better Auth HTTP handlers (#17), mounted at /api/auth/*. The absolute session cap
 * (SESSION_MAX_AGE_HOURS) is applied first, so an over-age session is revoked before Better Auth
 * can serve or refresh it on its own endpoints.
 */
async function handle(request: Request) {
  await enforceAbsoluteSessionCap(request.headers)
  return auth().handler(request)
}

export const Route = createFileRoute('/api/auth/$')({
  server: {
    handlers: {
      GET: ({ request }) => handle(request),
      POST: ({ request }) => handle(request),
    },
  },
})
