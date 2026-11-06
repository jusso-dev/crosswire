import { z } from 'zod'
import { getDb } from '../db/client'
import { cveRecords } from '../db/schema'
import { env } from '../env'
import { politeFetch, type PoliteFetchOptions } from './http'

const vuln = z.looseObject({
  cveID: z.string(),
  vendorProject: z.string().nullish(),
  product: z.string().nullish(),
  vulnerabilityName: z.string().nullish(),
  dateAdded: z.string().nullish(),
  shortDescription: z.string().nullish(),
  dueDate: z.string().nullish(),
  knownRansomwareCampaignUse: z.string().nullish(),
})
const feed = z.looseObject({ vulnerabilities: z.array(z.unknown()) })

export const CVE_ID_RE = /^CVE-\d{4}-\d{4,}$/

export function normaliseCveId(input: string): string | null {
  const v = input.trim().toUpperCase()
  return CVE_ID_RE.test(v) ? v : null
}

/** CISA KEV ingest (#37): the CVE backbone while cve.watch is unavailable. Idempotent. */
export async function ingestKev(payload: string, sourceUrl = env().CISA_KEV_URL) {
  const db = getDb()
  const retrievedAt = new Date()
  let count = 0
  let skipped = 0
  for (const item of feed.parse(JSON.parse(payload)).vulnerabilities) {
    const r = vuln.safeParse(item)
    const cveId = r.success ? normaliseCveId(r.data.cveID) : null
    if (!r.success || !cveId) {
      skipped++
      continue
    }
    const v = r.data
    const row = {
      source: 'cisa-kev' as const,
      cveId,
      vendor: v.vendorProject ?? null,
      product: v.product ?? null,
      title: v.vulnerabilityName ?? null,
      description: v.shortDescription ?? null,
      severity: 'known-exploited',
      publishedAt: v.dateAdded ?? null,
      dueDate: v.dueDate ?? null,
      knownRansomware: v.knownRansomwareCampaignUse ?? null,
      url: `https://nvd.nist.gov/vuln/detail/${cveId}`,
      sourceUrl,
      retrievedAt,
      raw: v as Record<string, unknown>,
    }
    await db.insert(cveRecords).values(row).onConflictDoUpdate({ target: [cveRecords.source, cveRecords.cveId], set: row })
    count++
  }
  return { records: count, skipped }
}

export async function fetchAndIngestKev(opts: PoliteFetchOptions = {}) {
  const url = env().CISA_KEV_URL
  const res = await politeFetch(url, opts)
  return { ...(await ingestKev(res.body, url)), fromCache: res.fromCache }
}
