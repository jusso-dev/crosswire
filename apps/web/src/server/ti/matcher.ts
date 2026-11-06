import { isNull } from 'drizzle-orm'
import { getDb } from '../db/client'
import { cveRecords, pwnIncidents, watchEntries, watchHits } from '../db/schema'
import { logger } from '../lib/logger'
import { truncate } from '../lib/redact'

export interface TiRecord {
  source: string
  sourceId: string
  title: string
  text: string
  url: string | null
  cveIds: string[]
  tags: string[]
  vendors: string[]
}

type Entry = Pick<typeof watchEntries.$inferSelect, 'id' | 'orgId' | 'type' | 'normalized'>

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Pure matching rules (#39):
 * - cve: exact (normalised upper-case) match on the record's CVE list
 * - tag: exact match on tags
 * - vendor: case-insensitive whole-word match on vendor/product fields, then title
 * - keyword: case-insensitive whole-token match in title + text (min length enforced at entry time)
 * Returns a snippet when matched, otherwise null.
 */
export function matchRecord(entry: Pick<Entry, 'type' | 'normalized'>, rec: TiRecord): string | null {
  const v = entry.normalized
  switch (entry.type) {
    case 'cve':
      return rec.cveIds.includes(v) ? `Mentions ${v}` : null
    case 'tag':
      return rec.tags.includes(v) ? `Tagged ${v}` : null
    case 'vendor': {
      const re = new RegExp(`(^|[^a-z0-9])${escapeRe(v)}($|[^a-z0-9])`, 'i')
      const hit = rec.vendors.find((x) => re.test(x)) ?? (re.test(rec.title) ? rec.title : null)
      return hit ? `Vendor/product: ${truncate(hit, 200)}` : null
    }
    case 'keyword': {
      const re = new RegExp(`(^|[^a-z0-9])${escapeRe(v)}($|[^a-z0-9])`, 'i')
      const hay = `${rec.title}\n${rec.text}`
      const m = re.exec(hay)
      if (!m) return null
      const start = Math.max(0, m.index - 80)
      return `…${hay.slice(start, m.index + v.length + 100).replace(/\s+/g, ' ')}…`
    }
  }
}

async function loadRecords(): Promise<TiRecord[]> {
  const db = getDb()
  const incidents = await db.select().from(pwnIncidents)
  const cves = await db.select().from(cveRecords)
  return [
    ...incidents.map((i) => ({
      source: 'pwn.watch',
      sourceId: i.slug,
      title: i.title,
      text: i.summary,
      url: i.url,
      cveIds: i.cveIds,
      tags: i.tags,
      vendors: [i.product ?? ''].filter(Boolean),
    })),
    ...cves.map((c) => ({
      source: c.source,
      sourceId: c.cveId,
      title: `${c.cveId}: ${c.title ?? ''}`.trim(),
      text: c.description ?? '',
      url: c.url,
      cveIds: [c.cveId],
      tags: [],
      vendors: [c.vendor ?? '', c.product ?? ''].filter(Boolean),
    })),
  ]
}

export interface MatchStats {
  entries: number
  records: number
  matched: number
  inserted: number
}

/** Run the matcher across all orgs. Idempotent via the (org, entry, source, source_id) unique index. */
export async function runMatcher(): Promise<MatchStats> {
  const db = getDb()
  const entries = await db
    .select({ id: watchEntries.id, orgId: watchEntries.orgId, type: watchEntries.type, normalized: watchEntries.normalized })
    .from(watchEntries)
    .where(isNull(watchEntries.disabledAt))
  const records = await loadRecords()
  let matched = 0
  let inserted = 0
  for (const entry of entries) {
    for (const rec of records) {
      const snippet = matchRecord(entry, rec)
      if (!snippet) continue
      matched++
      const res = await db
        .insert(watchHits)
        .values({ orgId: entry.orgId, entryId: entry.id, source: rec.source, sourceId: rec.sourceId, title: truncate(rec.title, 300), snippet: truncate(snippet, 400), url: rec.url, cveIds: rec.cveIds })
        .onConflictDoNothing()
        .returning({ id: watchHits.id })
      inserted += res.length
    }
  }
  const stats = { entries: entries.length, records: records.length, matched, inserted }
  logger.info('matcher run complete', { ...stats })
  return stats
}
