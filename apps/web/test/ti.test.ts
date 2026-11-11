import { readFileSync } from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { count, eq } from 'drizzle-orm'
import { getDb } from '../src/server/db/client'
import { cveRecords, digests, pwnChanges, pwnIncidents, pwnTags, watchHits } from '../src/server/db/schema'
import { ingestPwnWatch } from '../src/server/ti/pwnwatch'
import { ingestKev, normaliseCveId } from '../src/server/ti/kev'
import { politeFetch, USER_AGENT } from '../src/server/ti/http'
import { addWatch, disableWatch, listWatches, WatchValidationError } from '../src/server/ti/watchlists'
import { matchRecord, runMatcher } from '../src/server/ti/matcher'
import { buildDigest, runDailyDigest, appDay } from '../src/server/ti/digest'
import { compareKey } from '../src/server/ti/compare'
import * as mail from '../src/server/mail'
import { makeOrg, makeUser, member } from './helpers'

const fx = (f: string) => readFileSync(path.resolve(__dirname, 'fixtures', f), 'utf8')
const pwn = () => ({ incidents: fx('pwnwatch/incidents.json'), changes: fx('pwnwatch/changes.json'), tags: fx('pwnwatch/tags.json') })
const incidents = JSON.parse(fx('pwnwatch/incidents.json')).incidents as Array<{ slug: string; cveIds: string[]; tags: string[]; product: string }>

describe('pwn.watch + KEV ingest (#36, #37)', () => {
  it('populates tables with attribution and is idempotent', async () => {
    const first = await ingestPwnWatch(pwn())
    expect(first.incidents).toBe(incidents.length)
    const second = await ingestPwnWatch(pwn())
    expect(second.incidents).toBe(first.incidents)
    const [{ n }] = (await getDb().select({ n: count() }).from(pwnIncidents)) as [{ n: number }]
    expect(n).toBe(incidents.length)
    const [chg] = (await getDb().select({ n: count() }).from(pwnChanges)) as [{ n: number }]
    expect(chg.n).toBe(first.changes)
    const [tg] = (await getDb().select({ n: count() }).from(pwnTags)) as [{ n: number }]
    expect(tg.n).toBe(first.tags)
    const row = (await getDb().select().from(pwnIncidents).limit(1))[0]!
    expect(row.source).toBe('pwn.watch')
    expect(row.sourceUrl).toMatch(/^https:\/\/pwn\.watch\/incidents\.json$/)
  })

  it('tolerates schema drift: bad items are skipped, not fatal', async () => {
    const drift = JSON.stringify({ incidents: [{ slug: 'x-new', title: 'New', url: 'https://pwn.watch/i/x-new', futureField: 1 }, { nope: true }] })
    const r = await ingestPwnWatch({ incidents: drift, changes: '{"changes":[]}', tags: '{"tags":[]}' })
    expect(r.incidents).toBe(1)
    expect(r.skipped).toBe(1)
  })

  it('ingests CISA KEV into the generic cve_records table, idempotently', async () => {
    const a = await ingestKev(fx('kev.json'))
    const b = await ingestKev(fx('kev.json'))
    expect(a.records).toBeGreaterThan(0)
    expect(b.records).toBe(a.records)
    const rows = await getDb().select().from(cveRecords)
    expect(rows.length).toBe(new Set(rows.map((r) => r.cveId)).size)
    expect(rows.every((r) => r.source === 'cisa-kev')).toBe(true)
  })

  it('normalises CVE ids', () => {
    expect(normaliseCveId(' cve-2026-12345 ')).toBe('CVE-2026-12345')
    expect(normaliseCveId('CVE-26-1')).toBeNull()
  })
})

describe('polite fetch (#42)', () => {
  it('does not hit the network twice within the TTL and sends an identifying UA', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"ok":true}', { status: 200, headers: { etag: '"v1"' } }))
    const url = 'https://pwn.watch/test-ttl.json'
    const a = await politeFetch(url, { fetchImpl: fetchImpl as unknown as typeof fetch })
    const b = await politeFetch(url, { fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(a.fromCache).toBe(false)
    expect(b.fromCache).toBe(true)
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1]
    expect((init.headers as Record<string, string>)['User-Agent']).toBe(USER_AGENT)
  })

  it('revalidates with If-None-Match after the TTL and accepts 304', async () => {
    const url = 'https://pwn.watch/test-304.json'
    let now = new Date('2026-01-01T00:00:00Z')
    const first = vi.fn(async () => new Response('{"v":1}', { status: 200, headers: { etag: '"abc"' } }))
    await politeFetch(url, { fetchImpl: first as unknown as typeof fetch, now: () => now })
    now = new Date('2026-01-01T02:00:00Z')
    const second = vi.fn(async (_u: string, init: RequestInit) => {
      expect((init.headers as Record<string, string>)['If-None-Match']).toBe('"abc"')
      return new Response(null, { status: 304 })
    })
    const r = await politeFetch(url, { fetchImpl: second as unknown as typeof fetch, now: () => now })
    expect(r.body).toBe('{"v":1}')
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('does not tight-loop on 429: bounded retries with backoff', async () => {
    const url = 'https://pwn.watch/test-429.json'
    const fetchImpl = vi.fn(async () => new Response('slow down', { status: 429, headers: { 'retry-after': '1' } }))
    const sleep = vi.fn(async () => {})
    await expect(politeFetch(url, { fetchImpl: fetchImpl as unknown as typeof fetch, sleep })).rejects.toThrow(/HTTP 429/)
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(sleep).toHaveBeenCalledTimes(2)
    expect(sleep.mock.calls.every((c) => (c as unknown as [number])[0] >= 1000)).toBe(true)
  })
})

describe('TI fetches follow redirects only to the same https host (#211)', () => {
  const redirect = (location: string, status = 302) => new Response(null, { status, headers: { location } })
  const asFetch = (f: unknown) => f as typeof fetch

  it('asks fetch not to follow redirects itself', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }))
    await politeFetch('https://pwn.watch/redir-manual.json', { fetchImpl: asFetch(fetchImpl) })
    expect((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].redirect).toBe('manual')
  })

  it('follows an https redirect on the same host and caches under the configured URL', async () => {
    const url = 'https://pwn.watch/redir-same.json'
    const fetchImpl = vi.fn(async (u: string) => (u === url ? redirect('/v2/redir-same.json', 301) : new Response('{"moved":true}', { status: 200 })))
    const r = await politeFetch(url, { fetchImpl: asFetch(fetchImpl) })
    expect(r.body).toBe('{"moved":true}')
    expect(fetchImpl.mock.calls.map((c) => (c as unknown as [string])[0])).toEqual([url, 'https://pwn.watch/v2/redir-same.json'])
    expect((await politeFetch(url, { fetchImpl: asFetch(fetchImpl) })).fromCache).toBe(true)
  })

  it.each([
    ['another host', 'https://evil.example/feed.json'],
    ['an internal address', 'http://169.254.169.254/latest/meta-data/'],
    ['a subdomain', 'https://internal.pwn.watch/feed.json'],
    ['plain http on the same host', 'http://pwn.watch/feed.json'],
  ])('refuses a redirect to %s and never requests it', async (_name, location) => {
    const url = `https://pwn.watch/redir-${encodeURIComponent(location)}.json`
    const fetchImpl = vi.fn(async (u: string) => (u === url ? redirect(location) : new Response('{"leaked":true}', { status: 200 })))
    await expect(politeFetch(url, { fetchImpl: asFetch(fetchImpl), headers: { Authorization: 'Bearer t' } })).rejects.toThrow(/redirected to another host or to plain http/)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('refuses a redirect loop after the hop limit and a redirect without a location', async () => {
    const loop = vi.fn(async (u: string) => redirect(`${u}x`))
    await expect(politeFetch('https://pwn.watch/redir-loop', { fetchImpl: asFetch(loop) })).rejects.toThrow(/more than 3 redirects/)
    expect(loop).toHaveBeenCalledTimes(3)
    const bare = vi.fn(async () => new Response(null, { status: 302 }))
    await expect(politeFetch('https://pwn.watch/redir-bare.json', { fetchImpl: asFetch(bare) })).rejects.toThrow(/without a location/)
  })
})

describe('watchlists (#38)', () => {
  it('supports all four types, rejects invalid CVEs and short keywords, and isolates orgs', async () => {
    const a = await makeOrg('A')
    const b = await makeOrg('B')
    const u = await makeUser()
    await member(a, u)
    for (const [type, value] of [
      ['keyword', 'webkit'],
      ['cve', 'cve-2026-12345'],
      ['vendor', 'Apple'],
      ['tag', 'CISA KEV'],
    ] as const)
      await addWatch(a, u, { type, value })
    await expect(addWatch(a, u, { type: 'cve', value: 'CVE-26-1' })).rejects.toBeInstanceOf(WatchValidationError)
    await expect(addWatch(a, u, { type: 'keyword', value: 'ab' })).rejects.toBeInstanceOf(WatchValidationError)
    const listA = await listWatches(a)
    expect(listA.map((w) => w.normalized).sort()).toEqual(['apple', 'cisa-kev', 'CVE-2026-12345', 'webkit'].sort())
    expect(await listWatches(b)).toHaveLength(0)
    expect(await disableWatch(b, listA[0]!.id)).toBe(false)
    expect(await disableWatch(a, listA[0]!.id)).toBe(true)
    expect(await listWatches(a)).toHaveLength(3)
  })
})

describe('matcher, digest, compare (#39, #40, #41)', () => {
  let orgA: string
  let orgB: string
  const shared = incidents.find((i) => i.cveIds.length > 0)!

  beforeAll(async () => {
    await ingestPwnWatch(pwn())
    await ingestKev(fx('kev.json'))
    orgA = await makeOrg('MatchA')
    orgB = await makeOrg('MatchB')
    const owner = await makeUser('owner-a@example.test')
    await member(orgA, owner, 'owner')
    await addWatch(orgA, owner, { type: 'cve', value: shared.cveIds[0]! })
    await addWatch(orgA, owner, { type: 'tag', value: shared.tags[0]! })
    await addWatch(orgA, owner, { type: 'keyword', value: 'zzzz-never-matches' })
  })

  it('keyword/vendor matching is whole-word and case-insensitive', () => {
    const rec = { source: 's', sourceId: '1', title: 'Fortinet FortiOS flaw', text: 'Exploited in the wild', url: null, cveIds: [], tags: [], vendors: ['Fortinet FortiOS'] }
    expect(matchRecord({ type: 'vendor', normalized: 'fortinet' }, rec)).toBeTruthy()
    expect(matchRecord({ type: 'keyword', normalized: 'exploited' }, rec)).toBeTruthy()
    expect(matchRecord({ type: 'keyword', normalized: 'forti' }, rec)).toBeNull()
  })

  it('produces expected hits, no duplicates on re-run, org-scoped', async () => {
    const first = await runMatcher()
    expect(first.inserted).toBeGreaterThan(0)
    const again = await runMatcher()
    expect(again.inserted).toBe(0)
    const hitsA = await getDb().select().from(watchHits).where(eq(watchHits.orgId, orgA))
    expect(hitsA.some((h) => h.sourceId === shared.slug)).toBe(true)
    expect(hitsA.some((h) => h.source === 'cisa-kev')).toBe(true)
    expect(await getDb().select().from(watchHits).where(eq(watchHits.orgId, orgB))).toHaveLength(0)
  })

  it('in-app digest summarises today; empty orgs get a quiet digest', async () => {
    const day = appDay()
    const d = await buildDigest(orgA, day)
    expect(d.hitCount).toBeGreaterThan(0)
    const empty = await buildDigest(orgB, day)
    expect(empty.hitCount).toBe(0)
  })

  it('emails owners once per org-day only when SMTP is configured', async () => {
    const send = vi.spyOn(mail, 'sendMail').mockResolvedValue(true)
    const day = appDay()
    await runDailyDigest(day)
    const callsForA = send.mock.calls.filter((c) => (c[0] as string[]).includes('owner-a@example.test'))
    expect(callsForA).toHaveLength(1)
    expect(callsForA[0]![1]).not.toMatch(/token|secret/i)
    await runDailyDigest(day)
    expect(send.mock.calls.filter((c) => (c[0] as string[]).includes('owner-a@example.test'))).toHaveLength(1)
    send.mockRestore()

    // Without SMTP: skipped with a log line and the org-day stays un-emailed.
    const orgC = await makeOrg('NoSmtp')
    await runDailyDigest(day)
    const [row] = await getDb().select().from(digests).where(eq(digests.orgId, orgC))
    expect(row?.emailedAt).toBeNull()
  })

  it('compare view renders a CVE present in two sources; missing sources are absent, not errors', async () => {
    const both = incidents.find((i) => i.cveIds.some((c) => c === shared.cveIds[0]))!
    const r = await compareKey(orgA, both.cveIds[0]!.toLowerCase())
    expect(r.key).toBe(both.cveIds[0])
    const present = r.sources.filter((s) => s.present).map((s) => s.source)
    expect(present).toEqual(expect.arrayContaining(['pwn.watch', 'cisa-kev']))
    expect(r.agree.join(' ')).toMatch(/2 sources/)
    const missing = await compareKey(orgA, 'CVE-1999-0001')
    expect(missing.sources.every((s) => !s.present)).toBe(true)
    expect(missing.sources.some((s) => /radar/i.test(s.source))).toBe(false)
  })
})
