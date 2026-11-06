import { and, arrayContains, eq, ilike, or } from 'drizzle-orm'
import { getDb } from '../db/client'
import { cveRecords, pwnIncidents, watchHits } from '../db/schema'
import { normaliseCveId } from './kev'
import { radarCard } from './radar'

export interface SourceCard {
  source: string
  present: boolean
  url?: string | null
  title?: string | null
  severity?: string | null
  date?: string | null
  vendor?: string | null
  exploited?: boolean | null
  summary?: string | null
  attribution: string
}

export interface CompareResult {
  key: string
  kind: 'cve' | 'indicator'
  sources: SourceCard[]
  agree: string[]
  differ: string[]
  orgHits: number
}

const ATTRIBUTION: Record<string, string> = {
  'pwn.watch': 'Source: pwn.watch (https://pwn.watch)',
  'cisa-kev': 'Source: CISA Known Exploited Vulnerabilities catalog',
  nvd: 'Source: NIST NVD',
  'cve.watch': 'Source: cve.watch',
}
// Cloudflare Radar (Later, #64) is optional and only used for IP/domain keys; see ti/radar.ts.

/**
 * Cross-source compare (#41). CVE-first; non-CVE keys do a plain text search on pwn.watch only
 * plus optional Cloudflare Radar enrichment for IP/domain keys when RADAR_ENABLED. Deterministic summary, no LLM.
 */
export async function compareKey(orgId: string, rawKey: string): Promise<CompareResult> {
  const db = getDb()
  const cve = normaliseCveId(rawKey)
  const key = cve ?? rawKey.trim()
  const pwn = cve
    ? await db.select().from(pwnIncidents).where(arrayContains(pwnIncidents.cveIds, [cve])).limit(5)
    : await db
        .select()
        .from(pwnIncidents)
        .where(or(ilike(pwnIncidents.title, `%${key.replace(/[%_\\]/g, '\\$&')}%`), arrayContains(pwnIncidents.tags, [key.toLowerCase()])))
        .limit(5)
  const cves = cve ? await db.select().from(cveRecords).where(eq(cveRecords.cveId, cve)) : []
  const hits = cve
    ? await db.select({ id: watchHits.id }).from(watchHits).where(and(eq(watchHits.orgId, orgId), arrayContains(watchHits.cveIds, [cve])))
    : []

  const sources: SourceCard[] = []
  const firstPwn = pwn[0]
  sources.push(
    firstPwn
      ? {
          source: 'pwn.watch',
          present: true,
          url: firstPwn.url,
          title: firstPwn.title,
          severity: firstPwn.severity,
          date: firstPwn.startedAt,
          vendor: firstPwn.product,
          exploited: firstPwn.tags.includes('cisa-kev') || firstPwn.tags.includes('exploited') || firstPwn.tags.includes('in-the-wild') ? true : null,
          summary: firstPwn.summary,
          attribution: ATTRIBUTION['pwn.watch']!,
        }
      : { source: 'pwn.watch', present: false, attribution: ATTRIBUTION['pwn.watch']! },
  )
  for (const src of ['cisa-kev', 'nvd', 'cve.watch'] as const) {
    const r = cves.find((c) => c.source === src)
    if (r) {
      sources.push({
        source: src,
        present: true,
        url: r.url,
        title: r.title,
        severity: r.severity,
        date: r.publishedAt,
        vendor: [r.vendor, r.product].filter(Boolean).join(' / ') || null,
        exploited: src === 'cisa-kev' ? true : null,
        summary: r.description,
        attribution: ATTRIBUTION[src]!,
      })
    } else if (cve && src === 'cisa-kev') {
      sources.push({ source: src, present: false, attribution: ATTRIBUTION[src]! })
    }
  }

  if (!cve) {
    const radar = await radarCard(key)
    if (radar) sources.push(radar)
  }

  const present = sources.filter((s) => s.present)
  const agree: string[] = []
  const differ: string[] = []
  if (present.length >= 2) {
    agree.push(`${present.length} sources reference ${key}.`)
    const exploited = present.filter((s) => s.exploited === true).map((s) => s.source)
    if (exploited.length === present.length) agree.push('All sources indicate active exploitation.')
    else if (exploited.length > 0) differ.push(`Exploitation reported by ${exploited.join(', ')} only.`)
    const dates = [...new Set(present.map((s) => s.date).filter(Boolean))]
    if (dates.length > 1) differ.push(`Dates differ: ${present.filter((s) => s.date).map((s) => `${s.source} ${s.date}`).join('; ')}.`)
    else if (dates.length === 1) agree.push(`Same date: ${dates[0]}.`)
    const sev = [...new Set(present.map((s) => s.severity).filter(Boolean))]
    if (sev.length > 1) differ.push(`Severity labels differ: ${present.filter((s) => s.severity).map((s) => `${s.source} "${s.severity}"`).join('; ')}.`)
  } else if (present.length === 1) {
    agree.push(`Only ${present[0]!.source} has ${key}; nothing to compare yet.`)
  } else {
    agree.push(`No ingested source has ${key}.`)
  }
  return { key, kind: cve ? 'cve' : 'indicator', sources, agree, differ, orgHits: hits.length }
}

export async function searchIntel(query: string, limit = 10) {
  const db = getDb()
  const cve = normaliseCveId(query)
  if (cve) {
    const pwn = await db.select({ slug: pwnIncidents.slug, title: pwnIncidents.title, url: pwnIncidents.url }).from(pwnIncidents).where(arrayContains(pwnIncidents.cveIds, [cve])).limit(limit)
    const kev = await db.select({ cveId: cveRecords.cveId, title: cveRecords.title, source: cveRecords.source, url: cveRecords.url }).from(cveRecords).where(eq(cveRecords.cveId, cve))
    return { pwn, cve: kev }
  }
  const q = `%${query.replace(/[%_\\]/g, '\\$&')}%`
  const pwn = await db
    .select({ slug: pwnIncidents.slug, title: pwnIncidents.title, url: pwnIncidents.url })
    .from(pwnIncidents)
    .where(or(ilike(pwnIncidents.title, q), ilike(pwnIncidents.summary, q), ilike(pwnIncidents.product, q)))
    .limit(limit)
  const kev = await db
    .select({ cveId: cveRecords.cveId, title: cveRecords.title, source: cveRecords.source, url: cveRecords.url })
    .from(cveRecords)
    .where(or(ilike(cveRecords.vendor, q), ilike(cveRecords.product, q), ilike(cveRecords.title, q)))
    .limit(limit)
  return { pwn, cve: kev }
}
