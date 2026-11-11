import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { verify } from 'node:crypto'
import { makeSignature } from 'better-auth/crypto'
import { auth, resetAuthForTests } from '../src/server/auth/auth'
import { readSsoConfig } from '../src/server/auth/sso-secrets'
import { rotateSecrets } from '../src/server/cli/rotate-secrets'
import { getDb } from '../src/server/db/client'
import { auditEvents, orgConnectors, ssoProvider } from '../src/server/db/schema'
import { resetEnvForTests } from '../src/server/env'
import { encryptSecret, SECRET_COLUMNS } from '../src/server/lib/crypto'
import { team } from './helpers'

const BASE = 'http://localhost:3000'
const KEY_A = 'a'.repeat(64)
const KEY_B = 'b'.repeat(64)
const originalKey = process.env.APP_ENCRYPTION_KEY
type Provider = typeof ssoProvider.$inferSelect

function setKeys(current: string, previous?: string) {
  process.env.APP_ENCRYPTION_KEY = current
  if (previous) process.env.APP_ENCRYPTION_KEY_PREVIOUS = previous
  else delete process.env.APP_ENCRYPTION_KEY_PREVIOUS
  resetEnvForTests()
}

beforeEach(async () => {
  process.env.SAML_ENABLED = 'true'
  process.env.CORS_ALLOWED_ORIGINS = 'https://idp.example'
  setKeys(KEY_A)
  resetAuthForTests()
  await getDb().delete(ssoProvider)
  await getDb().delete(orgConnectors)
})

afterEach(() => {
  delete process.env.SAML_ENABLED
  delete process.env.CORS_ALLOWED_ORIGINS
  setKeys(originalKey!)
  resetAuthForTests()
})

async function ownerSession() {
  const { owner, orgId } = await team()
  const ctx = await auth().$context
  const session = await ctx.internalAdapter.createSession(owner)
  const signed = `${session!.token}.${await makeSignature(session!.token, ctx.secret)}`
  const headers = { 'content-type': 'application/json', origin: BASE, cookie: `${ctx.authCookies.sessionToken.name}=${encodeURIComponent(signed)}` }
  const call = (path: string, body?: unknown) => auth().handler(new Request(`${BASE}/api/auth${path}`, { method: body === undefined ? 'GET' : 'POST', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }))
  return { owner, orgId, adapter: ctx.adapter, call }
}

async function raw(id: string) {
  const [row] = await getDb().select().from(ssoProvider).where(eq(ssoProvider.id, id))
  return row!
}

async function createProvider() {
  const session = await ownerSession()
  const providerId = crypto.randomUUID()
  const oidcConfig = JSON.stringify({ clientId: 'test-client', clientSecret: 'test-oidc-secret', tokenEndpoint: 'https://idp.example/token' })
  const samlConfig = JSON.stringify({ privateKey: 'test-saml-private-key', entryPoint: 'https://idp.example/saml' })
  const provider = await session.adapter.create<Record<string, unknown>, Provider>({ model: 'ssoProvider', data: { providerId, issuer: 'https://idp.example', domain: `${providerId}.example`, userId: session.owner, oidcConfig, samlConfig } })
  return { ...session, provider, oidcConfig, samlConfig, where: [{ field: 'id', value: provider.id }] }
}

describe('SSO config encryption at the adapter boundary (#212)', () => {
  it('the real SAML plugin signs requests with an encrypted private key', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'crosswire-saml-test-'))
    try {
      const keyPath = path.join(dir, 'key.pem')
      const certPath = path.join(dir, 'cert.pem')
      // Ephemeral test credentials only. No key material is committed or printed.
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '1', '-subj', '/CN=idp.example'], { stdio: 'ignore' })
      const privateKey = readFileSync(keyPath, 'utf8')
      const cert = readFileSync(certPath, 'utf8')
      const { call, adapter } = await ownerSession()
      const providerId = 'saml-encrypted'
      const response = await call('/sso/register', {
        providerId, issuer: 'https://idp.example', domain: 'saml.example',
        samlConfig: { entryPoint: 'https://idp.example/saml', cert, callbackUrl: `${BASE}/app`, idpMetadata: { entityID: 'https://idp.example' }, authnRequestsSigned: true, spMetadata: { privateKey } },
      })
      expect(response.status).toBe(200)
      const [stored] = await getDb().select().from(ssoProvider).where(eq(ssoProvider.providerId, providerId))
      expect(stored!.samlConfig).toMatch(/^v2\./)
      expect(stored!.samlConfig!.includes(privateKey)).toBe(false)
      // DNS verification is external. Mark this isolated fixture verified, then exercise signing.
      await adapter.incrementOne({ model: 'ssoProvider', where: [{ field: 'id', value: stored!.id }], increment: {}, set: { domainVerified: true } })
      const metadata = await call(`/sso/saml2/sp/metadata?providerId=${providerId}`)
      expect(metadata.status).toBe(200)
      expect(await metadata.text()).toContain('AuthnRequestsSigned="true"')
      const signIn = await call('/sign-in/sso', { providerId, callbackURL: `${BASE}/app` })
      expect(signIn.status).toBe(200)
      const { url } = await signIn.json() as { url: string }
      const redirect = new URL(url)
      expect(redirect.origin).toBe('https://idp.example')
      const query = redirect.search.slice(1)
      const signed = query.slice(0, query.indexOf('&Signature='))
      expect(verify('RSA-SHA256', Buffer.from(signed), cert, Buffer.from(redirect.searchParams.get('Signature')!, 'base64'))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('the real SSO registration and update endpoints store ciphertext and still return usable provider views', async () => {
    const { call, adapter } = await ownerSession()
    const providerId = 'oidc-registration'
    const response = await call('/sso/register', {
      providerId, issuer: 'https://idp.example', domain: 'registration.example',
      oidcConfig: { clientId: 'test-client-id', clientSecret: 'test-first-secret', skipDiscovery: true, authorizationEndpoint: 'https://idp.example/authorize', tokenEndpoint: 'https://idp.example/token', jwksEndpoint: 'https://idp.example/jwks', pkce: true },
    })
    expect(response.status).toBe(200)
    const [stored] = await getDb().select().from(ssoProvider).where(eq(ssoProvider.providerId, providerId))
    expect(stored!.oidcConfig).toMatch(/^v2\./)
    expect(JSON.stringify(stored)).not.toContain('test-first-secret')
    const update = await call('/sso/update-provider', { providerId, oidcConfig: { clientSecret: 'test-replacement-secret' } })
    expect(update.status).toBe(200)
    const updated = await raw(stored!.id)
    expect(updated.oidcConfig).toMatch(/^v2\./)
    expect(updated.oidcConfig).not.toBe(stored!.oidcConfig)
    const decoded = await adapter.findOne<Provider>({ model: 'ssoProvider', where: [{ field: 'id', value: stored!.id }] })
    expect(JSON.parse(decoded!.oidcConfig!)).toMatchObject({ clientSecret: 'test-replacement-secret', clientId: 'test-client-id' })
    const view = await call(`/sso/get-provider?providerId=${providerId}`)
    expect(view.status).toBe(200)
    const text = await view.text()
    expect(text).toContain('https://idp.example/token')
    expect(text).not.toContain('test-replacement-secret')
  })

  it('encrypts both config columns and decrypts selected reads, transaction updates and atomic operations', async () => {
    const { adapter, provider, oidcConfig, samlConfig, where } = await createProvider()
    const stored = await raw(provider.id)
    expect(stored.oidcConfig).toMatch(/^v2\./)
    expect(stored.samlConfig).toMatch(/^v2\./)
    expect(JSON.stringify(stored)).not.toContain('test-oidc-secret')
    expect(JSON.stringify(stored)).not.toContain('test-saml-private-key')
    expect(provider).toMatchObject({ oidcConfig, samlConfig })
    expect(await adapter.findOne({ model: 'ssoProvider', where, select: ['oidcConfig'] })).toEqual({ oidcConfig })
    expect(await adapter.findMany({ model: 'ssoProvider', where, select: ['samlConfig'] })).toEqual([{ samlConfig }])
    const replacement = JSON.stringify({ privateKey: 'test-replacement-key' })
    await adapter.transaction(async (tx) => {
      expect(await tx.findOne({ model: 'ssoProvider', where })).toMatchObject({ oidcConfig, samlConfig })
      expect(await tx.update({ model: 'ssoProvider', where, update: { samlConfig: replacement } })).toMatchObject({ samlConfig: replacement, oidcConfig })
    })
    expect((await raw(provider.id)).samlConfig).toMatch(/^v2\./)
    // Domain verification uses incrementOne with an empty increment and a non-secret set.
    expect(await adapter.incrementOne({ model: 'ssoProvider', where, increment: {}, set: { domainVerified: true } })).toMatchObject({ domainVerified: true, samlConfig: replacement })
    expect(await adapter.consumeOne({ model: 'ssoProvider', where })).toMatchObject({ oidcConfig, samlConfig: replacement })
    expect(await raw(provider.id)).toBeUndefined()
  })

  it('rejects ciphertext copied to another provider or the other config column', async () => {
    const a = await createProvider()
    const b = await createProvider()
    const stored = await raw(a.provider.id)
    await getDb().update(ssoProvider).set({ oidcConfig: stored.oidcConfig }).where(eq(ssoProvider.id, b.provider.id))
    await expect(b.adapter.findOne({ model: 'ssoProvider', where: b.where })).rejects.toThrow(/cannot decrypt/)
    await getDb().update(ssoProvider).set({ samlConfig: stored.oidcConfig }).where(eq(ssoProvider.id, a.provider.id))
    await expect(a.adapter.findOne({ model: 'ssoProvider', where: a.where })).rejects.toThrow(/cannot decrypt/)
  })

  it('fails closed without an encryption key and on unsupported secret mutations', async () => {
    const { adapter, provider, where } = await createProvider()
    const before = await raw(provider.id)
    expect(await adapter.update({ model: 'ssoProvider', where: [], update: { oidcConfig: '{}' } })).toBeNull()
    expect(await raw(provider.id)).toEqual(before)
    await expect(adapter.update({ model: 'ssoProvider', where, update: { id: 'different-row' } })).rejects.toThrow(/cannot be changed/)
    await expect(adapter.updateMany({ model: 'ssoProvider', where, update: { oidcConfig: '{}' } })).rejects.toThrow(/one provider/)
    await expect(adapter.incrementOne({ model: 'ssoProvider', where, increment: {}, set: { samlConfig: '{}' } })).rejects.toThrow(/one provider/)
    await expect(adapter.findOne({ model: 'ssoProvider', where: [{ field: 'oidcConfig', value: 'test-secret' }] })).rejects.toThrow(/predicates/)
    setKeys('')
    await expect(adapter.update({ model: 'ssoProvider', where, update: { oidcConfig: '{"clientSecret":"test-missing-key"}' } })).rejects.toThrow(/APP_ENCRYPTION_KEY/)
    expect((await raw(provider.id)).oidcConfig).not.toContain('test-missing-key')
  })

  it('upgrades legacy plaintext, rotates encrypted configs, and remains idempotent after removing the old key', async () => {
    const { provider, adapter, where, oidcConfig, samlConfig } = await createProvider()
    const legacyId = crypto.randomUUID()
    await getDb().insert(ssoProvider).values({ id: legacyId, providerId: 'legacy', domain: 'legacy.example', issuer: 'https://idp.example', oidcConfig, samlConfig })
    expect(await adapter.findOne({ model: 'ssoProvider', where: [{ field: 'id', value: legacyId }] })).toMatchObject({ oidcConfig, samlConfig })
    setKeys(KEY_B, KEY_A)
    const report = await rotateSecrets()
    expect(report.ssoOidcConfigs).toEqual({ rotated: 2, current: 0 })
    expect(report.ssoSamlConfigs).toEqual({ rotated: 2, current: 0 })
    for (const id of [provider.id, legacyId]) {
      const row = await raw(id)
      expect(row.oidcConfig).toMatch(/^v2\./)
      expect(readSsoConfig(row.oidcConfig!, id, 'oidcConfig')).toEqual({ plaintext: oidcConfig, keyIndex: 0 })
    }
    setKeys(KEY_B)
    expect(await adapter.findOne({ model: 'ssoProvider', where })).toMatchObject({ oidcConfig, samlConfig })
    const before = await raw(provider.id)
    const again = await rotateSecrets()
    expect(again.ssoOidcConfigs).toEqual({ rotated: 0, current: 2 })
    expect(again.ssoSamlConfigs).toEqual({ rotated: 0, current: 2 })
    expect(await raw(provider.id)).toEqual(before)
    const audits = JSON.stringify(await getDb().select().from(auditEvents))
    expect(audits).not.toContain('test-oidc-secret')
    expect(audits).not.toContain('test-saml-private-key')
    expect(audits).not.toContain(before.oidcConfig)
  })

  it('a corrupt SSO config rolls back the whole rotation, including connector updates', async () => {
    const { provider, orgId } = await createProvider()
    const connector = encryptSecret('test-connector-secret', { orgId, column: SECRET_COLUMNS.huntingClientSecret })
    await getDb().insert(orgConnectors).values({ orgId, tenantId: 'test', clientId: 'test', clientSecretEnc: connector })
    await getDb().update(ssoProvider).set({ samlConfig: 'v2.invalid.invalid.invalid' }).where(eq(ssoProvider.id, provider.id))
    setKeys(KEY_B, KEY_A)
    await expect(rotateSecrets()).rejects.toThrow(/unsupported ciphertext/)
    const [row] = await getDb().select().from(orgConnectors).where(eq(orgConnectors.orgId, orgId))
    expect(row!.clientSecretEnc).toBe(connector)
  })
})
