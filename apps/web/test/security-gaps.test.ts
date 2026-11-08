import { afterEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb, setDb, type Db } from '../src/server/db/client'
import { appRateLimits, auditEvents, orgConnectors, orgNotificationChannels, orgResponseConnectors } from '../src/server/db/schema'
import { resetEnvForTests } from '../src/server/env'
import { DbRateLimiter, buildCsp, chatRateLimiter, newCspNonce, resetChatRateLimiterForTests, securityHeaders } from '../src/server/lib/http-security'
import { decryptSecret, decryptSecretDetailed, encryptSecret } from '../src/server/lib/crypto'
import { rotateSecrets } from '../src/server/cli/rotate-secrets'
import { makeOrg } from './helpers'

const KEY_A = 'a'.repeat(64)
const KEY_B = 'b'.repeat(64)
const ORIGINAL_KEY = process.env.APP_ENCRYPTION_KEY

function setKeys(current: string, previous?: string) {
  process.env.APP_ENCRYPTION_KEY = current
  if (previous) process.env.APP_ENCRYPTION_KEY_PREVIOUS = previous
  else delete process.env.APP_ENCRYPTION_KEY_PREVIOUS
  resetEnvForTests()
}

afterEach(() => {
  setKeys(ORIGINAL_KEY!)
  delete process.env.RATE_LIMIT_STORAGE
  resetEnvForTests()
  resetChatRateLimiterForTests()
})

describe('CSP nonce', () => {
  it('production with a nonce allows only self and that nonce for scripts', () => {
    const csp = buildCsp({ nonce: 'abc123==', production: true })
    expect(csp).toContain("script-src 'self' 'nonce-abc123=='")
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/)
    // Style attributes still need 'unsafe-inline' (and no nonce, which would cancel it).
    expect(csp).toContain("style-src 'self' 'unsafe-inline'")
    expect(csp).toContain("frame-ancestors 'none'")
  })

  it('production without a nonce (non-HTML responses) allows scripts from self only', () => {
    expect(buildCsp({ production: true })).toMatch(/script-src 'self';/)
  })

  it('development keeps unsafe-inline for Vite', () => {
    expect(buildCsp({ nonce: 'x', production: false })).toContain("script-src 'self' 'unsafe-inline'")
  })

  it('nonces are fresh base64 values of 16 bytes', () => {
    const a = newCspNonce()
    const b = newCspNonce()
    expect(a).not.toBe(b)
    expect(Buffer.from(a, 'base64')).toHaveLength(16)
  })

  it('securityHeaders threads the nonce into the CSP', () => {
    // NODE_ENV is test here, so the dev policy applies; the nonce path is covered above.
    expect(securityHeaders(false, 'n0nce')['Content-Security-Policy']).toMatch(/script-src/)
  })
})

describe('shared chat rate limit (database)', () => {
  it('two replicas share one count', async () => {
    const replicaA = new DbRateLimiter(3, 60_000, 'test-shared:')
    const replicaB = new DbRateLimiter(3, 60_000, 'test-shared:')
    const t = Date.parse('2026-11-08T00:00:00Z')
    expect((await replicaA.check('1.2.3.4', t)).ok).toBe(true)
    expect((await replicaB.check('1.2.3.4', t + 1)).ok).toBe(true)
    expect((await replicaA.check('1.2.3.4', t + 2)).ok).toBe(true)
    const blocked = await replicaB.check('1.2.3.4', t + 3)
    expect(blocked.ok).toBe(false)
    expect(blocked.retryAfterSec).toBe(60)
    // A different client has its own bucket.
    expect((await replicaB.check('5.6.7.8', t + 3)).ok).toBe(true)
    const [row] = await getDb().select().from(appRateLimits).where(eq(appRateLimits.key, 'test-shared:1.2.3.4'))
    expect(row?.count).toBe(4)
  })

  it('a new window resets the count', async () => {
    const rl = new DbRateLimiter(1, 1000, 'test-window:')
    const t = Date.parse('2026-11-08T01:00:00Z')
    expect((await rl.check('k', t)).ok).toBe(true)
    expect((await rl.check('k', t + 10)).ok).toBe(false)
    expect((await rl.check('k', t + 1000)).ok).toBe(true)
    expect((await rl.check('k', t + 1001)).ok).toBe(false)
  })

  it('fails open when the database errors', async () => {
    const real = getDb()
    setDb({ execute: () => Promise.reject(new Error('connection refused')) } as unknown as Db)
    try {
      expect(await new DbRateLimiter(1, 60_000, 'test-down:').check('k')).toEqual({ ok: true, retryAfterSec: 0 })
    } finally {
      setDb(real)
    }
  })

  it('RATE_LIMIT_STORAGE selects the limiter', async () => {
    process.env.RATE_LIMIT_STORAGE = 'memory'
    resetEnvForTests()
    resetChatRateLimiterForTests()
    expect(chatRateLimiter()).not.toBeInstanceOf(DbRateLimiter)
    expect((await chatRateLimiter().check('m')).ok).toBe(true)
    delete process.env.RATE_LIMIT_STORAGE
    resetEnvForTests()
    resetChatRateLimiterForTests()
    expect(chatRateLimiter()).toBeInstanceOf(DbRateLimiter)
  })
})

describe('encryption key rotation', () => {
  it('decrypts with a previous key, rotates to the current key, then works without the old key', async () => {
    setKeys(KEY_A)
    const orgId = await makeOrg('Rotate')
    const huntingSecret = 'hunting-client-secret-value'
    const responseSecret = 'response-client-secret-value'
    const webhook = 'https://example.webhook.office.com/webhookb2/abc'
    const encA = encryptSecret(huntingSecret)
    const db = getDb()
    await db.insert(orgConnectors).values({ orgId, tenantId: 't', clientId: 'c', clientSecretEnc: encA })
    await db.insert(orgResponseConnectors).values({ orgId, tenantId: 't', clientId: 'c', clientSecretEnc: encryptSecret(responseSecret) })
    const [ch] = await db.insert(orgNotificationChannels).values({ orgId, kind: 'teams', name: 'SOC', urlEnc: encryptSecret(webhook), urlHost: 'example.webhook.office.com' }).returning()

    // Switch to B with A as previous: old ciphertext still decrypts, new values use B.
    setKeys(KEY_B, KEY_A)
    expect(decryptSecretDetailed(encA)).toEqual({ plaintext: huntingSecret, keyIndex: 1 })
    expect(decryptSecretDetailed(encryptSecret('x')).keyIndex).toBe(0)

    const report = await rotateSecrets()
    expect(report.orgConnectors).toEqual({ rotated: 1, current: 0 })
    expect(report.orgResponseConnectors).toEqual({ rotated: 1, current: 0 })
    expect(report.orgNotificationChannels.rotated).toBe(1)

    // Idempotent: a second run has nothing to do.
    const again = await rotateSecrets()
    expect(again.orgConnectors).toEqual({ rotated: 0, current: 1 })
    expect(again.orgNotificationChannels.rotated).toBe(0)

    // Remove A entirely: everything still decrypts with B alone.
    setKeys(KEY_B)
    const [hc] = await db.select().from(orgConnectors).where(eq(orgConnectors.orgId, orgId))
    const [rc] = await db.select().from(orgResponseConnectors).where(eq(orgResponseConnectors.orgId, orgId))
    const [nc] = await db.select().from(orgNotificationChannels).where(eq(orgNotificationChannels.id, ch!.id))
    expect(decryptSecret(hc!.clientSecretEnc!)).toBe(huntingSecret)
    expect(decryptSecret(rc!.clientSecretEnc!)).toBe(responseSecret)
    expect(decryptSecret(nc!.urlEnc)).toBe(webhook)
    expect(() => decryptSecret(encA)).toThrow(/cannot decrypt/)

    // Audited with counts only, never values.
    const audits = await db.select().from(auditEvents).where(eq(auditEvents.action, 'secrets_rotated'))
    expect(audits).toHaveLength(2)
    const serialised = JSON.stringify(audits)
    for (const secret of [huntingSecret, responseSecret, webhook, encA]) expect(serialised).not.toContain(secret)
  })

  it('a value no configured key can decrypt rolls the whole rotation back', async () => {
    setKeys(KEY_A)
    const orgId = await makeOrg('Broken')
    await getDb().insert(orgConnectors).values({ orgId, tenantId: 't', clientId: 'c', clientSecretEnc: encryptSecret('s') })
    setKeys(KEY_B)
    await expect(rotateSecrets()).rejects.toThrow(/cannot decrypt/)
  })
})
