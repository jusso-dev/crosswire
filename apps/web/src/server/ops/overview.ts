import { and, count, desc, eq, gte, inArray, sql } from 'drizzle-orm'
import { getDb } from '../db/client'
import { env } from '../env'
import { appDay } from '../ti/digest'
import { cveRecords, huntCases, kqlProposals, pwnChanges, pwnIncidents, responseProposals, tiFetchCache, watchEntries, watchHits } from '../db/schema'

const DAY = 86_400_000

/**
 * Control-panel data for the home page. Threat intel tables are global (shared feeds); everything
 * else is filtered by org. Each list is capped so the page stays one fast round trip.
 */
export async function controlPanel(orgId: string, now = new Date()) {
  const db = getDb()
  const since7 = new Date(now.getTime() - 7 * DAY)
  const since30 = new Date(now.getTime() - 30 * DAY)
  const since14 = new Date(now.getTime() - 14 * DAY)

  const [
    emerging,
    changes,
    kev,
    hitsByDay,
    recentHits,
    openHunts,
    closedHunts,
    pendingQueries,
    pendingResponses,
    [kevCount],
    [incidentCount],
    [watchCount],
    feedFreshness,
  ] = await Promise.all([
    // Emerging: live incidents, most severe and most recently updated first.
    db
      .select({ slug: pwnIncidents.slug, title: pwnIncidents.title, severity: pwnIncidents.severity, status: pwnIncidents.status, product: pwnIncidents.product, cveIds: pwnIncidents.cveIds, startedAt: pwnIncidents.startedAt, updatedAt: pwnIncidents.upstreamUpdatedAt, url: pwnIncidents.url })
      .from(pwnIncidents)
      .orderBy(sql`case ${pwnIncidents.status} when 'live' then 0 else 1 end`, sql`case ${pwnIncidents.severity} when 'critical' then 0 when 'high' then 1 when 'medium' then 2 else 3 end`, desc(pwnIncidents.upstreamUpdatedAt))
      .limit(8),
    db
      .select({ id: pwnChanges.id, title: pwnChanges.title, incidentTitle: pwnChanges.incidentTitle, severity: pwnChanges.severity, date: pwnChanges.date, url: pwnChanges.url })
      .from(pwnChanges)
      .orderBy(desc(pwnChanges.date))
      .limit(6),
    db
      .select({ cveId: cveRecords.cveId, vendor: cveRecords.vendor, product: cveRecords.product, title: cveRecords.title, addedAt: cveRecords.publishedAt, dueDate: cveRecords.dueDate, ransomware: cveRecords.knownRansomware })
      .from(cveRecords)
      .where(eq(cveRecords.source, 'cisa-kev'))
      .orderBy(desc(cveRecords.publishedAt))
      .limit(6),
    db
      // Bucket by calendar day in APP_TIMEZONE, matching the digest and every displayed time.
      .select({ day: sql<string>`to_char(${watchHits.createdAt} at time zone ${env().APP_TIMEZONE}, 'YYYY-MM-DD')`, n: count() })
      .from(watchHits)
      .where(and(eq(watchHits.orgId, orgId), gte(watchHits.createdAt, since14)))
      .groupBy(sql`1`)
      .orderBy(sql`1`),
    db
      .select({ id: watchHits.id, title: watchHits.title, source: watchHits.source, url: watchHits.url, cveIds: watchHits.cveIds, createdAt: watchHits.createdAt, entryType: watchEntries.type, entryValue: watchEntries.value })
      .from(watchHits)
      .innerJoin(watchEntries, eq(watchEntries.id, watchHits.entryId))
      .where(eq(watchHits.orgId, orgId))
      .orderBy(desc(watchHits.createdAt))
      .limit(6),
    db.select({ id: huntCases.id, title: huntCases.title, hypothesis: huntCases.hypothesis, updatedAt: huntCases.updatedAt }).from(huntCases).where(and(eq(huntCases.orgId, orgId), eq(huntCases.status, 'open'))).orderBy(desc(huntCases.updatedAt)).limit(6),
    db.select({ id: huntCases.id, title: huntCases.title, updatedAt: huntCases.updatedAt }).from(huntCases).where(and(eq(huntCases.orgId, orgId), eq(huntCases.status, 'closed'), gte(huntCases.updatedAt, since30))).orderBy(desc(huntCases.updatedAt)).limit(5),
    db
      .select({ id: kqlProposals.id, huntId: kqlProposals.huntId, target: kqlProposals.target, createdAt: kqlProposals.createdAt, huntTitle: huntCases.title })
      .from(kqlProposals)
      .innerJoin(huntCases, eq(huntCases.id, kqlProposals.huntId))
      .where(and(eq(kqlProposals.orgId, orgId), eq(kqlProposals.status, 'proposed')))
      .orderBy(desc(kqlProposals.createdAt))
      .limit(5),
    db
      .select({ id: responseProposals.id, title: responseProposals.title, actionType: responseProposals.actionType, blastRadius: responseProposals.blastRadius, createdAt: responseProposals.createdAt })
      .from(responseProposals)
      .where(and(eq(responseProposals.orgId, orgId), inArray(responseProposals.status, ['pending', 'approved'])))
      .orderBy(desc(responseProposals.createdAt))
      .limit(5),
    db.select({ n: count() }).from(cveRecords).where(eq(cveRecords.source, 'cisa-kev')),
    db.select({ n: count() }).from(pwnIncidents).where(eq(pwnIncidents.status, 'live')),
    db.select({ n: count() }).from(watchEntries).where(and(eq(watchEntries.orgId, orgId), sql`${watchEntries.disabledAt} is null`)),
    db.select({ url: tiFetchCache.url, fetchedAt: tiFetchCache.fetchedAt, status: tiFetchCache.status }).from(tiFetchCache),
  ])

  const [hits7] = await db.select({ n: count() }).from(watchHits).where(and(eq(watchHits.orgId, orgId), gte(watchHits.createdAt, since7)))

  const feedAt = (match: (u: string) => boolean) => {
    const rows = feedFreshness.filter((f) => match(f.url))
    const latest = rows.reduce<Date | null>((acc, r) => (!acc || r.fetchedAt > acc ? r.fetchedAt : acc), null)
    return { lastFetchedAt: latest?.toISOString() ?? null, ok: rows.length > 0 && rows.every((r) => r.status < 400) }
  }

  const iso = (d: Date | null) => d?.toISOString() ?? null
  return {
    totals: { liveIncidents: incidentCount?.n ?? 0, kevTotal: kevCount?.n ?? 0, watches: watchCount?.n ?? 0, hits7: hits7?.n ?? 0, openHunts: openHunts.length, awaitingDecision: pendingQueries.length + pendingResponses.length },
    feeds: { pwnwatch: feedAt((u) => u.includes('pwn.watch')), kev: feedAt((u) => u.includes('known_exploited')) },
    emerging,
    changes,
    kev,
    hitsByDay,
    // The 14 calendar days (oldest first) the chart covers, so client and server agree on "today".
    chartDays: Array.from({ length: 14 }, (_, i) => appDay(new Date(now.getTime() - (13 - i) * DAY))),
    timeZone: env().APP_TIMEZONE,
    recentHits: recentHits.map((h) => ({ ...h, createdAt: h.createdAt.toISOString() })),
    openHunts: openHunts.map((h) => ({ ...h, updatedAt: h.updatedAt.toISOString() })),
    closedHunts: closedHunts.map((h) => ({ ...h, updatedAt: h.updatedAt.toISOString() })),
    pendingQueries: pendingQueries.map((q) => ({ ...q, createdAt: q.createdAt.toISOString() })),
    pendingResponses: pendingResponses.map((r) => ({ ...r, createdAt: iso(r.createdAt) })),
  }
}
