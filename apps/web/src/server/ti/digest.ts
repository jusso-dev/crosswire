import { and, desc, eq, gte, isNull, lt } from 'drizzle-orm'
import { getDb } from '../db/client'
import { digests, orgs, watchEntries, watchHits } from '../db/schema'
import { env } from '../env'
import { listOrgOwnerEmails } from '../orgs'
import { sendMail } from '../mail'
import { logger } from '../lib/logger'

/** Offset (ms) of `tz` from UTC at instant `at`: wall-clock time minus UTC. */
function zoneOffsetMs(at: number, tz: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(at))
      .map((p) => [p.type, p.value]),
  )
  return Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, +parts.hour!, +parts.minute!, +parts.second!) - (at - (at % 1000))
}

/** Midnight-to-midnight bounds of a YYYY-MM-DD day in `tz` (APP_TIMEZONE by default). DST-safe. */
export function dayBounds(day: string, tz = env().APP_TIMEZONE) {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number]
  const midnight = (yy: number, mm: number, dd: number) => {
    const guess = Date.UTC(yy, mm - 1, dd)
    const first = guess - zoneOffsetMs(guess, tz)
    return new Date(guess - zoneOffsetMs(first, tz))
  }
  return { start: midnight(y, m, d), end: midnight(y, m, d + 1) }
}

/** The calendar day (YYYY-MM-DD) of `d` in `tz`. Digests are stored per APP_TIMEZONE day. */
export function appDay(d = new Date(), tz = env().APP_TIMEZONE) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
}

/** Build (or rebuild) one org's digest for an APP_TIMEZONE day (#40). Empty days produce a quiet digest. */
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
    `Daily watch digest for ${orgName} (${digest.day}, ${env().APP_TIMEZONE}).`,
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
export async function runDailyDigest(day = appDay()) {
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
export async function refreshTodayDigests(day = appDay()) {
  const all = await getDb().select({ id: orgs.id }).from(orgs)
  for (const org of all) await buildDigest(org.id, day)
  return { day, orgs: all.length }
}

export async function listDigests(orgId: string, limit = 14) {
  return getDb().select().from(digests).where(eq(digests.orgId, orgId)).orderBy(desc(digests.day)).limit(limit)
}
