import { beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { auth, resetAuthForTests } from '../src/server/auth/auth'
import { getAppSession, requireApiSession, safeReturnTo, HttpError } from '../src/server/auth/session'
import { getDb } from '../src/server/db/client'
import { auditEvents, orgMemberships, orgs } from '../src/server/db/schema'
import { entraEmailFallback, placeEntraUser, resolveEntraOrg, UnknownTenantError } from '../src/server/auth/entra'
import { createOrg } from '../src/server/orgs'
import { resetEnvForTests } from '../src/server/env'
import { makeUser } from './helpers'
import { Route as HealthRoute } from '../src/routes/healthz'

const BASE = 'http://localhost:3000'
const password = 'correct horse battery staple'

async function call(path: string, body?: unknown, cookie?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json', origin: BASE }
  if (cookie) headers.cookie = cookie
  return auth().handler(new Request(`${BASE}/api/auth${path}`, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) }))
}

function cookieFrom(res: Response) {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ')
}

beforeAll(() => {
  resetEnvForTests()
  resetAuthForTests()
})

describe('Better Auth (#17, #18, #20, #21, #22)', () => {
  it('session endpoint returns null when logged out', async () => {
    const res = await call('/get-session')
    expect(res.status).toBe(200)
    expect(await res.json()).toBeNull()
  })

  it('sign-up creates a user, a personal org (owner) and a session cookie', async () => {
    const res = await call('/sign-up/email', { email: 'alice@example.test', password, name: 'Alice' })
    expect(res.status).toBe(200)
    const cookie = cookieFrom(res)
    expect(cookie).toContain('better-auth.session_token')
    const setCookie = res.headers.getSetCookie().join('\n')
    expect(setCookie.toLowerCase()).toContain('httponly')

    const s = await getAppSession(new Headers({ cookie }))
    expect(s?.user.email).toBe('alice@example.test')
    expect(s?.org.role).toBe('owner')
  })

  it('sign-in success and failure are audited without secrets', async () => {
    const ok = await call('/sign-in/email', { email: 'alice@example.test', password })
    expect(ok.status).toBe(200)
    const bad = await call('/sign-in/email', { email: 'alice@example.test', password: 'wrong password 123' })
    expect(bad.status).toBe(401)
    const body = (await bad.json()) as { message?: string }
    // Generic error: no "user not found" vs "wrong password" enumeration.
    expect(body.message).toMatch(/invalid email or password/i)

    const rows = await getDb().select().from(auditEvents).where(eq(auditEvents.category, 'auth'))
    const actions = rows.map((r) => `${r.action}:${r.result}`)
    expect(actions).toContain('sign_up:success')
    expect(actions).toContain('sign_in:success')
    expect(actions).toContain('sign_in:failure')
    const dump = JSON.stringify(rows)
    expect(dump).not.toContain(password)
    expect(dump).not.toContain('wrong password 123')
  })

  it('sign-out clears the session', async () => {
    const res = await call('/sign-in/email', { email: 'alice@example.test', password })
    const cookie = cookieFrom(res)
    const out = await call('/sign-out', {}, cookie)
    expect(out.status).toBe(200)
    expect(out.headers.getSetCookie().join(';')).toMatch(/session_token=;|Max-Age=0/)
    expect(await getAppSession(new Headers({ cookie }))).toBeNull()
    const rows = await getDb().select().from(auditEvents).where(eq(auditEvents.action, 'sign_out'))
    expect(rows.length).toBeGreaterThan(0)
  })

  it('API guard returns 401 when signed out', async () => {
    await expect(requireApiSession(new Request(`${BASE}/api/me`))).rejects.toBeInstanceOf(HttpError)
  })

  it('health endpoint is public', async () => {
    const handler = (HealthRoute.options.server as { handlers: { GET: () => Response } }).handlers.GET
    const res = handler()
    expect(res.status).toBe(200)
  })

  it('returnTo cannot be an open redirect', () => {
    expect(safeReturnTo('/app/chat')).toBe('/app/chat')
    expect(safeReturnTo('https://evil.example')).toBe('/app')
    expect(safeReturnTo('//evil.example')).toBe('/app')
    expect(safeReturnTo('/\\evil.example')).toBe('/app')
    expect(safeReturnTo(undefined)).toBe('/app')
  })
})

describe('Entra org mapping (#19)', () => {
  it('falls back to the UPN only when Entra sends no email claim', () => {
    expect(entraEmailFallback({ preferred_username: 'Analyst@Contoso.onmicrosoft.com' })).toEqual({ email: 'analyst@contoso.onmicrosoft.com', emailVerified: false })
    // A claims policy asserting email_verified without an email must not make the UPN "verified".
    expect(entraEmailFallback({ preferred_username: 'a@contoso.com', email_verified: true } as never)).toEqual({ email: 'a@contoso.com', emailVerified: false })
    expect(entraEmailFallback({ email: 'real@contoso.com', preferred_username: 'other@contoso.com' })).toEqual({})
    expect(entraEmailFallback({ preferred_username: 'not-an-address' })).toEqual({})
    expect(entraEmailFallback({})).toEqual({})
  })

  it('maps a known tid into its org as analyst', async () => {
    const org = await createOrg('Contoso', { entraTenantId: '11111111-1111-1111-1111-111111111111' })
    const u = await makeUser()
    const orgId = await placeEntraUser(u, '11111111-1111-1111-1111-111111111111')
    expect(orgId).toBe(org.id)
    const [m] = await getDb().select().from(orgMemberships).where(eq(orgMemberships.userId, u))
    expect(m?.role).toBe('analyst')
  })

  it('rejects unknown tenants by default (safe default)', async () => {
    await expect(resolveEntraOrg('22222222-2222-2222-2222-222222222222')).rejects.toBeInstanceOf(UnknownTenantError)
    const rows = await getDb().select().from(orgs).where(eq(orgs.entraTenantId, '22222222-2222-2222-2222-222222222222'))
    expect(rows).toHaveLength(0)
  })

  it('auto-provisions an org when explicitly enabled; first user is owner', async () => {
    process.env.ENTRA_AUTO_PROVISION_ORGS = 'true'
    resetEnvForTests()
    try {
      const u = await makeUser()
      const orgId = await placeEntraUser(u, '33333333-3333-3333-3333-333333333333')
      const [m] = await getDb().select().from(orgMemberships).where(eq(orgMemberships.orgId, orgId))
      expect(m?.role).toBe('owner')
    } finally {
      delete process.env.ENTRA_AUTO_PROVISION_ORGS
      resetEnvForTests()
    }
  })
})
