import { eq } from 'drizzle-orm'
import { getDb } from '../db/client'
import { tiFetchCache } from '../db/schema'
import { env } from '../env'
import { logger } from '../lib/logger'

export const USER_AGENT = 'Crosswire/0.1 (+https://github.com/jusso-dev/crosswire)'

export interface FetchResult {
  body: string
  fromCache: boolean
  status: number
  fetchedAt: Date
}

export interface PoliteFetchOptions {
  ttlSeconds?: number
  fetchImpl?: typeof fetch
  now?: () => Date
  maxRetries?: number
  sleep?: (ms: number) => Promise<void>
  /** Extra request headers (for example Authorization for Radar). Never cached or logged. */
  headers?: Record<string, string>
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

const tooLarge = (max: number) => new Error(`TI fetch refused: response larger than ${max} bytes`)

/**
 * Read a response body as UTF-8 text, refusing anything over `max` bytes. Content-Length is checked
 * first; the stream is then counted as it arrives and cancelled once the cap is passed, so a chunked
 * or mislabelled response can never be buffered past the limit.
 */
export async function readCappedText(res: Response, max: number): Promise<string> {
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => {})
    throw tooLarge(max)
  }
  if (!res.body) return ''
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let total = 0
  let text = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel().catch(() => {})
      throw tooLarge(max)
    }
    text += decoder.decode(value, { stream: true })
  }
  return text + decoder.decode()
}

/**
 * Polite, cached GET for public TI feeds (#42).
 * - Skips the network entirely while the cached copy is younger than the TTL (default >= 1h).
 * - Sends If-None-Match / If-Modified-Since when revalidating.
 * - Identifiable User-Agent; timeout; at most `maxRetries` (default 2) retries on 429/503 with
 *   backoff honouring Retry-After (capped), so a 429 can never tight-loop.
 * - Refuses bodies over TI_MAX_RESPONSE_BYTES (header and streamed byte count); nothing is cached.
 */
export async function politeFetch(url: string, opts: PoliteFetchOptions = {}): Promise<FetchResult> {
  const e = env()
  const ttl = Math.max(opts.ttlSeconds ?? e.TI_CACHE_TTL_SECONDS, 60)
  const now = opts.now ?? (() => new Date())
  const doFetch = opts.fetchImpl ?? fetch
  const sleep = opts.sleep ?? defaultSleep
  const maxRetries = Math.min(opts.maxRetries ?? 2, 3)
  const db = getDb()

  const [cached] = await db.select().from(tiFetchCache).where(eq(tiFetchCache.url, url)).limit(1)
  if (cached && now().getTime() - cached.fetchedAt.getTime() < ttl * 1000) {
    return { body: cached.body, fromCache: true, status: cached.status, fetchedAt: cached.fetchedAt }
  }

  const headers: Record<string, string> = { ...opts.headers, 'User-Agent': USER_AGENT, Accept: 'application/json' }
  if (cached?.etag) headers['If-None-Match'] = cached.etag
  if (cached?.lastModified) headers['If-Modified-Since'] = cached.lastModified

  for (let attempt = 0; ; attempt++) {
    const res = await doFetch(url, { headers, signal: AbortSignal.timeout(e.TI_HTTP_TIMEOUT_MS) })
    if ((res.status === 429 || res.status === 503) && attempt < maxRetries) {
      const retryAfter = Number(res.headers.get('retry-after'))
      const wait = Math.min(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2000 * 2 ** attempt, 60_000)
      logger.warn('ti fetch throttled; backing off', { url, status: res.status, waitMs: wait, attempt })
      await sleep(wait)
      continue
    }
    const fetchedAt = now()
    if (res.status === 304 && cached) {
      await db.update(tiFetchCache).set({ fetchedAt }).where(eq(tiFetchCache.url, url))
      return { body: cached.body, fromCache: true, status: 304, fetchedAt }
    }
    if (!res.ok) throw new Error(`TI fetch failed: ${url} -> HTTP ${res.status}`)
    const body = await readCappedText(res, e.TI_MAX_RESPONSE_BYTES)
    const row = { url, etag: res.headers.get('etag'), lastModified: res.headers.get('last-modified'), status: res.status, body, fetchedAt }
    await db.insert(tiFetchCache).values(row).onConflictDoUpdate({ target: tiFetchCache.url, set: row })
    return { body, fromCache: false, status: res.status, fetchedAt }
  }
}
