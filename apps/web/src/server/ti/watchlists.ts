import { and, count, desc, eq, gte, isNull, lt } from 'drizzle-orm'
import { getDb } from '../db/client'
import { watchEntries, watchHits } from '../db/schema'
import { normaliseCveId } from './kev'

export type WatchType = (typeof watchEntries.$inferInsert)['type']
export const WATCH_TYPES: WatchType[] = ['keyword', 'cve', 'vendor', 'tag']
export const MIN_KEYWORD_LENGTH = 3

export class WatchValidationError extends Error {}

/** Validate and normalise a watch value. Throws WatchValidationError with a user-facing message. */
export function normaliseWatch(type: WatchType, value: string): string {
  const v = value.trim()
  if (!v) throw new WatchValidationError('Value is required.')
  if (v.length > 200) throw new WatchValidationError('Value must be 200 characters or fewer.')
  switch (type) {
    case 'cve': {
      const id = normaliseCveId(v)
      if (!id) throw new WatchValidationError('CVE IDs look like CVE-2026-12345 (CVE-year-number, at least 4 digits).')
      return id
    }
    case 'tag':
      return v.toLowerCase().replace(/\s+/g, '-')
    case 'keyword':
    case 'vendor':
      if (v.length < MIN_KEYWORD_LENGTH) throw new WatchValidationError(`${type === 'keyword' ? 'Keywords' : 'Vendor names'} need at least ${MIN_KEYWORD_LENGTH} characters.`)
      return v.toLowerCase()
  }
}

export async function addWatch(orgId: string, userId: string, input: { type: WatchType; value: string; notes?: string }) {
  const normalized = normaliseWatch(input.type, input.value)
  const [row] = await getDb()
    .insert(watchEntries)
    .values({ orgId, type: input.type, value: input.value.trim(), normalized, notes: input.notes?.trim() || null, createdBy: userId })
    .returning()
  return row!
}

/** Soft-disable (any org member may do this in v1; documented in docs/watchlists.md). */
export async function disableWatch(orgId: string, entryId: string) {
  const rows = await getDb()
    .update(watchEntries)
    .set({ disabledAt: new Date() })
    .where(and(eq(watchEntries.orgId, orgId), eq(watchEntries.id, entryId), isNull(watchEntries.disabledAt)))
    .returning({ id: watchEntries.id })
  return rows.length > 0
}

export async function listWatches(orgId: string) {
  return getDb().select().from(watchEntries).where(and(eq(watchEntries.orgId, orgId), isNull(watchEntries.disabledAt))).orderBy(desc(watchEntries.createdAt))
}

export async function listWatchHits(orgId: string, opts: { since?: Date; until?: Date; limit?: number; entryId?: string } = {}) {
  const conds = [eq(watchHits.orgId, orgId)]
  if (opts.since) conds.push(gte(watchHits.createdAt, opts.since))
  if (opts.until) conds.push(lt(watchHits.createdAt, opts.until))
  if (opts.entryId) conds.push(eq(watchHits.entryId, opts.entryId))
  return getDb()
    .select({
      id: watchHits.id,
      source: watchHits.source,
      sourceId: watchHits.sourceId,
      title: watchHits.title,
      snippet: watchHits.snippet,
      url: watchHits.url,
      cveIds: watchHits.cveIds,
      createdAt: watchHits.createdAt,
      entryType: watchEntries.type,
      entryValue: watchEntries.value,
    })
    .from(watchHits)
    .innerJoin(watchEntries, eq(watchEntries.id, watchHits.entryId))
    .where(and(...conds))
    .orderBy(desc(watchHits.createdAt))
    .limit(Math.min(opts.limit ?? 100, 500))
}

export async function countWatches(orgId: string) {
  const [r] = await getDb().select({ n: count() }).from(watchEntries).where(and(eq(watchEntries.orgId, orgId), isNull(watchEntries.disabledAt)))
  return r?.n ?? 0
}
/** Hit count per active watch entry, for the whole history (not just the recent list). */
export async function countHitsByEntry(orgId: string) {
  const rows = await getDb().select({ entryId: watchHits.entryId, n: count() }).from(watchHits).where(eq(watchHits.orgId, orgId)).groupBy(watchHits.entryId)
  return Object.fromEntries(rows.map((r) => [r.entryId, r.n]))
}

export async function countWatchHits(orgId: string) {
  const [r] = await getDb().select({ n: count() }).from(watchHits).where(eq(watchHits.orgId, orgId))
  return r?.n ?? 0
}
