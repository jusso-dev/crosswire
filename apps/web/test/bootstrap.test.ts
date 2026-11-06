import { describe, expect, it } from 'vitest'
import { count, eq } from 'drizzle-orm'
import { getDb } from '../src/server/db/client'
import { auditEvents, orgMemberships, orgs } from '../src/server/db/schema'
import { bootstrap, BootstrapError, claimBootstrapOwner } from '../src/server/ops/bootstrap'
import { placeEntraUser } from '../src/server/auth/entra'
import { makeUser } from './helpers'

// Own file: bootstrap requires an empty database (each test file gets a fresh PGlite).
describe('bootstrap (#78)', () => {
  it('creates the first org, audits it, refuses re-run, and the SSO admin claims owner', async () => {
    const db = getDb()
    const [{ n }] = (await db.select({ n: count() }).from(orgs)) as [{ n: number }]
    expect(n).toBe(0)
    const r = await bootstrap({ orgName: 'Contoso SOC', adminEmail: 'Admin@Contoso.example', entraTenantId: '44444444-4444-4444-4444-444444444444' })
    expect(r.dryRun).toBe(true)
    expect(r.executors.logicapp).toBe('off')
    await expect(bootstrap({ orgName: 'Again', adminEmail: 'x@y.example' })).rejects.toBeInstanceOf(BootstrapError)
    const audit = await db.select().from(auditEvents).where(eq(auditEvents.action, 'bootstrap'))
    expect(audit).toHaveLength(1)
    expect(JSON.stringify(audit)).not.toContain('Admin@Contoso')

    const admin = await makeUser('admin@contoso.example')
    const orgId = await placeEntraUser(admin, '44444444-4444-4444-4444-444444444444')
    const [m] = await db.select().from(orgMemberships).where(eq(orgMemberships.userId, admin))
    expect(m?.role).toBe('owner')
    const other = await makeUser('analyst@contoso.example')
    await placeEntraUser(other, '44444444-4444-4444-4444-444444444444')
    const [m2] = await db.select().from(orgMemberships).where(eq(orgMemberships.userId, other))
    expect(m2?.role).toBe('analyst')
    expect(await claimBootstrapOwner(orgId, other)).toBe(false)
  })
})


describe('bootstrap with local sign-ups (#78 council)', () => {
  it('personal workspaces do not block bootstrap; the admin lands in the bootstrapped org', async () => {
    const { auth, resetAuthForTests } = await import('../src/server/auth/auth')
    const { getCurrentOrg } = await import('../src/server/orgs')
    resetAuthForTests()
    const signUp = (email: string) =>
      auth().handler(new Request('http://localhost:3000/api/auth/sign-up/email', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' }, body: JSON.stringify({ email, password: 'correct horse battery staple', name: email }) }))
    // An unrelated early local user gets a personal workspace; bootstrap must still be possible.
    expect((await signUp('early@example.test')).status).toBe(200)
    await getDb().delete(orgs).where(eq(orgs.isPersonal, false))
    const r = await bootstrap({ orgName: 'Lab SOC', adminEmail: 'lab-admin@example.test' })
    expect((await signUp('lab-admin@example.test')).status).toBe(200)
    const [u] = await getDb().select().from((await import('../src/server/db/schema')).user).where(eq((await import('../src/server/db/schema')).user.email, 'lab-admin@example.test'))
    const org = await getCurrentOrg(u!.id)
    expect(org?.id).toBe(r.orgId)
    expect(org?.role).toBe('owner')
  })
})
