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
