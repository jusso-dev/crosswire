import { describe, expect, it } from 'vitest'
import { appDay, dayBounds } from '../src/server/ti/digest'
import { parseEnv } from '../src/server/env'
import { fmtTime, resetPhrase, setDisplayTimeZone } from '../src/components/format'
import { isTimeZone, resolveTimeZone, TIME_ZONE_COOKIE, timeZoneFromCookieHeader, timeZoneLabel } from '../src/shared/timezone'
import { plainMessage } from '../src/shared/messages'

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

  it('handles zones where local midnight does not exist on the change day', () => {
    // Santiago springs forward at 00:00 on 2026-09-06 (clocks go to 01:00, UTC-3).
    const b = dayBounds('2026-09-06', 'America/Santiago')
    expect(appDay(b.start, 'America/Santiago')).toBe('2026-09-06')
    expect(appDay(new Date(b.start.getTime() - 1000), 'America/Santiago')).toBe('2026-09-05')
    expect(b.start.toISOString()).toBe('2026-09-06T04:00:00.000Z')
    const prev = dayBounds('2026-09-05', 'America/Santiago')
    expect(prev.end.toISOString()).toBe(b.start.toISOString())
  })

  it('formats UI times in the display zone', () => {
    setDisplayTimeZone('Australia/Sydney')
    expect(fmtTime('2026-11-07T14:30:00Z')).toMatch(/8 Nov 2026.*1:30/)
  })
})

describe('display zone preference (#161)', () => {
  it('accepts IANA zones and UTC, and rejects anything else', () => {
    expect(isTimeZone('UTC')).toBe(true)
    expect(isTimeZone('Australia/Perth')).toBe(true)
    for (const bad of ['', 'Mars/Olympus', 'x'.repeat(65), null, undefined, 3]) expect(isTimeZone(bad)).toBe(false)
  })

  it('falls back to the deployment default when the preference is missing or invalid', () => {
    expect(resolveTimeZone('UTC', 'Australia/Sydney')).toBe('UTC')
    expect(resolveTimeZone('Mars/Olympus', 'Australia/Sydney')).toBe('Australia/Sydney')
    expect(resolveTimeZone(null, 'Australia/Sydney')).toBe('Australia/Sydney')
  })

  it('reads the cw-tz cookie from a Cookie header', () => {
    expect(timeZoneFromCookieHeader(`a=1; ${TIME_ZONE_COOKIE}=America%2FNew_York; b=2`)).toBe('America/New_York')
    expect(timeZoneFromCookieHeader(`${TIME_ZONE_COOKIE}=Mars%2FOlympus`)).toBeNull()
    expect(timeZoneFromCookieHeader(`${TIME_ZONE_COOKIE}=%E0%A4%A`)).toBeNull()
    expect(timeZoneFromCookieHeader('other=1')).toBeNull()
    expect(timeZoneFromCookieHeader(null)).toBeNull()
  })

  it('labels zones with their UTC offset', () => {
    const at = new Date('2026-11-12T00:00:00Z')
    expect(timeZoneLabel('UTC', at)).toBe('UTC')
    expect(timeZoneLabel('Australia/Sydney', at)).toBe('Australia/Sydney (UTC+11)')
    expect(timeZoneLabel('America/New_York', at)).toBe('America/New York (UTC-5)')
  })

  it('formats in the chosen zone and states the zone, including UTC', () => {
    setDisplayTimeZone('UTC')
    expect(fmtTime('2026-11-07T14:30:00Z')).toMatch(/7 Nov 2026.*2:30.*UTC/)
    setDisplayTimeZone('Australia/Perth')
    expect(fmtTime('2026-11-07T14:30:00Z')).toMatch(/7 Nov 2026.*10:30.*AWST/)
    setDisplayTimeZone('Australia/Sydney')
  })

  it('states the budget reset in the display zone and in UTC', () => {
    const now = new Date('2026-11-12T03:00:00Z')
    setDisplayTimeZone('Australia/Sydney')
    expect(resetPhrase(now)).toBe('11:00 am AEDT (midnight UTC)')
    setDisplayTimeZone('UTC')
    expect(resetPhrase(now)).toBe('midnight UTC')
    setDisplayTimeZone('Australia/Sydney')
  })

  it('budget refusals name no deployment setting and give the reset in both zones', () => {
    setDisplayTimeZone('Australia/Sydney')
    for (const raw of ['Daily input token budget is exhausted.', 'Daily spend budget is exhausted.', 'Daily usage includes unpriced calls.', 'Spend cap is set but BUDGET_USD_PER_MILLION_TOKENS is not. Refusing the model call.']) {
      const shown = plainMessage(raw)
      expect(shown).not.toMatch(/BUDGET_|—/)
      expect(shown).toMatch(/owner/)
    }
    expect(plainMessage('Daily input token budget is exhausted.')).toMatch(/resets at \d{1,2}:00 [ap]m AE[DS]T \(midnight UTC\)/)
    expect(plainMessage('Context utilization 0.995 is at the 0.8 warning.')).toMatch(/fill 99% of/)
  })
})
