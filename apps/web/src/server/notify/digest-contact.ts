import { createHash, randomBytes } from 'node:crypto'
import { and, eq, isNull, lte, or } from 'drizzle-orm'
import { z } from 'zod'
import { getDb } from '../db/client'
import { account, orgMemberships, orgs, user } from '../db/schema'
import { env } from '../env'
import { writeAudit } from '../audit'
import { sendMail, smtpConfigured } from '../mail'
import { logger } from '../lib/logger'

/**
 * Digest contact address (#102). Each owner can send their digest email to an address other than
 * their sign-in email (an Entra UPN often has no mailbox). The address only takes effect once the
 * owner opens a confirmation link sent to it, while signed in as themselves.
 *
 * Only a SHA-256 hash of the emailed token is stored. Audit events record the address's domain,
 * never the full address or the token.
 */

export const DIGEST_TOKEN_TTL_MS = 24 * 60 * 60 * 1000
/** A new request is refused while the previous link is younger than this. */
export const DIGEST_RESEND_MS = 60 * 1000
export const DIGEST_CONFIRM_PATH = '/app/settings/digest-email/confirm'

/** Expected, user-facing failures. The message is safe to show. */
export class DigestEmailError extends Error {}

export const digestEmailSchema = z.string().trim().toLowerCase().pipe(z.email('Enter a valid email address.').max(254, 'Email addresses can be at most 254 characters.'))

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')
const domainOf = (email: string) => email.slice(email.lastIndexOf('@') + 1)

export function confirmUrl(token: string) {
  return `${env().APP_URL.replace(/\/$/, '')}${DIGEST_CONFIRM_PATH}?token=${encodeURIComponent(token)}`
}

async function ownerMembership(orgId: string, userId: string) {
  const [row] = await getDb()
    .select({ id: orgMemberships.id, role: orgMemberships.role, digestEmail: orgMemberships.digestEmail, orgName: orgs.name })
    .from(orgMemberships)
    .innerJoin(orgs, eq(orgs.id, orgMemberships.orgId))
    .where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.userId, userId)))
    .limit(1)
  if (!row || row.role !== 'owner') throw new DigestEmailError('Only owners receive digest email.')
  return row
}

/**
 * Start confirming a new digest address: store the pending address with a hashed token and email
 * the link to the new address. Refused when SMTP is off (nothing is saved) or a link was sent in
 * the last minute.
 */
export async function requestDigestEmail(orgId: string, userId: string, rawEmail: string, now = new Date()) {
  const parsed = digestEmailSchema.safeParse(rawEmail)
  if (!parsed.success) throw new DigestEmailError(parsed.error.issues[0]?.message ?? 'Enter a valid email address.')
  const email = parsed.data
  const m = await ownerMembership(orgId, userId)
  if (m.digestEmail === email) throw new DigestEmailError('Digests already go to that address.')
  if (!smtpConfigured()) throw new DigestEmailError('Email is not set up on this Crosswire server, so the address cannot be confirmed. Ask your administrator to configure SMTP, then try again.')

  const token = randomBytes(32).toString('base64url')
  const tokenHash = hashToken(token)
  const expiresAt = new Date(now.getTime() + DIGEST_TOKEN_TTL_MS)
  // A link issued at T expires at T + TTL, so "issued over a minute ago" means expiry <= now + TTL - resend window.
  const resendCutoff = new Date(now.getTime() + DIGEST_TOKEN_TTL_MS - DIGEST_RESEND_MS)
  const db = getDb()
  const claimed = await db
    .update(orgMemberships)
    .set({ digestEmailPending: email, digestEmailTokenHash: tokenHash, digestEmailTokenExpiresAt: expiresAt })
    .where(and(eq(orgMemberships.id, m.id), or(isNull(orgMemberships.digestEmailTokenExpiresAt), lte(orgMemberships.digestEmailTokenExpiresAt, resendCutoff))))
    .returning({ id: orgMemberships.id })
  if (claimed.length === 0) throw new DigestEmailError('A confirmation link was sent less than a minute ago. Wait a minute before sending another.')

  const text = [
    `An owner of ${m.orgName} in Crosswire asked to receive the daily digest email at this address.`,
    '',
    'To confirm, open this link while signed in to Crosswire:',
    confirmUrl(token),
    '',
    'The link expires in 24 hours. If you did not ask for this, you can ignore this email and nothing will change.',
  ].join('\n')
  let sent = false
  try {
    sent = await sendMail([email], 'Confirm your Crosswire digest email address', text)
  } catch (err) {
    logger.error('digest confirmation email failed', { orgId, error: err instanceof Error ? err.message : String(err) })
  }
  if (!sent) {
    // Undo the pending state, so nothing waits on an email that never left.
    await db
      .update(orgMemberships)
      .set({ digestEmailPending: null, digestEmailTokenHash: null, digestEmailTokenExpiresAt: null })
      .where(and(eq(orgMemberships.id, m.id), eq(orgMemberships.digestEmailTokenHash, tokenHash)))
    throw new DigestEmailError('The confirmation email could not be sent. Check the address and try again later.')
  }

  await writeAudit({ category: 'auth', action: 'digest_email_requested', actorType: 'user', actorId: userId, orgId, targetType: 'org_membership', targetId: m.id, data: { domain: domainOf(email) } })
  return { pending: email, expiresAt }
}

type TokenLookup = { status: 'invalid' } | { status: 'expired'; membershipId: string; orgId: string } | { status: 'ready'; membershipId: string; orgId: string; orgName: string; email: string; tokenHash: string; expiresAt: Date }

/** Find the signed-in user's pending request for this token. Another user's token is simply invalid. */
async function lookupToken(userId: string, token: string, now: Date): Promise<TokenLookup> {
  if (!TOKEN_RE.test(token)) return { status: 'invalid' }
  const tokenHash = hashToken(token)
  const [row] = await getDb()
    .select({ id: orgMemberships.id, orgId: orgMemberships.orgId, orgName: orgs.name, pending: orgMemberships.digestEmailPending, hash: orgMemberships.digestEmailTokenHash, expiresAt: orgMemberships.digestEmailTokenExpiresAt })
    .from(orgMemberships)
    .innerJoin(orgs, eq(orgs.id, orgMemberships.orgId))
    .where(and(eq(orgMemberships.userId, userId), eq(orgMemberships.digestEmailTokenHash, tokenHash)))
    .limit(1)
  if (!row?.hash || !row.pending || !row.expiresAt) return { status: 'invalid' }
  if (row.expiresAt.getTime() <= now.getTime()) return { status: 'expired', membershipId: row.id, orgId: row.orgId }
  return { status: 'ready', membershipId: row.id, orgId: row.orgId, orgName: row.orgName, email: row.pending, tokenHash, expiresAt: row.expiresAt }
}

const INVALID = 'This confirmation link is not valid for your account. It may have been used already, a newer link may have been sent, or you may be signed in as someone else.'
const EXPIRED = 'This confirmation link has expired. Send a new one from Settings.'

/** What the confirmation page shows before the user confirms. Read-only. */
export async function previewDigestEmail(userId: string, token: string, now = new Date()) {
  const r = await lookupToken(userId, token, now)
  if (r.status === 'ready') return { status: 'ready' as const, email: r.email, orgName: r.orgName }
  return { status: r.status, message: r.status === 'expired' ? EXPIRED : INVALID }
}

/** Confirm the pending address for the signed-in user: it becomes the digest address. */
export async function confirmDigestEmail(userId: string, token: string, now = new Date()) {
  const r = await lookupToken(userId, token, now)
  const db = getDb()
  if (r.status === 'invalid') throw new DigestEmailError(INVALID)
  if (r.status === 'expired') {
    await db.update(orgMemberships).set({ digestEmailPending: null, digestEmailTokenHash: null, digestEmailTokenExpiresAt: null }).where(eq(orgMemberships.id, r.membershipId))
    throw new DigestEmailError(EXPIRED)
  }
  const done = await db
    .update(orgMemberships)
    .set({ digestEmail: r.email, digestEmailPending: null, digestEmailTokenHash: null, digestEmailTokenExpiresAt: null })
    .where(and(eq(orgMemberships.id, r.membershipId), eq(orgMemberships.digestEmailTokenHash, r.tokenHash)))
    .returning({ id: orgMemberships.id })
  // Lost a race with another confirm, clear or new request.
  if (done.length === 0) throw new DigestEmailError(INVALID)
  await writeAudit({ category: 'auth', action: 'digest_email_confirmed', actorType: 'user', actorId: userId, orgId: r.orgId, targetType: 'org_membership', targetId: r.membershipId, data: { domain: domainOf(r.email) } })
  return { orgId: r.orgId, email: r.email }
}

/** Go back to the sign-in email: clears the confirmed address and any pending request. */
export async function clearDigestEmail(orgId: string, userId: string) {
  const [row] = await getDb()
    .update(orgMemberships)
    .set({ digestEmail: null, digestEmailPending: null, digestEmailTokenHash: null, digestEmailTokenExpiresAt: null })
    .where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.userId, userId)))
    .returning({ id: orgMemberships.id })
  if (!row) throw new DigestEmailError('You are not a member of this organisation.')
  await writeAudit({ category: 'auth', action: 'digest_email_cleared', actorType: 'user', actorId: userId, orgId, targetType: 'org_membership', targetId: row.id })
}

/** Settings view for the signed-in owner. The token hash never leaves the server. */
export async function getDigestEmailView(orgId: string, userId: string, now = new Date()) {
  const db = getDb()
  const [row] = await db
    .select({
      signInEmail: user.email,
      emailVerified: user.emailVerified,
      digestEmail: orgMemberships.digestEmail,
      pending: orgMemberships.digestEmailPending,
      expiresAt: orgMemberships.digestEmailTokenExpiresAt,
    })
    .from(orgMemberships)
    .innerJoin(user, eq(user.id, orgMemberships.userId))
    .where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.userId, userId)))
    .limit(1)
  if (!row) return null
  // An unverified email on a Microsoft account is usually the UPN fallback (#100), which may have no mailbox.
  const [ms] = row.emailVerified ? [] : await db.select({ id: account.id }).from(account).where(and(eq(account.userId, userId), eq(account.providerId, 'microsoft'))).limit(1)
  const live = row.pending && row.expiresAt && row.expiresAt.getTime() > now.getTime()
  return {
    signInEmail: row.signInEmail,
    signInMayBeUpn: Boolean(ms),
    digestEmail: row.digestEmail,
    pending: live ? { email: row.pending!, expiresAt: row.expiresAt!.toISOString() } : null,
    smtp: smtpConfigured(),
  }
}
