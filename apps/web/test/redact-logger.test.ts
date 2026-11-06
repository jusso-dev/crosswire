import { describe, expect, it } from 'vitest'
import { createLogger } from '../src/server/lib/logger'
import { looksSecret, redactString, redactValue } from '../src/server/lib/redact'

describe('redaction + logging (#63)', () => {
  it('never writes Authorization headers or tokens to logs', () => {
    const lines: string[] = []
    const log = createLogger({ json: true, level: 'debug', write: (l) => lines.push(l) })
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'
    log.info('request', { headers: { authorization: `Bearer ${jwt}`, cookie: 'session=abc123456' }, note: `token=${jwt}` })
    log.warn(`Bearer ${jwt}`)
    const out = lines.join('\n')
    expect(out).not.toContain(jwt)
    expect(out).not.toContain('abc123456')
    expect(out).toContain('[REDACTED]')
    expect(JSON.parse(lines[0]!).level).toBe('info')
  })

  it('flags credential-looking strings', () => {
    expect(looksSecret('ghp_abcdefghijklmnopqrstuvwxyz0123456789')).toBe(true)
    expect(looksSecret('client_secret=supersecretvalue')).toBe(true)
    expect(looksSecret('Investigate CVE-2026-1234 on host web01')).toBe(false)
    expect(redactString('sk-abcdefghijklmnopqrstuv')).toBe('[REDACTED_API_KEY]')
    expect(redactValue({ password: 'hunter2', nested: { access_token: 'x' } })).toEqual({ password: '[REDACTED]', nested: { access_token: '[REDACTED]' } })
  })
})
