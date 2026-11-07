import { describe, expect, it } from 'vitest'
import { getDb } from '../src/server/db/client'
import { watchEntries, watchHits } from '../src/server/db/schema'
import { createHunt, getHunt } from '../src/server/hunting/hunts'
import { applyFilters, cellText, decodeFilters, encodeFilters, kqlLiteral, summariseEntities } from '../src/components/results'
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

  it('builds escaped KQL literals for pivots', () => {
    expect(kqlLiteral('say "hi"')).toBe('"say \\"hi\\""')
    expect(kqlLiteral('a\\b')).toBe('"a\\\\b"')
    expect(kqlLiteral(10)).toBe('10')
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
