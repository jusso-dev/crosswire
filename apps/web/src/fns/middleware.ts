import { createMiddleware } from '@tanstack/react-start'
import { getRequestHeaders } from '@tanstack/react-start/server'
import { redirect } from '@tanstack/react-router'
import { getAppSession } from '../server/auth/session'

/**
 * Server-function session guard (#20). Every private server function uses this; route `beforeLoad`
 * guards are UX on top, not the security boundary.
 */
export const authed = createMiddleware({ type: 'function' }).server(async ({ next }) => {
  const session = await getAppSession(new Headers(getRequestHeaders() as unknown as HeadersInit))
  if (!session) throw redirect({ to: '/sign-in' })
  return next({ context: { session } })
})
