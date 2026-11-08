import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { getDb } from '../src/server/db/client'
import { account, auditEvents, orgMemberships, user } from '../src/server/db/schema'
import * as mail from '../src/server/mail'
import { listOrgOwnerEmails } from '../src/server/orgs'
import { runDailyDigest, appDay } from '../src/server/ti/digest'
import { clearDigestEmail, confirmDigestEmail, DIGEST_CONFIRM_PATH, DIGEST_RESEND_MS, DIGEST_TOKEN_TTL_MS, DigestEmailError, getDigestEmailView, previewDigestEmail, requestDigestEmail } from '../src/server/notify/digest-contact'
import { makeOrg, makeUser, member } from './helpers'

/** Pull the token out of the confirmation link in the last email sent. */
function tokenFrom(send: { mock: { calls: unknown[][] } }) {
  const text = send.mock.calls.at(-1)![2] as string
  const link = text.split(/\s+/).find((w) => w.includes(`${DIGEST_CONFIRM_PATH}?token=`))
  const m = link ? /[?&]token=([A-Za-z0-9_-]+)/.exec(link) : null
  expect(m).not.toBeNull()
  return m![1]!
}

async function membership(orgId: string, userId: string) {
  const [row] = await getDb().select().from(orgMemberships).where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.userId, userId)))
  return row!
}

async function auditFor(orgId: string, action: string) {
  return getDb().select().from(auditEvents).where(and(eq(auditEvents.orgId, orgId), eq(auditEvents.action, action)))
}

describe('digest contact address (#102)', () => {
  let send: ReturnType<typeof vi.fn<typeof mail.sendMail>>
  beforeEach(() => {
    vi.spyOn(mail, 'smtpConfigured').mockReturnValue(true)
    send = vi.spyOn(mail, 'sendMail').mockResolvedValue(true)
  })
  afterEach(() => vi.restoreAllMocks())

  async function owner(email?: string) {
    const orgId = await makeOrg('Digest')
    const userId = await makeUser(email)
    await member(orgId, userId, 'owner')
    return { orgId, userId }
  }

  it('request stores a hashed token and a pending address, and emails the link to the new address', async () => {
    const { orgId, userId } = await owner()
    const now = new Date('2026-11-08T00:00:00Z')
    const r = await requestDigestEmail(orgId, userId, '  Alerts@Contoso.example ', now)
    expect(r.pending).toBe('alerts@contoso.example')
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]![0]).toEqual(['alerts@contoso.example'])
    const token = tokenFrom(send)
    expect(Buffer.from(token, 'base64url')).toHaveLength(32)

    const row = await membership(orgId, userId)
    expect(row.digestEmail).toBeNull()
    expect(row.digestEmailPending).toBe('alerts@contoso.example')
    expect(row.digestEmailTokenHash).toMatch(/^[0-9a-f]{64}$/)
    expect(row.digestEmailTokenHash).not.toContain(token)
    expect(row.digestEmailTokenExpiresAt!.getTime()).toBe(now.getTime() + DIGEST_TOKEN_TTL_MS)

    const [ev] = await auditFor(orgId, 'digest_email_requested')
    expect(ev!.category).toBe('auth')
    expect(ev!.data).toEqual({ domain: 'contoso.example' })
    expect(JSON.stringify(ev)).not.toContain('alerts@')
    expect(JSON.stringify(ev)).not.toContain(token)
  })

  it('rejects invalid and over-long addresses, and non-owners', async () => {
    const { orgId, userId } = await owner()
    await expect(requestDigestEmail(orgId, userId, 'not-an-address')).rejects.toBeInstanceOf(DigestEmailError)
    await expect(requestDigestEmail(orgId, userId, `${'a'.repeat(250)}@x.example`)).rejects.toThrow(/254/)
    const analyst = await makeUser()
    await member(orgId, analyst, 'analyst')
    await expect(requestDigestEmail(orgId, analyst, 'a@b.example')).rejects.toThrow(/Only owners/)
    expect(send).not.toHaveBeenCalled()
  })

  it('confirm moves pending to the digest address for the signed-in user only', async () => {
    const { orgId, userId } = await owner()
    await requestDigestEmail(orgId, userId, 'soc@contoso.example')
    const token = tokenFrom(send)

    // Someone else signed in cannot see or use the link.
    const other = await makeUser()
    await member(orgId, other, 'owner')
    expect((await previewDigestEmail(other, token)).status).toBe('invalid')
    await expect(confirmDigestEmail(other, token)).rejects.toThrow(/not valid for your account/)
    expect((await membership(orgId, other)).digestEmail).toBeNull()

    expect(await previewDigestEmail(userId, token)).toMatchObject({ status: 'ready', email: 'soc@contoso.example' })
    const r = await confirmDigestEmail(userId, token)
    expect(r).toEqual({ orgId, email: 'soc@contoso.example' })
    const row = await membership(orgId, userId)
    expect(row.digestEmail).toBe('soc@contoso.example')
    expect(row.digestEmailPending).toBeNull()
    expect(row.digestEmailTokenHash).toBeNull()
    expect(row.digestEmailTokenExpiresAt).toBeNull()

    const [ev] = await auditFor(orgId, 'digest_email_confirmed')
    expect(ev!.data).toEqual({ domain: 'contoso.example' })

    // A link works once.
    await expect(confirmDigestEmail(userId, token)).rejects.toThrow(/not valid/)
    // Garbage tokens are invalid, not errors.
    await expect(confirmDigestEmail(userId, 'x')).rejects.toThrow(/not valid/)
  })

  it('an expired link is refused and cleared', async () => {
    const { orgId, userId } = await owner()
    const t0 = new Date('2026-11-01T00:00:00Z')
    await requestDigestEmail(orgId, userId, 'late@contoso.example', t0)
    const token = tokenFrom(send)
    const later = new Date(t0.getTime() + DIGEST_TOKEN_TTL_MS + 1)
    expect((await previewDigestEmail(userId, token, later)).status).toBe('expired')
    await expect(confirmDigestEmail(userId, token, later)).rejects.toThrow(/expired/)
    const row = await membership(orgId, userId)
    expect(row.digestEmail).toBeNull()
    expect(row.digestEmailPending).toBeNull()
    expect(row.digestEmailTokenHash).toBeNull()
  })

  it('refuses a new request within 60 s of the last, then allows it; the newer link replaces the older', async () => {
    const { orgId, userId } = await owner()
    const t0 = new Date('2026-11-02T00:00:00Z')
    await requestDigestEmail(orgId, userId, 'first@contoso.example', t0)
    const first = tokenFrom(send)
    await expect(requestDigestEmail(orgId, userId, 'second@contoso.example', new Date(t0.getTime() + 30_000))).rejects.toThrow(/less than a minute ago/)
    expect(send).toHaveBeenCalledTimes(1)
    expect((await membership(orgId, userId)).digestEmailPending).toBe('first@contoso.example')

    const t1 = new Date(t0.getTime() + DIGEST_RESEND_MS)
    await requestDigestEmail(orgId, userId, 'second@contoso.example', t1)
    const second = tokenFrom(send)
    await expect(confirmDigestEmail(userId, first, t1)).rejects.toThrow(/not valid/)
    expect((await confirmDigestEmail(userId, second, t1)).email).toBe('second@contoso.example')
  })

  it('refuses with a clear error and saves nothing when SMTP is not configured', async () => {
    vi.spyOn(mail, 'smtpConfigured').mockReturnValue(false)
    const { orgId, userId } = await owner()
    await expect(requestDigestEmail(orgId, userId, 'x@contoso.example')).rejects.toThrow(/Email is not set up.*cannot be confirmed/)
    expect(send).not.toHaveBeenCalled()
    const row = await membership(orgId, userId)
    expect(row.digestEmail).toBeNull()
    expect(row.digestEmailPending).toBeNull()
    expect(await auditFor(orgId, 'digest_email_requested')).toHaveLength(0)
  })

  it('a failed send leaves nothing pending, so the owner can retry at once', async () => {
    send.mockRejectedValueOnce(new Error('smtp down'))
    const { orgId, userId } = await owner()
    await expect(requestDigestEmail(orgId, userId, 'x@contoso.example')).rejects.toThrow(/could not be sent/)
    expect((await membership(orgId, userId)).digestEmailPending).toBeNull()
    await requestDigestEmail(orgId, userId, 'x@contoso.example')
    expect((await membership(orgId, userId)).digestEmailPending).toBe('x@contoso.example')
  })

  it('clear goes back to the sign-in email and records an audit event with no address', async () => {
    const { orgId, userId } = await owner()
    await requestDigestEmail(orgId, userId, 'soc@contoso.example')
    await confirmDigestEmail(userId, tokenFrom(send))
    await clearDigestEmail(orgId, userId)
    const row = await membership(orgId, userId)
    expect(row.digestEmail).toBeNull()
    expect(row.digestEmailPending).toBeNull()
    const [ev] = await auditFor(orgId, 'digest_email_cleared')
    expect(ev!.category).toBe('auth')
    expect(JSON.stringify(ev!.data)).not.toContain('@')
  })

  it('recipients are COALESCE(digest_email, user.email) per owner, scoped to the org', async () => {
    const orgA = await makeOrg('RecipA')
    const orgB = await makeOrg('RecipB')
    const o1 = await makeUser('o1-recip@example.test')
    const o2 = await makeUser('o2-recip@example.test')
    const analyst = await makeUser('an-recip@example.test')
    await member(orgA, o1, 'owner')
    await member(orgA, o2, 'owner')
    await member(orgA, analyst, 'analyst')
    await member(orgB, o1, 'owner')

    await requestDigestEmail(orgA, o1, 'o1-soc@contoso.example')
    await confirmDigestEmail(o1, tokenFrom(send))
    // A pending, unconfirmed address is never used.
    await requestDigestEmail(orgA, o2, 'o2-pending@contoso.example')

    expect((await listOrgOwnerEmails(orgA)).sort()).toEqual(['o1-soc@contoso.example', 'o2-recip@example.test'])
    // The digest address is per membership: o1 still gets org B's digest at the sign-in email.
    expect(await listOrgOwnerEmails(orgB)).toEqual(['o1-recip@example.test'])

    send.mockClear()
    await runDailyDigest(appDay())
    const toA = send.mock.calls.find((c) => (c[0] as string[]).includes('o1-soc@contoso.example'))
    expect(toA).toBeDefined()
    expect(toA![0]).not.toContain('o1-recip@example.test')
  })

  it('settings view shows the delivery address, a live pending request and the UPN note', async () => {
    const { orgId, userId } = await owner()
    await getDb().update(user).set({ emailVerified: false }).where(eq(user.id, userId))
    await getDb().insert(account).values({ id: crypto.randomUUID(), accountId: 'ms-1', providerId: 'microsoft', userId })
    let v = await getDigestEmailView(orgId, userId)
    expect(v).toMatchObject({ digestEmail: null, pending: null, signInMayBeUpn: true, smtp: true })

    const now = new Date()
    await requestDigestEmail(orgId, userId, 'p@contoso.example', now)
    v = await getDigestEmailView(orgId, userId, now)
    expect(v!.pending).toMatchObject({ email: 'p@contoso.example' })
    expect(JSON.stringify(v)).not.toMatch(/[0-9a-f]{64}/)
    // Once expired, the pending state is no longer shown.
    v = await getDigestEmailView(orgId, userId, new Date(now.getTime() + DIGEST_TOKEN_TTL_MS + 1))
    expect(v!.pending).toBeNull()
  })
})
