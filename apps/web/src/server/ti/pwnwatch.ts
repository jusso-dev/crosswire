import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { getDb } from '../db/client'
import { pwnChanges, pwnIncidents, pwnTags } from '../db/schema'
import { env } from '../env'
import { politeFetch, type PoliteFetchOptions } from './http'

// Parsers isolate upstream schema drift: unknown fields are ignored, missing optional fields default.
const incidentSchema = z.looseObject({
  slug: z.string().min(1),
  title: z.string(),
  url: z.string(),
  summary: z.string().nullish(),
  category: z.string().nullish(),
  severity: z.string().nullish(),
  status: z.string().nullish(),
  patchStatus: z.string().nullish(),
  product: z.string().nullish(),
  tags: z.array(z.string()).nullish(),
  stacks: z.array(z.string()).nullish(),
  cveIds: z.array(z.string()).nullish(),
  startedAt: z.string().nullish(),
  updatedAt: z.string().nullish(),
})
const incidentsFeed = z.looseObject({ incidents: z.array(z.unknown()) })

const changeSchema = z.looseObject({
  incident: z.string().min(1),
  incidentTitle: z.string().nullish(),
  category: z.string().nullish(),
  severity: z.string().nullish(),
  status: z.string().nullish(),
  date: z.string().nullish(),
  title: z.string(),
  body: z.string().nullish(),
  url: z.string().nullish(),
  sourceUrl: z.string().nullish(),
})
const changesFeed = z.looseObject({ changes: z.array(z.unknown()) })

const tagSchema = z.looseObject({
  id: z.string().min(1),
  label: z.string(),
  group: z.string().nullish(),
  groupLabel: z.string().nullish(),
  incidents: z.number().nullish(),
  url: z.string().nullish(),
})
const tagsFeed = z.looseObject({ tags: z.array(z.unknown()) })

export interface PwnFeeds {
  incidents: string
  changes: string
  tags: string
}

export function pwnFeedUrls(base = env().PWN_WATCH_BASE_URL): PwnFeeds {
  const b = base.replace(/\/$/, '')
  return { incidents: `${b}/incidents.json`, changes: `${b}/changes.json`, tags: `${b}/tags.json` }
}

/** Stable id for a change row: upstream has none, so hash incident + date + title. */
async function changeId(c: z.infer<typeof changeSchema>) {
  const data = new TextEncoder().encode(`${c.incident}|${c.date ?? ''}|${c.title}`)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return Buffer.from(digest).toString('hex').slice(0, 32)
}

function parseItems<T>(items: unknown[], schema: z.ZodType<T>) {
  const ok: T[] = []
  let skipped = 0
  for (const item of items) {
    const r = schema.safeParse(item)
    if (r.success) ok.push(r.data)
    else skipped++
  }
  return { ok, skipped }
}

export interface IngestStats {
  incidents: number
  changes: number
  tags: number
  skipped: number
  fromCache: boolean
}

/** Ingest pwn.watch feeds (#36). Idempotent upserts keyed on upstream ids. */
export async function ingestPwnWatch(payloads: { incidents: string; changes: string; tags: string }, urls = pwnFeedUrls()): Promise<IngestStats> {
  const db = getDb()
  const retrievedAt = new Date()
  const inc = parseItems(incidentsFeed.parse(JSON.parse(payloads.incidents)).incidents, incidentSchema)
  const chg = parseItems(changesFeed.parse(JSON.parse(payloads.changes)).changes, changeSchema)
  const tag = parseItems(tagsFeed.parse(JSON.parse(payloads.tags)).tags, tagSchema)

  for (const i of inc.ok) {
    const row = {
      slug: i.slug,
      title: i.title,
      summary: i.summary ?? '',
      category: i.category ?? null,
      severity: i.severity ?? null,
      status: i.status ?? null,
      patchStatus: i.patchStatus ?? null,
      product: i.product ?? null,
      tags: i.tags ?? [],
      stacks: i.stacks ?? [],
      cveIds: (i.cveIds ?? []).map((c) => c.toUpperCase()),
      startedAt: i.startedAt ?? null,
      upstreamUpdatedAt: i.updatedAt ?? null,
      url: i.url,
      source: 'pwn.watch',
      sourceUrl: urls.incidents,
      retrievedAt,
      raw: i as Record<string, unknown>,
    }
    await db.insert(pwnIncidents).values(row).onConflictDoUpdate({
      target: pwnIncidents.slug,
      set: row,
      // Only touch the row (and its retrieved_at, which drives matching) when upstream changed.
      setWhere: sql`${pwnIncidents.upstreamUpdatedAt} is distinct from ${row.upstreamUpdatedAt}`,
    })
  }
  for (const c of chg.ok) {
    const row = {
      id: await changeId(c),
      incidentSlug: c.incident,
      incidentTitle: c.incidentTitle ?? null,
      category: c.category ?? null,
      severity: c.severity ?? null,
      status: c.status ?? null,
      date: c.date ?? null,
      title: c.title,
      body: c.body ?? null,
      url: c.url ?? null,
      upstreamSourceUrl: c.sourceUrl ?? null,
      source: 'pwn.watch',
      sourceUrl: urls.changes,
      retrievedAt,
    }
    await db.insert(pwnChanges).values(row).onConflictDoNothing()
  }
  for (const t of tag.ok) {
    const row = {
      id: t.id,
      label: t.label,
      group: t.group ?? null,
      groupLabel: t.groupLabel ?? null,
      incidents: t.incidents ?? 0,
      url: t.url ?? null,
      source: 'pwn.watch',
      sourceUrl: urls.tags,
      retrievedAt,
    }
    await db.insert(pwnTags).values(row).onConflictDoUpdate({ target: pwnTags.id, set: row })
  }
  return { incidents: inc.ok.length, changes: chg.ok.length, tags: tag.ok.length, skipped: inc.skipped + chg.skipped + tag.skipped, fromCache: false }
}

/** Fetch (politely, cached) and ingest. */
export async function fetchAndIngestPwnWatch(opts: PoliteFetchOptions = {}): Promise<IngestStats> {
  const urls = pwnFeedUrls()
  const [incidents, changes, tags] = [await politeFetch(urls.incidents, opts), await politeFetch(urls.changes, opts), await politeFetch(urls.tags, opts)]
  const stats = await ingestPwnWatch({ incidents: incidents.body, changes: changes.body, tags: tags.body }, urls)
  return { ...stats, fromCache: incidents.fromCache && changes.fromCache && tags.fromCache }
}
