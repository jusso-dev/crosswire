import { beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { auth, resetAuthForTests, sessionLifetime } from '../src/server/auth/auth'
import { getAppSession, pastAbsoluteMaxAge, requireApiSession, safeReturnTo, HttpError, enforceAbsoluteSessionCap } from '../src/server/auth/session'
import { getDb } from '../src/server/db/client'
import { auditEvents, orgMemberships, orgs, session } from '../src/server/db/schema'
import { checkEntraGate, entraEmailFallback, placeEntraUser, UnknownTenantError } from '../src/server/auth/entra'
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

  it('rejects unknown tenants by default (safe default), creating nothing', async () => {
    await expect(checkEntraGate({ tid: '22222222-2222-2222-2222-222222222222' })).rejects.toBeInstanceOf(UnknownTenantError)
    await expect(placeEntraUser(await makeUser(), '22222222-2222-2222-2222-222222222222')).rejects.toBeInstanceOf(UnknownTenantError)
    const rows = await getDb().select().from(orgs).where(eq(orgs.entraTenantId, '22222222-2222-2222-2222-222222222222'))
    expect(rows).toHaveLength(0)
  })

  it('the auto-provision gate is check-only: it creates no org (#187)', async () => {
    process.env.ENTRA_AUTO_PROVISION_ORGS = 'true'
    resetEnvForTests()
    try {
      await checkEntraGate({ tid: '33333333-3333-3333-3333-333333333333' })
      expect(await getDb().select().from(orgs).where(eq(orgs.entraTenantId, '33333333-3333-3333-3333-333333333333'))).toHaveLength(0)
      // Two first sign-ins at once: one org, one owner, one analyst.
      const [a, b] = [await makeUser(), await makeUser()]
      const [oa, ob] = await Promise.all([placeEntraUser(a, '33333333-3333-3333-3333-333333333333'), placeEntraUser(b, '33333333-3333-3333-3333-333333333333')])
      expect(oa).toBe(ob)
      const roles = (await getDb().select().from(orgMemberships).where(eq(orgMemberships.orgId, oa))).map((m) => m.role).sort()
      expect(roles).toEqual(['analyst', 'owner'])
    } finally {
      delete process.env.ENTRA_AUTO_PROVISION_ORGS
      resetEnvForTests()
    }
  })
})

describe('session lifetime (absolute cap + idle timeout)', () => {
  it('idle timeout drives Better Auth expiresIn; updateAge is about five minutes and at most half', () => {
    expect(sessionLifetime(60)).toEqual({ expiresIn: 3600, updateAge: 300 })
    expect(sessionLifetime(5)).toEqual({ expiresIn: 300, updateAge: 150 })
    expect(auth().options.session).toEqual({ expiresIn: 3600, updateAge: 300 })
  })

  it('absolute cap compares sign-in time with SESSION_MAX_AGE_HOURS', () => {
    const now = Date.parse('2026-11-08T12:00:00Z')
    expect(pastAbsoluteMaxAge(new Date(now - 11 * 3_600_000), now)).toBe(false)
    expect(pastAbsoluteMaxAge(new Date(now - 12 * 3_600_000), now)).toBe(true)
  })

  it('a session older than the cap is revoked, treated as signed out and audited', async () => {
    const res = await call('/sign-up/email', { email: 'old-session@example.test', password, name: 'Old' })
    expect(res.status).toBe(200)
    const cookie = cookieFrom(res)
    const before = await getAppSession(new Headers({ cookie }))
    expect(before).not.toBeNull()
    const userId = before!.user.id

    // Signed in 13 hours ago, but still active (idle expiry in the future).
    await getDb()
      .update(session)
      .set({ createdAt: new Date(Date.now() - 13 * 3_600_000), expiresAt: new Date(Date.now() + 30 * 60_000) })
      .where(eq(session.userId, userId))

    expect(await getAppSession(new Headers({ cookie }))).toBeNull()
    await expect(requireApiSession(new Request(`${BASE}/api/x`, { headers: { cookie } }))).rejects.toMatchObject({ status: 401 })
    const rows = await getDb().select().from(session).where(eq(session.userId, userId))
    expect(rows).toHaveLength(0)
    const audit = await getDb().select().from(auditEvents).where(eq(auditEvents.action, 'session_expired_absolute'))
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ category: 'auth', actorId: userId, actorType: 'system' })
  })

  it('the cap also applies in front of Better Auth endpoints (/api/auth/get-session)', async () => {
    const res = await call('/sign-up/email', { email: 'old-session-2@example.test', password, name: 'Old2' })
    const cookie = cookieFrom(res)
    const userId = (await getAppSession(new Headers({ cookie })))!.user.id
    // Under the cap: nothing happens.
    await enforceAbsoluteSessionCap(new Headers({ cookie }))
    expect(await getDb().select().from(session).where(eq(session.userId, userId))).toHaveLength(1)
    await getDb()
      .update(session)
      .set({ createdAt: new Date(Date.now() - 13 * 3_600_000), expiresAt: new Date(Date.now() + 30 * 60_000) })
      .where(eq(session.userId, userId))
    await enforceAbsoluteSessionCap(new Headers({ cookie }))
    expect(await getDb().select().from(session).where(eq(session.userId, userId))).toHaveLength(0)
    const got = await auth().handler(new Request(`${BASE}/api/auth/get-session`, { headers: { cookie } }))
    expect(await got.json()).toBeNull()
  })

  it('SESSION_MAX_AGE_HOURS is configurable', () => {
    process.env.SESSION_MAX_AGE_HOURS = '1'
    resetEnvForTests()
    try {
      const now = Date.now()
      expect(pastAbsoluteMaxAge(new Date(now - 61 * 60_000), now)).toBe(true)
    } finally {
      delete process.env.SESSION_MAX_AGE_HOURS
      resetEnvForTests()
    }
  })
})
