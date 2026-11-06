import { and, desc, eq, gte, isNull, lt } from 'drizzle-orm'
import { getDb } from '../db/client'
import { digests, orgs, watchEntries, watchHits } from '../db/schema'
import { env } from '../env'
import { listOrgOwnerEmails } from '../orgs'
import { sendMail } from '../mail'
import { logger } from '../lib/logger'

/** UTC day boundaries for a YYYY-MM-DD string. Digests are stored per UTC day. */
export function dayBounds(day: string) {
  const start = new Date(`${day}T00:00:00.000Z`)
  return { start, end: new Date(start.getTime() + 86_400_000) }
}

export function utcDay(d = new Date()) {
  return d.toISOString().slice(0, 10)
}

/** Build (or rebuild) one org's digest for a UTC day (#40). Empty days produce a quiet digest. */
export async function buildDigest(orgId: string, day: string) {
  const db = getDb()
  const { start, end } = dayBounds(day)
  const hits = await db
    .select({ id: watchHits.id, title: watchHits.title, url: watchHits.url, source: watchHits.source, entry: watchEntries.value })
    .from(watchHits)
    .innerJoin(watchEntries, eq(watchEntries.id, watchHits.entryId))
    .where(and(eq(watchHits.orgId, orgId), gte(watchHits.createdAt, start), lt(watchHits.createdAt, end)))
  const items = hits.slice(0, 50).map((h) => ({ hitId: h.id, title: h.title, url: h.url, source: h.source, entry: h.entry }))
  const [row] = await db
    .insert(digests)
    .values({ orgId, day, hitCount: hits.length, items })
    .onConflictDoUpdate({ target: [digests.orgId, digests.day], set: { hitCount: hits.length, items } })
    .returning()
  return row!
}

export function renderDigestEmail(orgName: string, digest: { day: string; hitCount: number; items: Array<{ title: string; source: string; entry: string }> }) {
  const appUrl = env().APP_URL.replace(/\/$/, '')
  const subject = `Crosswire daily digest ${digest.day}: ${digest.hitCount} watch hit${digest.hitCount === 1 ? '' : 's'}`
  const lines = [
    `Daily watch digest for ${orgName} (${digest.day}, UTC).`,
    '',
    digest.hitCount === 0 ? 'No new watch hits today.' : `${digest.hitCount} new watch hit(s):`,
    ...digest.items.slice(0, 20).map((i) => `- ${i.title} (${i.source}, matched "${i.entry}")`),
    '',
    `Open the digest: ${appUrl}/app/digests`,
    '',
    'Sources: pwn.watch (https://pwn.watch), CISA KEV.',
  ]
  return { subject, text: lines.join('\n') }
}

/**
 * Daily job: build digests for every org; email owners when SMTP is configured.
 * Idempotent: `emailed_at` guards against double-sending for the same org-day.
 * Recipients always come from that org's own membership, never from global config.
 */
export async function runDailyDigest(day = utcDay()) {
  const db = getDb()
  const all = await db.select({ id: orgs.id, name: orgs.name }).from(orgs)
  let built = 0
  let emailed = 0
  let failed = 0
  for (const org of all) {
    const digest = await buildDigest(org.id, day)
    built++
    if (digest.emailedAt) continue
    const recipients = await listOrgOwnerEmails(org.id)
    const { subject, text } = renderDigestEmail(org.name, digest)
    // Claim the send first so a concurrent or repeated run cannot double-send.
    const claimed = await db
      .update(digests)
      .set({ emailedAt: new Date() })
      .where(and(eq(digests.id, digest.id), isNull(digests.emailedAt)))
      .returning({ id: digests.id })
    if (claimed.length === 0) continue
    let sent = false
    try {
      sent = await sendMail(recipients, subject, text)
    } catch (err) {
      failed++
      logger.error('digest email failed', { orgId: org.id, error: err instanceof Error ? err.message : String(err) })
    }
    if (sent) emailed++
    // Release the claim so the next run retries this org-day.
    else await db.update(digests).set({ emailedAt: null }).where(eq(digests.id, digest.id))
  }
  logger.info('daily digest complete', { day, built, emailed, failed })
  return { day, built, emailed, failed }
}

/** Refresh today's in-app digest for every org (no email). Lets the UI show today's hits. */
export async function refreshTodayDigests(day = utcDay()) {
  const all = await getDb().select({ id: orgs.id }).from(orgs)
  for (const org of all) await buildDigest(org.id, day)
  return { day, orgs: all.length }
}

export async function listDigests(orgId: string, limit = 14) {
  return getDb().select().from(digests).where(eq(digests.orgId, orgId)).orderBy(desc(digests.day)).limit(limit)
}
