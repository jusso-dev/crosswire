import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { authed } from './middleware'
import { addWatch, countHitsByEntry, disableWatch, listWatchHits, listWatches, WatchValidationError } from '../server/ti/watchlists'
import { dayBounds, listDigests } from '../server/ti/digest'
import { compareKey } from '../server/ti/compare'

export const fetchWatches = createServerFn({ method: 'GET' })
  .middleware([authed])
  .validator(z.object({ entryId: z.string().max(100).optional(), day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).optional())
  .handler(async ({ context, data }) => {
    const orgId = context.session.org.id
    // A selected watch or digest day fetches exactly those hits (org-scoped), not just the newest 100.
    const bounds = data?.day ? dayBounds(data.day) : null
    const scoped = Boolean(data?.entryId || bounds)
    const [entries, hits, counts] = await Promise.all([
      listWatches(orgId),
      listWatchHits(orgId, { limit: scoped ? 500 : 100, entryId: data?.entryId, since: bounds?.start, until: bounds?.end }),
      countHitsByEntry(orgId),
    ])
    return {
      entries: entries.map((e) => ({ id: e.id, type: e.type, value: e.value, notes: e.notes, createdAt: e.createdAt.toISOString(), hitCount: counts[e.id] ?? 0 })),
      hits: hits.map((h) => ({ ...h, createdAt: h.createdAt.toISOString() })),
      totalHits: Object.values(counts).reduce((a, b) => a + b, 0),
    }
  })

export const createWatch = createServerFn({ method: 'POST' })
  .middleware([authed])
  .validator(z.object({ type: z.enum(['keyword', 'cve', 'vendor', 'tag']), value: z.string().max(300), notes: z.string().max(500).optional() }))
  .handler(async ({ context, data }) => {
    try {
      const row = await addWatch(context.session.org.id, context.session.user.id, data)
      return { ok: true as const, id: row.id }
    } catch (err) {
      if (err instanceof WatchValidationError) return { ok: false as const, error: err.message }
      throw err
    }
  })

export const removeWatch = createServerFn({ method: 'POST' })
  .middleware([authed])
  .validator(z.object({ id: z.string().min(1) }))
  .handler(async ({ context, data }) => ({ ok: await disableWatch(context.session.org.id, data.id) }))

export const fetchDigests = createServerFn({ method: 'GET' })
  .middleware([authed])
  .handler(async ({ context }) => {
    const rows = await listDigests(context.session.org.id)
    return rows.map((d) => ({ id: d.id, day: d.day, hitCount: d.hitCount, items: d.items, emailedAt: d.emailedAt?.toISOString() ?? null }))
  })

export const fetchCompare = createServerFn({ method: 'GET' })
  .middleware([authed])
  .validator(z.object({ key: z.string().min(1).max(200) }))
  .handler(async ({ context, data }) => compareKey(context.session.org.id, data.key))
