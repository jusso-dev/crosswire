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

/**
 * Bounds of a YYYY-MM-DD day in `tz` (APP_TIMEZONE by default): from the first instant whose local
 * date is that day, to the first instant of the next day. DST-safe, including zones where local
 * midnight does not exist on the change day (the day then starts at 01:00).
 */
export function dayBounds(day: string, tz = env().APP_TIMEZONE) {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number]
  const dayStart = (yy: number, mm: number, dd: number) => {
    const target = new Date(Date.UTC(yy, mm - 1, dd)).toISOString().slice(0, 10)
    // Candidate: local midnight with the offset in force around then.
    const guess = Date.UTC(yy, mm - 1, dd)
    let t = guess - zoneOffsetMs(guess - zoneOffsetMs(guess, tz), tz)
    // If that instant falls on the previous local day (midnight skipped), step forward to the change.
    if (appDay(new Date(t), tz) < target) {
      let lo = t
      let hi = t + 3 * 3_600_000
      while (hi - lo > 1000) {
        const mid = Math.floor((lo + hi) / 2)
        if (appDay(new Date(mid), tz) < target) lo = mid
        else hi = mid
      }
      t = hi - (hi % 1000)
    }
    // If it is already inside the day (midnight repeated earlier), step back to its first instant.
    while (appDay(new Date(t - 1000), tz) === target) t -= 1000
    return new Date(t)
  }
  return { start: dayStart(y, m, d), end: dayStart(y, m, d + 1) }
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
 * Recipients always come from that org's own membership, never from global config: each owner's
 * confirmed digest address, or their sign-in email (#102).
 *
 * Each send runs in a transaction that holds the digest row (`for update skip locked`) and sets
 * `emailed_at` only once the mail is accepted (#197). A concurrent run skips a row that is being
 * sent. A failed send, or a process killed mid-send, leaves `emailed_at` empty (the transaction
 * rolls back with the connection), so the next run retries that org-day instead of losing it.
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
    try {
      const sent = await db.transaction(async (tx) => {
        const [held] = await tx
          .select({ id: digests.id })
          .from(digests)
          .where(and(eq(digests.id, digest.id), isNull(digests.emailedAt)))
          .for('update', { skipLocked: true })
        // Already sent, or another run is sending it now.
        if (!held) return false
        if (!(await sendMail(recipients, subject, text))) return false
        await tx.update(digests).set({ emailedAt: new Date() }).where(eq(digests.id, digest.id))
        return true
      })
      if (sent) emailed++
    } catch (err) {
      failed++
      logger.error('digest email failed', { orgId: org.id, error: err instanceof Error ? err.message : String(err) })
    }
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
