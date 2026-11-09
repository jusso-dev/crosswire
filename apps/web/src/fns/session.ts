import { createServerFn } from '@tanstack/react-start'
import { getRequestHeaders } from '@tanstack/react-start/server'
import { getAppSession } from '../server/auth/session'
import { canApprove } from '../server/response/rbac'
import { countPending } from '../server/response/proposals'
import { countRunning } from '../server/agents/runs'
import { listReviewQueue } from '../server/agents/memory'

/** Used by route beforeLoad guards. Returns null when signed out (never throws for that). */
export const fetchSession = createServerFn({ method: 'GET' }).handler(async () => {
  const s = await getAppSession(new Headers(getRequestHeaders() as unknown as HeadersInit))
  if (!s) return null
  const [pendingApprovals, runningRuns, held] = await Promise.all([countPending(s.org.id), countRunning(s.org.id), listReviewQueue(s.org.id, 100)])
  // Notes this person could act on: held notes written by someone else (approvers only).
  const memoryToReview = canApprove(s.org.role) ? held.filter((row) => row.authorId && row.authorId !== s.user.id).length : 0
  return { user: s.user, org: s.org, canApprove: canApprove(s.org.role), pendingApprovals, runningRuns, memoryToReview }
})

export const fetchAuthConfig = createServerFn({ method: 'GET' }).handler(async () => {
  const { env } = await import('../server/env')
  const e = env()
  return { emailPassword: e.AUTH_EMAIL_PASSWORD, entra: Boolean(e.ENTRA_CLIENT_ID && e.ENTRA_CLIENT_SECRET) }
})
