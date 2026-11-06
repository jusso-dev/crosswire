import { redirect } from '@tanstack/react-router'
import { auth } from './auth'
import { getCurrentOrg, type CurrentOrg } from '../orgs'

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

/** Resolve the Better Auth session and current org from request headers. */
export async function getAppSession(headers: Headers): Promise<AppSession | null> {
  const result = await auth().api.getSession({ headers })
  if (!result) return null
  const org = await getCurrentOrg(result.user.id)
  if (!org) return null
  return { user: { id: result.user.id, email: result.user.email, name: result.user.name }, org }
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
