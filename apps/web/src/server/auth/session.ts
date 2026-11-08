import { redirect } from '@tanstack/react-router'
import { auth } from './auth'
import { getCurrentOrg, type CurrentOrg } from '../orgs'
import { env } from '../env'
import { writeAudit } from '../audit'
import { logger } from '../lib/logger'

export interface AppSession {
  user: { id: string; email: string; name: string }
  org: CurrentOrg
}

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

/**
 * True when a session is past the absolute cap (SESSION_MAX_AGE_HOURS since sign-in). Better
 * Auth's own expiry slides with activity (the idle timeout), so this cap is enforced here.
 */
export function pastAbsoluteMaxAge(createdAt: Date | string, now = Date.now()): boolean {
  return now - new Date(createdAt).getTime() >= env().SESSION_MAX_AGE_HOURS * 3_600_000
}

/**
 * Revoke the request's session if it is past the absolute cap. Used in front of Better Auth's own
 * /api/auth/* endpoints, which never pass through getAppSession. Sessions under the cap, and
 * requests without one, are left alone. `disableRefresh` keeps this lookup from sliding the expiry.
 */
export async function enforceAbsoluteSessionCap(headers: Headers): Promise<void> {
  if (!headers.get('cookie')) return
  const result = await auth()
    .api.getSession({ headers, query: { disableRefresh: true } })
    .catch(() => null)
  if (result && pastAbsoluteMaxAge(result.session.createdAt)) await endExpiredSession(result.session, result.user.id)
}

/** Resolve the Better Auth session and current org from request headers. */
export async function getAppSession(headers: Headers): Promise<AppSession | null> {
  const result = await auth().api.getSession({ headers })
  if (!result) return null
  if (pastAbsoluteMaxAge(result.session.createdAt)) {
    await endExpiredSession(result.session, result.user.id)
    return null
  }
  const org = await getCurrentOrg(result.user.id)
  if (!org) return null
  return { user: { id: result.user.id, email: result.user.email, name: result.user.name }, org }
}

/**
 * Revoke a session that outlived the absolute cap. Deleted by token through Better Auth's internal
 * adapter (the revoke-session endpoint would need its own session check and writes a different
 * audit action). The browser's cookie is cleared on its next request, when Better Auth finds no row.
 */
async function endExpiredSession(session: { token: string; createdAt: Date | string }, userId: string) {
  const ctx = await auth().$context
  await ctx.internalAdapter.deleteSession(session.token)
  try {
    const org = await getCurrentOrg(userId).catch(() => null)
    await writeAudit({
      category: 'auth',
      action: 'session_expired_absolute',
      actorType: 'system',
      actorId: userId,
      orgId: org?.id ?? null,
      data: { maxAgeHours: env().SESSION_MAX_AGE_HOURS, signedInAt: new Date(session.createdAt).toISOString() },
    })
  } catch (err) {
    logger.error('session expiry audit write failed', { error: err instanceof Error ? err.message : String(err) })
  }
}

/** API guard: throws HttpError(401) which API handlers turn into JSON. */
export async function requireApiSession(request: Request): Promise<AppSession> {
  const s = await getAppSession(request.headers)
  if (!s) throw new HttpError(401, 'unauthorized')
  return s
}

/** Page guard: redirects to sign-in with a safe, same-origin returnTo. */
export async function requirePageSession(headers: Headers, returnTo: string): Promise<AppSession> {
  const s = await getAppSession(headers)
  if (!s) throw redirect({ to: '/sign-in', search: { returnTo: safeReturnTo(returnTo) } })
  return s
}

/** Only allow app-relative paths; prevents open redirects via returnTo. */
export function safeReturnTo(value: unknown): string {
  if (typeof value !== 'string') return '/app'
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return '/app'
  if (/[\r\n]/.test(value)) return '/app'
  return value
}

export function jsonError(err: unknown): Response {
  if (err instanceof HttpError) return Response.json({ error: err.message }, { status: err.status })
  throw err
}
