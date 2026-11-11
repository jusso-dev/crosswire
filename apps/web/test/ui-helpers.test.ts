import { describe, expect, it } from 'vitest'
import { EMPTY_VALUE, fmtAgo, fmtTime, fmtTimeExact, fmtUsd, humanise, plural, setDisplayTimeZone } from '../src/components/format'
import { isInternalHref, safeHref } from '../src/shared/links'
import { RESPONSE_EVENT_LABEL, responseActionLabel, responseEventLabel, statusWord } from '../src/shared/labels'
import { FALLBACK_MESSAGE, plainMessage } from '../src/shared/messages'
import { pageTitle } from '../src/components/errors'

describe('formatters (#161)', () => {
  it('shows the zone name on every timestamp, and seconds on exact ones', () => {
    setDisplayTimeZone('Australia/Sydney')
    expect(fmtTime('2026-11-07T14:30:00Z')).toMatch(/8 Nov 2026.*1:30.*AEDT/)
    expect(fmtTimeExact('2026-11-07T14:30:05Z')).toMatch(/1:30:05.*AEDT/)
    setDisplayTimeZone('UTC')
    expect(fmtTime('2026-11-07T14:30:00Z')).toMatch(/UTC/)
    setDisplayTimeZone('Australia/Sydney')
  })

  it('never returns an em dash for a missing value', () => {
    for (const v of [fmtTime(null), fmtTimeExact(undefined), fmtAgo(null)]) {
      expect(v).toBe(EMPTY_VALUE)
      expect(v).not.toMatch(/—/)
    }
  })

  it('pluralises and humanises every separator', () => {
    expect(plural(1, 'row')).toBe('1 row')
    expect(plural(3, 'row')).toBe('3 rows')
    expect(plural(2, 'day')).toBe('2 days')
    expect(plural(1200, 'row')).toBe('1,200 rows')
    expect(humanise('America/Argentina/Buenos_Aires')).toBe('America/Argentina/Buenos Aires')
    expect(humanise('graph_containment_extra')).toBe('graph containment extra')
  })

  it('rounds relative times down', () => {
    const now = Date.parse('2026-11-11T12:00:00Z')
    expect(fmtAgo(new Date(now - 59.5 * 60_000), now)).toBe('59 min ago')
    expect(fmtAgo(new Date(now - 23.9 * 3_600_000), now)).toBe('23 h ago')
    expect(fmtAgo(new Date(now - 20_000), now)).toBe('just now')
  })

  it('names the currency', () => {
    expect(fmtUsd(1_234_567)).toBe('US$1.23')
    expect(fmtUsd(1_234_567, 4)).toBe('US$1.2346')
  })
})

describe('safeHref (#131)', () => {
  it('keeps only http and https links', () => {
    expect(safeHref('https://pwn.watch/x')).toBe('https://pwn.watch/x')
    expect(safeHref('http://example.test/a?b=1')).toBe('http://example.test/a?b=1')
    for (const bad of ['javascript:alert(1)', ' JavaScript:alert(1)', 'data:text/html,hi', 'file:///etc/passwd', 'vbscript:x', '/relative', '//evil.test', '', null, 42, 'not a url']) {
      expect(safeHref(bad)).toBeUndefined()
    }
  })

  it('treats protocol-relative links as external (#169)', () => {
    expect(isInternalHref('/app/hunts')).toBe(true)
    expect(isInternalHref('//evil.test/app')).toBe(false)
    expect(isInternalHref('/\\evil.test')).toBe(false)
    expect(isInternalHref('https://crosswire.example/app', 'https://crosswire.example')).toBe(true)
    expect(isInternalHref('https://crosswire.example.evil.test/app', 'https://crosswire.example')).toBe(false)
    expect(isInternalHref(undefined)).toBe(false)
  })
})

describe('labels (#124, #172)', () => {
  it('labels a release from isolation as a release, not an isolation', () => {
    expect(responseActionLabel('graph_containment', { action: 'unisolate' })).toBe('Release a device from isolation')
    expect(responseActionLabel('graph_containment', { action: 'isolate' })).toBe('Isolate a device')
    expect(responseActionLabel('graph_containment', {})).toBe('Isolate a device')
    expect(responseActionLabel('graph_containment', { action: 'unisolate' })).not.toMatch(/^Isolate/)
    expect(responseActionLabel('other', { action: 'manual_rollback' })).toBe('Manual rollback')
    expect(responseActionLabel('other', {})).toBe('Manual action')
  })

  it('has a label for every event the server writes', () => {
    for (const ev of ['created', 'dry_run', 'approved', 'rejected', 'expired', 'execute_attempt', 'executed', 'execute_failed', 'rollback_proposed']) {
      expect(RESPONSE_EVENT_LABEL[ev as keyof typeof RESPONSE_EVENT_LABEL]).toBeTruthy()
    }
    expect(responseEventLabel('execute_failed')).toBe('Execution failed')
    expect(responseEventLabel('execute_attempt')).toBe('Execution started')
    expect(responseEventLabel('something_new')).toBe('something new')
  })

  it('never shows a raw status key', () => {
    expect(statusWord('in_progress')).toBe('In progress')
    expect(statusWord('partial')).toBe('Partly succeeded')
    expect(statusWord('brand_new')).toBe('brand new')
  })
})

describe('plainMessage fallback (#129)', () => {
  it('hides SQL, driver errors, JSON, stack frames and ids', () => {
    for (const raw of [
      'duplicate key value violates unique constraint "watch_org_key"',
      'select * from "response_proposals" where "id" = $1',
      'connect ECONNREFUSED 10.0.0.5:5432',
      '{"error":{"code":"Forbidden","message":"Insufficient privileges"}}',
      'Hunting is not configured for org 4b0c1f7e-1c2d-4e5f-8a9b-0c1d2e3f4a5b.',
      `TypeError: x is undefined\n    at handler (/app/src/fns/hunts.ts:120:5)`,
      'x'.repeat(400),
    ]) {
      expect(plainMessage(raw)).toBe(FALLBACK_MESSAGE)
    }
  })

  it('turns validation output into a sentence', () => {
    const zod = JSON.stringify([{ code: 'too_big', maximum: 1000, path: ['comment'], message: 'Too big' }])
    expect(plainMessage(zod)).toMatch(/not valid/)
  })

  it('keeps plain sentences and known rules', () => {
    expect(plainMessage('Some new server message')).toBe('Some new server message')
    expect(plainMessage(new Error('Only org owners can configure hunting connectors.'))).toBe('Only org owners can configure hunting connectors.')
    expect(plainMessage('Daily input token budget is exhausted.')).toMatch(/^Today's token budget is used up\./)
  })
})

describe('page titles (#173)', () => {
  it('names the page and the product', () => {
    expect(pageTitle('Approvals')).toBe('Approvals · Crosswire')
    expect(pageTitle('Isolate LAPTOP-7', 'Approval')).toBe('Isolate LAPTOP-7 · Approval · Crosswire')
    expect(pageTitle(undefined, 'Hunt')).toBe('Hunt · Crosswire')
    expect(pageTitle('x'.repeat(80))).toMatch(/^x{57}… · Crosswire$/)
  })
})
