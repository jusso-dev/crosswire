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


describe('bootstrap with local sign-ups (#78, #188)', () => {
  it('personal workspaces do not block bootstrap; a later local sign-up with the admin email cannot claim it', async () => {
    const { auth, resetAuthForTests } = await import('../src/server/auth/auth')
    const { getCurrentOrg } = await import('../src/server/orgs')
    const { user } = await import('../src/server/db/schema')
    resetAuthForTests()
    const signUp = (email: string) =>
      auth().handler(new Request('http://localhost:3000/api/auth/sign-up/email', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' }, body: JSON.stringify({ email, password: 'correct horse battery staple', name: email }) }))
    // An unrelated early local user gets a personal workspace; bootstrap must still be possible.
    expect((await signUp('early@example.test')).status).toBe(200)
    await getDb().delete(orgs).where(eq(orgs.isPersonal, false))
    const r = await bootstrap({ orgName: 'Lab SOC', adminEmail: 'lab-admin@example.test' })
    // Local sign-up does not verify the address, so it must not take the waiting org (#188).
    expect((await signUp('lab-admin@example.test')).status).toBe(200)
    const [u] = await getDb().select().from(user).where(eq(user.email, 'lab-admin@example.test'))
    const org = await getCurrentOrg(u!.id)
    expect(org?.id).not.toBe(r.orgId)
    const [o] = await getDb().select().from(orgs).where(eq(orgs.id, r.orgId))
    expect(o?.bootstrapOwnerEmail).toBe('lab-admin@example.test')
  })

  it('an account that already exists when bootstrap runs is made owner (the operator chose it)', async () => {
    await getDb().delete(orgs).where(eq(orgs.isPersonal, false))
    const u = await makeUser('existing-admin@example.test')
    const r = await bootstrap({ orgName: 'Existing', adminEmail: 'existing-admin@example.test' })
    expect(r.adminLinked).toBe(true)
    const [m] = await getDb().select().from(orgMemberships).where(eq(orgMemberships.userId, u))
    expect(m?.role).toBe('owner')
  })

  it('an unverified SSO account (SAML, no tenant) cannot claim the bootstrap email', async () => {
    await getDb().delete(orgs).where(eq(orgs.isPersonal, false))
    const r = await bootstrap({ orgName: 'Saml Boot', adminEmail: 'saml-admin@example.test' })
    const { user } = await import('../src/server/db/schema')
    const u = await makeUser('saml-admin@example.test')
    await getDb().update(user).set({ emailVerified: false }).where(eq(user.id, u))
    await getDb().insert(orgMemberships).values({ orgId: r.orgId, userId: u, role: 'analyst' })
    expect(await claimBootstrapOwner(r.orgId, u)).toBe(false)
    expect(await claimBootstrapOwner(r.orgId, u, { tenantMatched: true })).toBe(false)
    const refused = await getDb().select().from(auditEvents).where(eq(auditEvents.action, 'bootstrap_owner_claim_refused'))
    expect(refused.length).toBeGreaterThan(0)
    // A verified address may claim it, once.
    await getDb().update(user).set({ emailVerified: true }).where(eq(user.id, u))
    expect(await claimBootstrapOwner(r.orgId, u)).toBe(true)
    expect(await claimBootstrapOwner(r.orgId, u)).toBe(false)
  })
})
