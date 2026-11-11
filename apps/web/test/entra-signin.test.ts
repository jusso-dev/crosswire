import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { auth, resetAuthForTests } from '../src/server/auth/auth'
import { getAppSession } from '../src/server/auth/session'
import { decideEntraRole, entraTokenMemberships } from '../src/server/auth/entra'
import { getDb } from '../src/server/db/client'
import { auditEvents, entraRoleMappings, orgMemberships, orgs, user } from '../src/server/db/schema'
import { bootstrap } from '../src/server/ops/bootstrap'
import { listenRoleLoweredForTests, removeMember } from '../src/server/orgs'
import { resetEnvForTests } from '../src/server/env'
import { makeUser, member } from './helpers'

/**
 * Entra sign-in through Better Auth's real /callback/microsoft handler. Only the token endpoint is
 * stubbed (no network): it returns an ID token with the claims each test needs. This runs
 * mapProfileToUser, the user hooks and the session hook in the order Better Auth runs them (#187).
 */
const BASE = 'http://localhost:3000'
const TOKEN_ENDPOINT = /login\.microsoftonline\.com\/.+\/oauth2\/v2\.0\/token/

let nextClaims: Record<string, unknown> = {}
const realFetch = globalThis.fetch

function fakeIdToken(claims: Record<string, unknown>) {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${enc({ alg: 'none', typ: 'JWT' })}.${enc(claims)}.sig`
}

beforeAll(() => {
  process.env.ENTRA_CLIENT_ID = 'test-client'
  process.env.ENTRA_CLIENT_SECRET = 'test-secret'
  process.env.ENTRA_TENANT_ID = 'organizations'
  resetEnvForTests()
  resetAuthForTests()
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (TOKEN_ENDPOINT.test(url)) {
      return Response.json({ token_type: 'Bearer', access_token: 'at', expires_in: 3600, id_token: fakeIdToken(nextClaims) })
    }
    if (url.startsWith('https://')) throw new Error(`unexpected network call in test: ${url}`)
    return realFetch(input, init)
  })
})

afterAll(() => {
  vi.unstubAllGlobals()
  delete process.env.ENTRA_CLIENT_ID
  delete process.env.ENTRA_CLIENT_SECRET
  delete process.env.ENTRA_TENANT_ID
  delete process.env.ENTRA_AUTO_PROVISION_ORGS
  resetEnvForTests()
  resetAuthForTests()
})

function cookiesOf(res: Response) {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ')
}

interface Person {
  oid: string
  email: string
  tid: string
  groups?: string[]
  roles?: string[]
  extra?: Record<string, unknown>
}

/** One full Entra sign-in. Returns where the browser was sent and the session cookie, if any. */
async function signIn(p: Person) {
  const start = await auth().handler(
    new Request(`${BASE}/api/auth/sign-in/social`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE },
      body: JSON.stringify({ provider: 'microsoft', callbackURL: '/app', errorCallbackURL: '/auth-error' }),
    }),
  )
  expect(start.status).toBe(200)
  const { url } = (await start.json()) as { url: string }
  const state = new URL(url).searchParams.get('state')!
  const now = Math.floor(Date.now() / 1000)
  nextClaims = {
    oid: p.oid,
    tid: p.tid,
    sub: p.oid,
    email: p.email,
    name: p.email.split('@')[0],
    iss: `https://login.microsoftonline.com/${p.tid}/v2.0`,
    aud: 'test-client',
    iat: now,
    exp: now + 3600,
    ...(p.groups ? { groups: p.groups } : {}),
    ...(p.roles ? { roles: p.roles } : {}),
    ...p.extra,
  }
  const cb = await auth().handler(new Request(`${BASE}/api/auth/callback/microsoft?code=c&state=${encodeURIComponent(state)}`, { headers: { cookie: cookiesOf(start) } }))
  const location = cb.headers.get('location') ?? ''
  const cookie = cookiesOf(cb)
  const session = cookie.includes('session_token') ? await getAppSession(new Headers({ cookie })) : null
  return { status: cb.status, location, session }
}

const errorOf = (location: string) => new URL(location, BASE).searchParams.get('error')

async function roleIn(orgId: string, email: string) {
  const [m] = await getDb()
    .select({ role: orgMemberships.role, source: orgMemberships.roleSource })
    .from(orgMemberships)
    .innerJoin(user, eq(user.id, orgMemberships.userId))
    .where(and(eq(orgMemberships.orgId, orgId), eq(user.email, email)))
  return m ?? null
}

async function tenantOrg(tid: string, opts: { requireGroup?: boolean } = {}) {
  const [o] = await getDb()
    .insert(orgs)
    .values({ name: `T ${tid.slice(0, 4)}`, slug: `t-${crypto.randomUUID().slice(0, 8)}`, entraTenantId: tid, entraRequireMappedGroup: opts.requireGroup ?? false })
    .returning()
  return o!.id
}

async function mapping(orgId: string, kind: 'group' | 'app_role', value: string, role: 'owner' | 'approver' | 'analyst') {
  await getDb().insert(entraRoleMappings).values({ orgId, kind, value, role })
}

const tid = () => crypto.randomUUID()
const oid = () => crypto.randomUUID()

describe('Entra claims (pure)', () => {
  it('the highest mapped role wins; app roles match by value, groups by id', () => {
    const maps = [
      { kind: 'group' as const, value: 'G-ANALYST', role: 'analyst' as const },
      { kind: 'group' as const, value: 'g-approver', role: 'approver' as const },
      { kind: 'app_role' as const, value: 'Crosswire.Owner', role: 'owner' as const },
    ]
    expect(decideEntraRole(maps, { groups: ['g-analyst', 'G-APPROVER'] }).role).toBe('approver')
    expect(decideEntraRole(maps, { groups: ['g-analyst'], roles: ['Crosswire.Owner'] }).role).toBe('owner')
    expect(decideEntraRole(maps, { roles: ['crosswire.owner'] }).role).toBeNull()
    expect(decideEntraRole(maps, {}).role).toBeNull()
  })

  it('group overage fails closed: no groups are trusted, app roles still are', () => {
    expect(entraTokenMemberships({ groups: ['a'], _claim_names: { groups: 'src1' } })).toEqual({ groups: [], roles: [], overage: true })
    expect(entraTokenMemberships({ hasgroups: true, roles: ['R'] })).toEqual({ groups: [], roles: ['R'], overage: true })
    const maps = [
      { kind: 'group' as const, value: 'g-owner', role: 'owner' as const },
      { kind: 'app_role' as const, value: 'Approver', role: 'approver' as const },
    ]
    expect(decideEntraRole(maps, { groups: ['g-owner'], _claim_names: { groups: 'src1' }, roles: ['Approver'] })).toMatchObject({ role: 'approver', overage: true })
  })
})

describe('Entra sign-in placement (#187)', () => {
  it('auto-provision: the first person through the real callback owns the new org; the next is analyst', async () => {
    process.env.ENTRA_AUTO_PROVISION_ORGS = 'true'
    resetEnvForTests()
    try {
      const t = tid()
      const first = await signIn({ oid: oid(), email: 'first@newco.example', tid: t })
      expect(first.location).toMatch(/\/app$/)
      expect(first.session?.org.role).toBe('owner')
      const second = await signIn({ oid: oid(), email: 'second@newco.example', tid: t })
      expect(second.session?.org.role).toBe('analyst')
      expect(second.session?.org.id).toBe(first.session?.org.id)
      expect(await getDb().select().from(orgs).where(eq(orgs.entraTenantId, t))).toHaveLength(1)
    } finally {
      delete process.env.ENTRA_AUTO_PROVISION_ORGS
      resetEnvForTests()
    }
  })

  it('an unknown tenant is refused before any user or org row exists', async () => {
    const t = tid()
    const r = await signIn({ oid: oid(), email: 'nobody@unknown.example', tid: t })
    expect(errorOf(r.location)).toBe('UNKNOWN_TENANT')
    expect(await getDb().select().from(user).where(eq(user.email, 'nobody@unknown.example'))).toHaveLength(0)
    expect(await getDb().select().from(orgs).where(eq(orgs.entraTenantId, t))).toHaveLength(0)
  })

  it('a known tenant places the person on every sign-in, even if an earlier placement was lost', async () => {
    const t = tid()
    const orgId = await tenantOrg(t)
    const id = oid()
    const r1 = await signIn({ oid: id, email: 'repeat@known.example', tid: t })
    expect(r1.session?.org.id).toBe(orgId)
    await getDb().delete(orgMemberships).where(eq(orgMemberships.orgId, orgId))
    const r2 = await signIn({ oid: id, email: 'repeat@known.example', tid: t })
    expect(r2.session?.org).toMatchObject({ id: orgId, role: 'analyst' })
  })
})

describe('Entra group and app-role mapping (owner request, #195)', () => {
  it('sets the highest matching role on join and records it as Entra-managed, with an audit row', async () => {
    const t = tid()
    const orgId = await tenantOrg(t)
    await mapping(orgId, 'group', 'g-approvers', 'approver')
    await mapping(orgId, 'app_role', 'Crosswire.Owner', 'owner')
    const r = await signIn({ oid: oid(), email: 'boss@mapped.example', tid: t, groups: ['g-approvers'], roles: ['Crosswire.Owner'] })
    expect(r.session?.org.role).toBe('owner')
    expect(await roleIn(orgId, 'boss@mapped.example')).toEqual({ role: 'owner', source: 'entra' })
    const [a] = await getDb().select().from(auditEvents).where(and(eq(auditEvents.action, 'entra_role_synced'), eq(auditEvents.orgId, orgId)))
    expect(a?.data).toMatchObject({ from: null, to: 'owner', matched: expect.arrayContaining([expect.objectContaining({ value: 'Crosswire.Owner' })]) })
  })

  it('downgrades at the next sign-in when the person leaves the group, and runs the lowered-role hook', async () => {
    const t = tid()
    const orgId = await tenantOrg(t)
    const keeper = await makeUser()
    await member(orgId, keeper, 'owner')
    await mapping(orgId, 'group', 'g-approvers', 'approver')
    await mapping(orgId, 'group', 'g-analysts', 'analyst')
    const id = oid()
    await signIn({ oid: id, email: 'mover@mapped.example', tid: t, groups: ['g-approvers'] })
    expect((await roleIn(orgId, 'mover@mapped.example'))?.role).toBe('approver')
    const seen: unknown[] = []
    const stop = listenRoleLoweredForTests((e) => void seen.push(e))
    try {
      await signIn({ oid: id, email: 'mover@mapped.example', tid: t, groups: ['g-analysts'] })
    } finally {
      stop()
    }
    expect(await roleIn(orgId, 'mover@mapped.example')).toEqual({ role: 'analyst', source: 'entra' })
    expect(seen).toMatchObject([{ orgId, oldRole: 'approver', newRole: 'analyst' }])
    const rows = await getDb().select().from(auditEvents).where(and(eq(auditEvents.action, 'entra_role_synced'), eq(auditEvents.orgId, orgId)))
    expect(rows.map((r) => r.data)).toContainEqual(expect.objectContaining({ from: 'approver', to: 'analyst' }))
  })

  it('no match: a manual role is kept, an Entra-managed role drops to analyst', async () => {
    const t = tid()
    const orgId = await tenantOrg(t)
    const keeper = await makeUser()
    await member(orgId, keeper, 'owner')
    await mapping(orgId, 'group', 'g-approvers', 'approver')
    // Joined before the mappings mattered, made approver by hand.
    const manualId = oid()
    await signIn({ oid: manualId, email: 'manual@mapped.example', tid: t })
    await getDb().update(orgMemberships).set({ role: 'approver' }).where(eq(orgMemberships.orgId, orgId))
    await getDb().update(orgMemberships).set({ role: 'owner' }).where(eq(orgMemberships.userId, keeper))
    await signIn({ oid: manualId, email: 'manual@mapped.example', tid: t })
    expect(await roleIn(orgId, 'manual@mapped.example')).toEqual({ role: 'approver', source: 'manual' })
    // Got approver from the group, then left it.
    const entraId = oid()
    await signIn({ oid: entraId, email: 'grouped@mapped.example', tid: t, groups: ['g-approvers'] })
    expect(await roleIn(orgId, 'grouped@mapped.example')).toEqual({ role: 'approver', source: 'entra' })
    await signIn({ oid: entraId, email: 'grouped@mapped.example', tid: t, groups: [] })
    expect(await roleIn(orgId, 'grouped@mapped.example')).toEqual({ role: 'analyst', source: 'manual' })
  })

  it('group overage never raises a role from groups; an app role still applies', async () => {
    const t = tid()
    const orgId = await tenantOrg(t)
    const keeper = await makeUser()
    await member(orgId, keeper, 'owner')
    await mapping(orgId, 'group', 'g-owners', 'owner')
    await mapping(orgId, 'app_role', 'Approver', 'approver')
    const overage = { _claim_names: { groups: 'src1' }, _claim_sources: { src1: { endpoint: 'https://graph.microsoft.com/v1.0/users/x/getMemberObjects' } } }
    await signIn({ oid: oid(), email: 'many@mapped.example', tid: t, groups: ['g-owners'], extra: overage })
    expect((await roleIn(orgId, 'many@mapped.example'))?.role).toBe('analyst')
    await signIn({ oid: oid(), email: 'many2@mapped.example', tid: t, roles: ['Approver'], extra: overage })
    expect((await roleIn(orgId, 'many2@mapped.example'))?.role).toBe('approver')
  })

  it('a sync never removes the last owner; it audits the refusal and the sign-in still works', async () => {
    const t = tid()
    const orgId = await tenantOrg(t)
    await mapping(orgId, 'group', 'g-owners', 'owner')
    await mapping(orgId, 'group', 'g-analysts', 'analyst')
    const id = oid()
    await signIn({ oid: id, email: 'solo@mapped.example', tid: t, groups: ['g-owners'] })
    const r = await signIn({ oid: id, email: 'solo@mapped.example', tid: t, groups: ['g-analysts'] })
    expect(r.session?.org.role).toBe('owner')
    const [a] = await getDb().select().from(auditEvents).where(and(eq(auditEvents.action, 'entra_role_synced_blocked_last_owner'), eq(auditEvents.orgId, orgId)))
    expect(a).toMatchObject({ result: 'failure' })
    expect(a?.data).toMatchObject({ from: 'owner', to: 'analyst' })
  })

  it('require-group on: no match is refused with a plain code and no membership', async () => {
    const t = tid()
    const orgId = await tenantOrg(t, { requireGroup: true })
    await mapping(orgId, 'group', 'g-soc', 'analyst')
    const r = await signIn({ oid: oid(), email: 'outsider@strict.example', tid: t, groups: ['g-other'] })
    expect(errorOf(r.location)).toBe('NOT_IN_MAPPED_GROUP')
    expect(r.session).toBeNull()
    expect(await roleIn(orgId, 'outsider@strict.example')).toBeNull()
    expect(await getDb().select().from(user).where(eq(user.email, 'outsider@strict.example'))).toHaveLength(0)
    const ok = await signIn({ oid: oid(), email: 'insider@strict.example', tid: t, groups: ['g-soc'] })
    expect(ok.session?.org.id).toBe(orgId)
  })

  it('require-group on also refuses an existing member who left every mapped group', async () => {
    const t = tid()
    const orgId = await tenantOrg(t)
    await mapping(orgId, 'group', 'g-soc', 'analyst')
    const id = oid()
    expect((await signIn({ oid: id, email: 'leaver@strict.example', tid: t, groups: ['g-soc'] })).session).not.toBeNull()
    await getDb().update(orgs).set({ entraRequireMappedGroup: true }).where(eq(orgs.id, orgId))
    const r = await signIn({ oid: id, email: 'leaver@strict.example', tid: t, groups: [] })
    expect(errorOf(r.location)).toBe('NOT_IN_MAPPED_GROUP')
    expect(r.session).toBeNull()
  })

  it('require-group off: someone new with no match joins as analyst', async () => {
    const t = tid()
    const orgId = await tenantOrg(t)
    await mapping(orgId, 'group', 'g-soc', 'approver')
    const r = await signIn({ oid: oid(), email: 'new@open.example', tid: t, groups: ['g-other'] })
    expect(r.session?.org).toMatchObject({ id: orgId, role: 'analyst' })
  })

  it("mappings never cross organisations: another org's group does nothing here", async () => {
    const t1 = tid()
    const t2 = tid()
    const org1 = await tenantOrg(t1)
    const org2 = await tenantOrg(t2)
    await mapping(org1, 'group', 'shared-id', 'owner')
    const r = await signIn({ oid: oid(), email: 'cross@two.example', tid: t2, groups: ['shared-id'] })
    expect(r.session?.org).toMatchObject({ id: org2, role: 'analyst' })
  })
})

describe('removed members stay out (#195)', () => {
  it('a removed person is refused at their next Entra sign-in', async () => {
    const t = tid()
    const orgId = await tenantOrg(t)
    const ownerId = await makeUser()
    await member(orgId, ownerId, 'owner')
    const id = oid()
    await signIn({ oid: id, email: 'gone@rm.example', tid: t })
    const [u] = await getDb().select().from(user).where(eq(user.email, 'gone@rm.example'))
    await removeMember(orgId, u!.id, ownerId)
    const r = await signIn({ oid: id, email: 'gone@rm.example', tid: t })
    expect(errorOf(r.location)).toBe('MEMBER_REMOVED')
    expect(await roleIn(orgId, 'gone@rm.example')).toBeNull()
  })
})

describe('bootstrap ownership (#188)', () => {
  it('the bootstrap admin signing in from the bound tenant becomes owner', async () => {
    const t = tid()
    // Bootstrap refuses when a team org exists; this file's earlier tests made some, so clear them.
    await getDb().delete(orgs).where(eq(orgs.isPersonal, false))
    const { orgId } = await bootstrap({ orgName: 'Boot', adminEmail: 'admin@boot.example', entraTenantId: t })
    const r = await signIn({ oid: oid(), email: 'admin@boot.example', tid: t })
    expect(r.session?.org).toMatchObject({ id: orgId, role: 'owner' })
  })

  it('the same email from another tenant does not claim it', async () => {
    const t = tid()
    await getDb().delete(orgs).where(eq(orgs.isPersonal, false))
    const { orgId } = await bootstrap({ orgName: 'Boot2', adminEmail: 'admin2@boot.example', entraTenantId: t })
    const other = tid()
    const otherOrg = await tenantOrg(other)
    const r = await signIn({ oid: oid(), email: 'admin2@boot.example', tid: other })
    expect(r.session?.org).toMatchObject({ id: otherOrg, role: 'analyst' })
    const [o] = await getDb().select().from(orgs).where(eq(orgs.id, orgId))
    expect(o?.bootstrapOwnerEmail).toBe('admin2@boot.example')
  })

  it('a POST /sign-in/social with a bare ID token is refused', async () => {
    const res = await auth().handler(
      new Request(`${BASE}/api/auth/sign-in/social`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: BASE },
        body: JSON.stringify({ provider: 'microsoft', idToken: { token: fakeIdToken({ oid: oid(), tid: tid(), email: 'x@y.example' }) } }),
      }),
    )
    expect(res.status).toBeGreaterThanOrEqual(400)
  })
})
