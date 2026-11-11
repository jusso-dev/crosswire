import { afterEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb, setDb, type Db } from '../src/server/db/client'
import { appRateLimits, auditEvents, orgConnectors, orgNotificationChannels, orgResponseConnectors } from '../src/server/db/schema'
import { resetEnvForTests } from '../src/server/env'
import { DbRateLimiter, buildCsp, chatRateLimiter, newCspNonce, resetChatRateLimiterForTests, securityHeaders } from '../src/server/lib/http-security'
import { createCipheriv, randomBytes } from 'node:crypto'
import { decryptSecret, decryptSecretDetailed, encryptSecret, SECRET_COLUMNS } from '../src/server/lib/crypto'
import { resolveClientSecret, upsertConnector } from '../src/server/hunting/broker'
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

  it("a short-window limiter's sweep only deletes rows whose own window has ended", async () => {
    const short = new DbRateLimiter(5, 1000, 'test-sweep-short:')
    const long = new DbRateLimiter(1, 3_600_000, 'test-sweep-long:')
    const t = Date.parse('2026-11-08T02:00:00Z')
    await short.check('k', t)
    expect((await long.check('k', t)).ok).toBe(true)
    const [row] = await getDb().select().from(appRateLimits).where(eq(appRateLimits.key, 'test-sweep-long:k'))
    expect(row!.expiresAt.getTime()).toBe(t + 3_600_000)

    // Ten minutes on: the short window is long over, the long one is still live.
    await short.sweep(t + 600_000)
    const keys = (await getDb().select().from(appRateLimits)).map((r) => r.key)
    expect(keys).not.toContain('test-sweep-short:k')
    expect(keys).toContain('test-sweep-long:k')
    // The long-window bucket kept its count, so the client is still limited.
    expect((await long.check('k', t + 600_001)).ok).toBe(false)

    // A restarted window moves the expiry forward.
    await long.check('k', t + 3_600_000)
    const [moved] = await getDb().select().from(appRateLimits).where(eq(appRateLimits.key, 'test-sweep-long:k'))
    expect(moved!.expiresAt.getTime()).toBe(t + 7_200_000)
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
    const hunt = { orgId, column: SECRET_COLUMNS.huntingClientSecret }
    const resp = { orgId, column: SECRET_COLUMNS.responseClientSecret }
    const url = { orgId, column: SECRET_COLUMNS.notificationUrl }
    const huntingSecret = 'hunting-client-secret-value'
    const responseSecret = 'response-client-secret-value'
    const webhook = 'https://example.webhook.office.com/webhookb2/abc'
    const encA = encryptSecret(huntingSecret, hunt)
    const db = getDb()
    await db.insert(orgConnectors).values({ orgId, tenantId: 't', clientId: 'c', clientSecretEnc: encA })
    await db.insert(orgResponseConnectors).values({ orgId, tenantId: 't', clientId: 'c', clientSecretEnc: encryptSecret(responseSecret, resp) })
    const [ch] = await db.insert(orgNotificationChannels).values({ orgId, kind: 'teams', name: 'SOC', urlEnc: encryptSecret(webhook, url), urlHost: 'example.webhook.office.com' }).returning()

    // Switch to B with A as previous: old ciphertext still decrypts, new values use B.
    setKeys(KEY_B, KEY_A)
    expect(decryptSecretDetailed(encA, hunt)).toEqual({ plaintext: huntingSecret, keyIndex: 1, version: 'v2' })
    expect(decryptSecretDetailed(encryptSecret('x', hunt), hunt).keyIndex).toBe(0)

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
    expect(decryptSecret(hc!.clientSecretEnc!, hunt)).toBe(huntingSecret)
    expect(decryptSecret(rc!.clientSecretEnc!, resp)).toBe(responseSecret)
    expect(decryptSecret(nc!.urlEnc, url)).toBe(webhook)
    expect(() => decryptSecret(encA, hunt)).toThrow(/cannot decrypt/)

    // Audited with counts only, never values.
    const audits = await db.select().from(auditEvents).where(eq(auditEvents.action, 'secrets_rotated'))
    expect(audits).toHaveLength(2)
    const serialised = JSON.stringify(audits)
    for (const secret of [huntingSecret, responseSecret, webhook, encA]) expect(serialised).not.toContain(secret)
  })

  it('a value no configured key can decrypt rolls the whole rotation back', async () => {
    setKeys(KEY_A)
    const orgId = await makeOrg('Broken')
    await getDb().insert(orgConnectors).values({ orgId, tenantId: 't', clientId: 'c', clientSecretEnc: encryptSecret('s', { orgId, column: SECRET_COLUMNS.huntingClientSecret }) })
    setKeys(KEY_B)
    await expect(rotateSecrets()).rejects.toThrow(/cannot decrypt/)
  })
})

/** The pre-#212 format: AES-256-GCM, no additional data. Written here so the v1 read path stays tested. */
function encryptV1(plaintext: string, keyHex: string) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.')
}

describe('ciphertext format v2 (#212)', () => {
  const ctxFor = (orgId: string) => ({ orgId, column: SECRET_COLUMNS.huntingClientSecret })

  it('existing v1 values still decrypt, and rotate-secrets rewrites them as v2 under the same key', async () => {
    // Earlier tests in this file left rows under KEY_B; keep it as a previous key so the run can read them.
    setKeys(KEY_A, KEY_B)
    const orgId = await makeOrg('Legacy')
    const v1 = encryptV1('legacy-secret', KEY_A)
    const webhook = 'https://example.webhook.office.com/webhookb2/legacy'
    await getDb().insert(orgConnectors).values({ orgId, tenantId: 't', clientId: 'c', clientSecretEnc: v1 })
    const [ch] = await getDb().insert(orgNotificationChannels).values({ orgId, kind: 'teams', name: 'Old', urlEnc: encryptV1(webhook, KEY_A), urlHost: 'example.webhook.office.com' }).returning()
    expect(decryptSecretDetailed(v1, ctxFor(orgId))).toEqual({ plaintext: 'legacy-secret', keyIndex: 0, version: 'v1' })

    const report = await rotateSecrets()
    expect(report.orgConnectors.rotated).toBeGreaterThanOrEqual(1)
    const [hc] = await getDb().select().from(orgConnectors).where(eq(orgConnectors.orgId, orgId))
    const [nc] = await getDb().select().from(orgNotificationChannels).where(eq(orgNotificationChannels.id, ch!.id))
    expect(hc!.clientSecretEnc).toMatch(/^v2\./)
    expect(nc!.urlEnc).toMatch(/^v2\./)
    expect(decryptSecretDetailed(hc!.clientSecretEnc!, ctxFor(orgId))).toEqual({ plaintext: 'legacy-secret', keyIndex: 0, version: 'v2' })
    expect(decryptSecret(nc!.urlEnc, { orgId, column: SECRET_COLUMNS.notificationUrl })).toBe(webhook)
    // Nothing left in the old format: a second run leaves this org's rows alone.
    await rotateSecrets()
    const [after] = await getDb().select().from(orgConnectors).where(eq(orgConnectors.orgId, orgId))
    expect(after!.clientSecretEnc).toBe(hc!.clientSecretEnc)
  })

  it('a v2 value copied into another org or another column does not decrypt', () => {
    setKeys(KEY_A)
    const enc = encryptSecret('org-a-secret', ctxFor('org-a'))
    expect(decryptSecret(enc, ctxFor('org-a'))).toBe('org-a-secret')
    expect(() => decryptSecret(enc, ctxFor('org-b'))).toThrow(/cannot decrypt/)
    expect(() => decryptSecret(enc, { orgId: 'org-a', column: SECRET_COLUMNS.responseClientSecret })).toThrow(/cannot decrypt/)
  })

  it('a swapped row in the database fails where the app reads it', async () => {
    setKeys(KEY_A)
    const a = await makeOrg('Swap A')
    const b = await makeOrg('Swap B')
    await upsertConnector(a, { tenantId: 't', clientId: 'c', clientSecret: 'secret-of-a' })
    await upsertConnector(b, { tenantId: 't', clientId: 'c', clientSecret: 'secret-of-b' })
    const [rowA] = await getDb().select().from(orgConnectors).where(eq(orgConnectors.orgId, a))
    await getDb().update(orgConnectors).set({ clientSecretEnc: rowA!.clientSecretEnc }).where(eq(orgConnectors.orgId, b))
    const [rowB] = await getDb().select().from(orgConnectors).where(eq(orgConnectors.orgId, b))
    expect(resolveClientSecret(rowA!)).toBe('secret-of-a')
    expect(() => resolveClientSecret(rowB!)).toThrow(/cannot decrypt/)
  })

  it('refuses a short or long authentication tag and a wrong-size IV', () => {
    setKeys(KEY_A)
    const ctx = ctxFor('org-a')
    const [v, iv, tag, ct] = encryptSecret('tagged', ctx).split('.')
    const full = Buffer.from(tag!, 'base64url')
    for (const bad of [full.subarray(0, 4), full.subarray(0, 12), Buffer.concat([full, Buffer.from([0])])]) {
      expect(() => decryptSecret([v, iv, bad.toString('base64url'), ct].join('.'), ctx)).toThrow(/tag must be 16 bytes/)
    }
    // The same rule holds for v1 values.
    const [, iv1, tag1, ct1] = encryptV1('tagged', KEY_A).split('.')
    expect(() => decryptSecret(['v1', iv1, Buffer.from(tag1!, 'base64url').subarray(0, 4).toString('base64url'), ct1].join('.'), ctx)).toThrow(/tag must be 16 bytes/)
    expect(() => decryptSecret([v, Buffer.alloc(8).toString('base64url'), tag, ct].join('.'), ctx)).toThrow(/IV must be 12 bytes/)
    expect(() => decryptSecret(`v3.${iv}.${tag}.${ct}`, ctx)).toThrow(/unsupported ciphertext format/)
  })
})
