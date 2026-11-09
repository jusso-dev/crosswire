import { createServerFn } from '@tanstack/react-start'
import { getRequestHeaders } from '@tanstack/react-start/server'
import { getAppSession } from '../server/auth/session'
import { canApprove } from '../server/response/rbac'
import { countPending } from '../server/response/proposals'
import { countRunning } from '../server/agents/runs'
import { countReviewable } from '../server/agents/memory'

/** Used by route beforeLoad guards. Returns null when signed out (never throws for that). */
export const fetchSession = createServerFn({ method: 'GET' }).handler(async () => {
  const s = await getAppSession(new Headers(getRequestHeaders() as unknown as HeadersInit))
  if (!s) return null
  // Notes this person could act on: held notes written by someone else (approvers only).
  const [pendingApprovals, runningRuns, memoryToReview] = await Promise.all([countPending(s.org.id), countRunning(s.org.id), canApprove(s.org.role) ? countReviewable(s.org.id, s.user.id) : Promise.resolve(0)])
  return { user: s.user, org: s.org, canApprove: canApprove(s.org.role), pendingApprovals, runningRuns, memoryToReview }
})

export const fetchAuthConfig = createServerFn({ method: 'GET' }).handler(async () => {
  const { env } = await import('../server/env')
  const e = env()
  return { emailPassword: e.AUTH_EMAIL_PASSWORD, entra: Boolean(e.ENTRA_CLIENT_ID && e.ENTRA_CLIENT_SECRET) }
})
