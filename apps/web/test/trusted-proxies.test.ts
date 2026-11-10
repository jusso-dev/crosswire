import { afterEach, describe, expect, it } from 'vitest'
import { parseEnv, parseTrustedProxies, resetEnvForTests } from '../src/server/env'
import { clientKey } from '../src/server/lib/http-security'

/** TRUSTED_PROXIES takes IP addresses and CIDR ranges, IPv4 and IPv6 (#157). */
const req = (xff: string) => new Request('http://x/api/chat', { headers: { 'x-forwarded-for': xff } })

afterEach(() => {
  delete process.env.TRUSTED_PROXIES
  resetEnvForTests()
})

describe('TRUSTED_PROXIES (#157)', () => {
  it('matches exact addresses and CIDR ranges, IPv4 and IPv6', () => {
    const { matcher, invalid } = parseTrustedProxies('10.0.0.0/8, 192.168.1.10, fd00::/8, 2001:db8::1')
    expect(invalid).toEqual([])
    expect(matcher.has('10.200.3.4')).toBe(true)
    expect(matcher.has('192.168.1.10')).toBe(true)
    expect(matcher.has('192.168.1.11')).toBe(false)
    expect(matcher.has('fd12:3456::1')).toBe(true)
    expect(matcher.has('2001:db8::1')).toBe(true)
    expect(matcher.has('2001:db8::2')).toBe(false)
    expect(matcher.has('11.0.0.1')).toBe(false)
    // IPv4-mapped IPv6 form of a trusted IPv4 address.
    expect(matcher.has('::ffff:10.0.0.1')).toBe(true)
    // Not an IP at all.
    expect(matcher.has('spoof')).toBe(false)
  })

  it('skips hops inside a trusted CIDR when choosing the rate-limit key', () => {
    const { matcher } = parseTrustedProxies('100.64.0.0/10, 10.0.0.0/8')
    expect(clientKey(req('spoof, 203.0.113.5, 100.100.1.2, 10.0.0.2'), matcher)).toBe('203.0.113.5')
    // Without trusted proxies the right-most hop is used.
    expect(clientKey(req('203.0.113.5, 10.0.0.2'), parseTrustedProxies('').matcher)).toBe('10.0.0.2')
  })

  it('reads TRUSTED_PROXIES from the environment', () => {
    process.env.TRUSTED_PROXIES = '10.0.0.0/8'
    resetEnvForTests()
    expect(clientKey(req('198.51.100.7, 10.1.1.1'))).toBe('198.51.100.7')
  })

  it('refuses invalid entries at start-up instead of ignoring them', () => {
    for (const bad of ['10.0.0.0/33', 'proxy.internal', '10.0.0.0/8/1', 'fd00::/129', '10.0.0.0/x']) {
      expect(parseTrustedProxies(bad).invalid).toEqual([bad])
      expect(() => parseEnv({ TRUSTED_PROXIES: bad })).toThrow(/TRUSTED_PROXIES/)
    }
    expect(parseEnv({ TRUSTED_PROXIES: '10.0.0.0/8,::1' }).TRUSTED_PROXIES).toBe('10.0.0.0/8,::1')
  })
})
