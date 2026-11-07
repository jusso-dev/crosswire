import { describe, expect, it } from 'vitest'
import { getDb } from '../src/server/db/client'
import { watchEntries, watchHits } from '../src/server/db/schema'
import { createHunt, getHunt } from '../src/server/hunting/hunts'
import { applyFilters, cellText, decodeFilters, decodeSort, encodeFilters, encodeSort, kqlIdentifier, kqlLiteral, sortRows, summariseEntities } from '../src/components/results'
import { controlPanel, lastCalendarDays } from '../src/server/ops/overview'
import { createProposal } from '../src/server/response/proposals'
import { proposeKql } from '../src/server/hunting/hunts'
import { pwnIncidents, kqlProposals, responseProposals } from '../src/server/db/schema'
import { eq } from 'drizzle-orm'
import { normaliseSeverity } from '../src/components/signals'
import { makeOrg, makeUser, member } from './helpers'

async function hitFor(orgId: string, userId: string, title: string) {
  const [entry] = await getDb().insert(watchEntries).values({ orgId, type: 'vendor', value: 'fortinet', normalized: 'fortinet', createdBy: userId }).returning()
  const [hit] = await getDb()
    .insert(watchHits)
    .values({ orgId, entryId: entry!.id, source: 'pwn.watch', sourceId: crypto.randomUUID(), title, snippet: '', url: 'https://pwn.watch/x', cveIds: [] })
    .returning()
  return hit!.id
}

describe('hunt workspace data', () => {
  it('returns the origin watch hit for the same org only', async () => {
    const orgA = await makeOrg('WsA')
    const orgB = await makeOrg('WsB')
    const ua = await makeUser()
    const ub = await makeUser()
    await member(orgA, ua)
    await member(orgB, ub)
    const hitA = await hitFor(orgA, ua, 'FortiOS SSL-VPN heap overflow')
    const hitB = await hitFor(orgB, ub, 'Other org secret hit')

    const own = await createHunt(orgA, ua, { title: 'From own hit', watchHitId: hitA })
    expect((await getHunt(orgA, own.id))!.origin?.title).toBe('FortiOS SSL-VPN heap overflow')

    // A hunt that references another org's hit id never resolves it.
    const crossed = await createHunt(orgA, ua, { title: 'Crossed reference', watchHitId: hitB })
    expect((await getHunt(orgA, crossed.id))!.origin).toBeNull()
    // And org B cannot read org A's hunt at all.
    expect(await getHunt(orgB, own.id)).toBeNull()
  })
})

describe('result grid helpers', () => {
  const rows = [
    { DeviceName: 'wks-1', Account: 'a\\b', Count: 3, Note: '' },
    { DeviceName: 'wks-2', Account: 'c', Count: 10, Note: null },
    { DeviceName: 'wks-1', Account: 'say "hi"', Count: 1, Note: 'x' },
  ]

  it('filters round-trip through the URL, including = and & in values', () => {
    const f = [
      { col: 'DeviceName', op: 'eq' as const, value: 'a=b&c' },
      { col: 'Note', op: 'ne' as const, value: '' },
    ]
    expect(decodeFilters(encodeFilters(f))).toEqual(f)
    expect(decodeFilters(undefined)).toEqual([])
  })

  it('applies eq/ne filters and keeps original row indexes', () => {
    const out = applyFilters(rows, [{ col: 'DeviceName', op: 'eq', value: 'wks-1' }])
    expect(out.map((r) => r.index)).toEqual([0, 2])
    // Empty and null are both "empty", never zero.
    expect(applyFilters(rows, [{ col: 'Note', op: 'ne', value: '' }]).map((r) => r.index)).toEqual([2])
    expect(cellText(0)).toBe('0')
    expect(cellText(null)).toBe('')
  })

  it('builds escaped KQL literals for pivots, including line breaks', () => {
    expect(kqlLiteral('say "hi"')).toBe('"say \\"hi\\""')
    expect(kqlLiteral('a\\b')).toBe('"a\\\\b"')
    expect(kqlLiteral(10)).toBe('10')
    const lit = kqlLiteral('line1\n.set evil\r\tx')
    expect(lit).not.toMatch(/[\n\r\t]/)
    expect(lit).toBe('"line1\\n.set evil\\r\\tx"')
  })

  it('quotes column names that are not plain KQL identifiers', () => {
    expect(kqlIdentifier('DeviceName')).toBe('DeviceName')
    expect(kqlIdentifier('Remote IP')).toBe("['Remote IP']")
    expect(kqlIdentifier('user.name')).toBe("['user.name']")
    expect(kqlIdentifier("o'brien")).toBe("['o\\'brien']")
  })

  it('keeps operators separate from column names, even ones starting with !', () => {
    const f = [{ col: '!weird', op: 'eq' as const, value: 'x' }]
    expect(decodeFilters(encodeFilters(f))).toEqual(f)
    expect(decodeFilters('garbage&eq:%E0%A4%A=1')).toEqual([])
  })

  it('shares one sort order between grid and inspector, and round-trips through the URL', () => {
    const sorted = sortRows(applyFilters(rows, []), { col: 'Count', dir: 'desc' })
    expect(sorted.map((r) => r.index)).toEqual([1, 0, 2])
    expect(decodeSort(encodeSort({ col: 'Remote IP', dir: 'asc' }))).toEqual({ col: 'Remote IP', dir: 'asc' })
    expect(decodeSort('sideways:x')).toBeNull()
  })

  it('generates consecutive calendar days across a DST change', () => {
    expect(lastCalendarDays('2026-10-05', 4)).toEqual(['2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05'])
    expect(lastCalendarDays('2026-03-01', 2)).toEqual(['2026-02-28', '2026-03-01'])
  })

  it('summarises entities within the sample only', () => {
    const { groups } = summariseEntities(['DeviceName', 'Account', 'Count'], rows)
    const devices = groups.find((g) => g.column === 'DeviceName')!
    expect(devices.values[0]).toMatchObject({ value: 'wks-1', count: 2 })
    expect(groups.find((g) => g.column === 'Count')).toBeUndefined()
  })

  it('treats unrecognised severities as unknown, not low', () => {
    expect(normaliseSeverity('CRITICAL')).toBe('critical')
    expect(normaliseSeverity('informational')).toBe('unknown')
    expect(normaliseSeverity(null)).toBe('unknown')
  })
})

describe('control panel (overview) counts', () => {
  it('lists only live incidents, excludes expired and approved items from "waiting", and counts beyond the preview caps', async () => {
    const orgId = await makeOrg('Ov')
    const u = await makeUser()
    await member(orgId, u, 'owner')
    const now = new Date()
    const base = { url: 'https://pwn.watch/x', sourceUrl: 'https://pwn.watch/incidents.json', retrievedAt: now, raw: {} }
    await getDb().insert(pwnIncidents).values([
      { ...base, slug: `live-${orgId}`, title: 'Live one', status: 'live' },
      { ...base, slug: `closed-${orgId}`, title: 'Closed one', status: 'closed' },
    ])
    const hunt = await createHunt(orgId, u, { title: 'H' })
    for (let i = 0; i < 7; i++) await createHunt(orgId, u, { title: `Open ${i}` })
    const fresh = await proposeKql(orgId, { type: 'user', id: u }, { huntId: hunt.id, target: 'defender', kql: 'DeviceInfo | take 1' })
    const stale = await proposeKql(orgId, { type: 'user', id: u }, { huntId: hunt.id, target: 'defender', kql: 'DeviceInfo | take 2' })
    await getDb().update(kqlProposals).set({ expiresAt: new Date(now.getTime() - 1000) }).where(eq(kqlProposals.id, stale.id))
    const action = { title: 'Isolate', actionType: 'graph_containment' as const, targets: { devices: ['d1'] }, blastRadius: { summary: 'one demo device only' }, payload: {} }
    await createProposal(orgId, { type: 'user', userId: u }, action)
    const approved = await createProposal(orgId, { type: 'user', userId: u }, action)
    await getDb().update(responseProposals).set({ status: 'approved' }).where(eq(responseProposals.id, approved.id))

    const p = await controlPanel(orgId, now)
    expect(p.emerging.every((i) => i.status === 'live')).toBe(true)
    expect(p.emerging.some((i) => i.title === 'Closed one')).toBe(false)
    expect(p.pendingQueries.map((q) => q.id)).toEqual([fresh.id])
    expect(p.pendingResponses).toHaveLength(1)
    expect(p.totals.awaitingDecision).toBe(2)
    expect(p.totals.openHunts).toBe(8) // more than the 6-item preview
    expect(p.openHunts).toHaveLength(6)
    expect(p.chartDays).toHaveLength(14)
  })
})
