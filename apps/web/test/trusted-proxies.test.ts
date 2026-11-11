import { afterEach, describe, expect, it } from 'vitest'
import { IncomingMessage } from 'node:http'
import { Socket } from 'node:net'
import { NodeRequest } from 'srvx/node'
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

describe('sign-in rate limit key (#196)', () => {
  it('handles srvx requests without losing the sign-in body or trusting a spoofed IP', async () => {
    const { withClientIp, CLIENT_IP_HEADER } = await import('../src/server/auth/auth')
    const incoming = new IncomingMessage(new Socket())
    incoming.method = 'POST'
    incoming.url = '/api/auth/sign-in/email'
    incoming.headers = {
      host: 'localhost:3000',
      'content-type': 'application/json',
      'x-forwarded-for': '198.51.100.1, 203.0.113.7',
      [CLIENT_IP_HEADER]: '192.0.2.1',
    }
    incoming.rawHeaders = Object.entries(incoming.headers).flatMap(([name, value]) => [name, String(value)])
    const body = JSON.stringify({ email: 'nobody@example.test', password: 'test-only-password' })
    incoming.push(body)
    incoming.push(null)
    const original = new NodeRequest({ req: incoming })
    const forwarded = withClientIp(original)
    expect(forwarded.method).toBe('POST')
    expect(forwarded.url).toBe('http://localhost:3000/api/auth/sign-in/email')
    expect(forwarded.headers.get(CLIENT_IP_HEADER)).toBe('203.0.113.7')
    expect(forwarded.headers.get('content-type')).toBe('application/json')
    expect(await forwarded.text()).toBe(body)
    expect(original.headers.get(CLIENT_IP_HEADER)).toBe('192.0.2.1')
  })

  it('ignores X-Real-IP and a client-sent client-IP header; uses the right-most X-Forwarded-For hop', async () => {
    const { withClientIp, CLIENT_IP_HEADER } = await import('../src/server/auth/auth')
    const spoofed = (n: number) =>
      new Request('http://x/api/auth/sign-in/email', { method: 'POST', headers: { 'x-forwarded-for': `10.9.9.${n}, 203.0.113.7`, 'x-real-ip': `198.51.100.${n}`, [CLIENT_IP_HEADER]: `192.0.2.${n}` } })
    const keys = new Set([1, 2, 3].map((n) => withClientIp(spoofed(n)).headers.get(CLIENT_IP_HEADER)))
    expect([...keys]).toEqual(['203.0.113.7'])
    // No X-Forwarded-For at all: no client IP, never the X-Real-IP value.
    const bare = withClientIp(new Request('http://x/', { headers: { 'x-real-ip': '198.51.100.1' } }))
    expect(bare.headers.get(CLIENT_IP_HEADER)).toBeNull()
    expect(clientKey(new Request('http://x/', { headers: { 'x-real-ip': '198.51.100.1' } }))).toBe('local')
  })

  it('skips TRUSTED_PROXIES hops for the sign-in key too', async () => {
    process.env.TRUSTED_PROXIES = '100.64.0.0/10'
    resetEnvForTests()
    const { withClientIp, CLIENT_IP_HEADER } = await import('../src/server/auth/auth')
    const r = withClientIp(new Request('http://x/', { headers: { 'x-forwarded-for': 'spoof, 203.0.113.9, 100.100.0.1' } }))
    expect(r.headers.get(CLIENT_IP_HEADER)).toBe('203.0.113.9')
  })

  it('Better Auth limits sign-in per resolved client, whatever X-Real-IP says', async () => {
    process.env.NODE_ENV = 'development'
    process.env.RATE_LIMIT_STORAGE = 'memory'
    resetEnvForTests()
    const { auth, resetAuthForTests, withClientIp } = await import('../src/server/auth/auth')
    resetAuthForTests()
    try {
      const attempt = (n: number) =>
        auth().handler(
          withClientIp(
            new Request('http://localhost:3000/api/auth/sign-in/email', {
              method: 'POST',
              headers: { 'content-type': 'application/json', origin: 'http://localhost:3000', 'x-forwarded-for': `10.0.0.${n}, 203.0.113.50`, 'x-real-ip': `198.51.100.${n}` },
              body: JSON.stringify({ email: 'nobody@example.test', password: 'wrong password 123' }),
            }),
          ),
        )
      const statuses: number[] = []
      for (let n = 0; n < 7; n++) statuses.push((await attempt(n)).status)
      expect(statuses.slice(0, 5).every((s) => s === 401)).toBe(true)
      expect(statuses.slice(5)).toEqual([429, 429])
    } finally {
      process.env.NODE_ENV = 'test'
      delete process.env.RATE_LIMIT_STORAGE
      resetEnvForTests()
      resetAuthForTests()
    }
  })
})
