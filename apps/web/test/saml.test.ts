import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '../src/server/db/client'
import { orgMemberships, ssoProvider } from '../src/server/db/schema'
import { bindOwnProvider, provisionSamlUser, samlProvidersLimit } from '../src/server/auth/saml'
import { makeOrg, makeUser, member } from './helpers'

describe('SAML SSO org mapping (#65)', () => {
  it('only org owners may register providers', async () => {
    const org = await makeOrg('Saml')
    const owner = await makeUser()
    const analyst = await makeUser()
    await member(org, owner, 'owner')
    await member(org, analyst, 'analyst')
    expect(await samlProvidersLimit({ id: owner })).toBeGreaterThan(0)
    expect(await samlProvidersLimit({ id: analyst })).toBe(0)
  })

  it('bound providers place users in the bound org as analyst; unbound grant nothing', async () => {
    const org = await makeOrg('SamlBind')
    const owner = await makeUser()
    await member(org, owner, 'owner')
    await getDb().insert(ssoProvider).values({ id: crypto.randomUUID(), issuer: 'https://idp.example', providerId: 'okta-acme', domain: 'acme.example', userId: owner })
    await expect(bindOwnProvider('okta-acme', org, owner, 'analyst')).rejects.toThrow(/owners/)
    await bindOwnProvider('okta-acme', org, owner, 'owner')
    const u = await makeUser()
    expect(await provisionSamlUser({ user: { id: u }, provider: { providerId: 'okta-acme' } })).toBe(org)
    const [m] = await getDb().select().from(orgMemberships).where(eq(orgMemberships.userId, u))
    expect(m?.role).toBe('analyst')
    const stranger = await makeUser()
    expect(await provisionSamlUser({ user: { id: stranger }, provider: { providerId: 'unbound' } })).toBeNull()
  })

  it("owners cannot bind someone else's provider", async () => {
    const org = await makeOrg('SamlOther')
    const owner = await makeUser()
    const other = await makeUser()
    await member(org, owner, 'owner')
    await getDb().insert(ssoProvider).values({ id: crypto.randomUUID(), issuer: 'https://idp2.example', providerId: 'theirs', domain: 'x.example', userId: other })
    await expect(bindOwnProvider('theirs', org, owner, 'owner')).rejects.toThrow(/not registered by you/)
  })
})

describe('SAML and local sign-up limits (#203)', () => {
  it('owning only a personal workspace does not allow registering providers', async () => {
    const { orgs } = await import('../src/server/db/schema')
    const [personal] = await getDb().insert(orgs).values({ name: 'Mine', slug: `mine-${crypto.randomUUID().slice(0, 8)}`, isPersonal: true }).returning()
    const solo = await makeUser()
    await member(personal!.id, solo, 'owner')
    expect(await samlProvidersLimit({ id: solo })).toBe(0)
    await getDb().insert(ssoProvider).values({ id: crypto.randomUUID(), issuer: 'https://idp3.example', providerId: 'mine', domain: 'mine.example', userId: solo })
    await expect(bindOwnProvider('mine', personal!.id, solo, 'owner')).rejects.toThrow(/team organisation/)
  })

  it('one provider per domain, compared case-insensitively', async () => {
    const owner = await makeUser()
    await getDb().insert(ssoProvider).values({ id: crypto.randomUUID(), issuer: 'https://a.example', providerId: 'dup-a', domain: 'Dup.example', userId: owner })
    await expect(getDb().insert(ssoProvider).values({ id: crypto.randomUUID(), issuer: 'https://b.example', providerId: 'dup-b', domain: 'dup.EXAMPLE', userId: owner })).rejects.toThrow()
  })

  it('a local sign-up cannot take an address in a domain an Entra tenant owns', async () => {
    const { auth, resetAuthForTests } = await import('../src/server/auth/auth')
    const { orgs, user } = await import('../src/server/db/schema')
    resetAuthForTests()
    await getDb().insert(orgs).values({ name: 'Contoso', slug: `c-${crypto.randomUUID().slice(0, 8)}`, entraTenantId: crypto.randomUUID(), emailDomain: 'Contoso.example' })
    const signUp = (email: string) =>
      auth().handler(new Request('http://localhost:3000/api/auth/sign-up/email', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' }, body: JSON.stringify({ email, password: 'correct horse battery staple', name: 'x' }) }))
    const res = await signUp('ceo@contoso.example')
    expect(res.status).toBe(403)
    expect(((await res.json()) as { code?: string }).code).toBe('DOMAIN_USES_ENTRA')
    expect(await getDb().select().from(user).where(eq(user.email, 'ceo@contoso.example'))).toHaveLength(0)
    expect((await signUp('someone@elsewhere.example')).status).toBe(200)
  })

  it('a removed member is not re-added by a SAML sign-in', async () => {
    const { removeMember } = await import('../src/server/orgs')
    const org = await makeOrg('SamlRemoved')
    const owner = await makeUser()
    await member(org, owner, 'owner')
    await getDb().insert(ssoProvider).values({ id: crypto.randomUUID(), issuer: 'https://idp4.example', providerId: 'rm-idp', domain: 'rm.example', userId: owner })
    await bindOwnProvider('rm-idp', org, owner, 'owner')
    const u = await makeUser()
    await provisionSamlUser({ user: { id: u }, provider: { providerId: 'rm-idp' } })
    await removeMember(org, u, owner)
    expect(await provisionSamlUser({ user: { id: u }, provider: { providerId: 'rm-idp' } })).toBeNull()
    expect(await getDb().select().from(orgMemberships).where(eq(orgMemberships.userId, u))).toHaveLength(0)
  })
})
