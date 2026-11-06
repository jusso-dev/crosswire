import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { authed } from './middleware'
import { addWatch, disableWatch, listWatchHits, listWatches, WatchValidationError } from '../server/ti/watchlists'
import { listDigests } from '../server/ti/digest'
import { compareKey } from '../server/ti/compare'

export const fetchWatches = createServerFn({ method: 'GET' })
  .middleware([authed])
  .handler(async ({ context }) => {
    const orgId = context.session.org.id
    const [entries, hits] = await Promise.all([listWatches(orgId), listWatchHits(orgId, { limit: 100 })])
    return {
      entries: entries.map((e) => ({ id: e.id, type: e.type, value: e.value, notes: e.notes, createdAt: e.createdAt.toISOString() })),
      hits: hits.map((h) => ({ ...h, createdAt: h.createdAt.toISOString() })),
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
