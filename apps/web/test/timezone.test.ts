import { describe, expect, it } from 'vitest'
import { appDay, dayBounds } from '../src/server/ti/digest'
import { parseEnv } from '../src/server/env'
import { fmtTime, setDisplayTimeZone } from '../src/components/format'

describe('APP_TIMEZONE (default Australia/Sydney)', () => {
  it('defaults to Australia/Sydney and rejects unknown zones', () => {
    expect(parseEnv({}).APP_TIMEZONE).toBe('Australia/Sydney')
    expect(() => parseEnv({ APP_TIMEZONE: 'Mars/Olympus' })).toThrow(/IANA time zone/)
  })

  it('uses the Sydney calendar day, not the UTC day', () => {
    // 2026-11-07T14:30Z is 01:30 on 8 Nov in Sydney (AEDT, UTC+11).
    const at = new Date('2026-11-07T14:30:00Z')
    expect(appDay(at, 'Australia/Sydney')).toBe('2026-11-08')
    expect(appDay(at, 'UTC')).toBe('2026-11-07')
  })

  it('day bounds start at local midnight and handle DST changes', () => {
    expect(dayBounds('2026-11-08', 'Australia/Sydney').start.toISOString()).toBe('2026-11-07T13:00:00.000Z')
    // AEDT starts 2026-10-04 (02:00 -> 03:00): that day is 23 hours long.
    const dst = dayBounds('2026-10-04', 'Australia/Sydney')
    expect(dst.start.toISOString()).toBe('2026-10-03T14:00:00.000Z')
    expect((dst.end.getTime() - dst.start.getTime()) / 3_600_000).toBe(23)
    // AEDT ends 2026-04-05 (03:00 -> 02:00): 25 hours.
    const back = dayBounds('2026-04-05', 'Australia/Sydney')
    expect((back.end.getTime() - back.start.getTime()) / 3_600_000).toBe(25)
    expect(dayBounds('2026-11-08', 'UTC').start.toISOString()).toBe('2026-11-08T00:00:00.000Z')
  })

  it('formats UI times in the display zone', () => {
    setDisplayTimeZone('Australia/Sydney')
    expect(fmtTime('2026-11-07T14:30:00Z')).toMatch(/8 Nov 2026.*1:30/)
  })
})
