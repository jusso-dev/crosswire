import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDb } from '../src/server/db/client'
import { tiFetchCache } from '../src/server/db/schema'
import { resetEnvForTests } from '../src/server/env'
import { classifyIndicator, radarCard } from '../src/server/ti/radar'
import { compareKey } from '../src/server/ti/compare'
import { makeOrg } from './helpers'

afterEach(() => {
  delete process.env.RADAR_ENABLED
  delete process.env.CLOUDFLARE_API_TOKEN
  resetEnvForTests()
})

describe('Cloudflare Radar connector (#64, Later)', () => {
  it('is off by default: no network call, no card', async () => {
    const fetchImpl = vi.fn()
    expect(await radarCard('8.8.8.8', { fetchImpl: fetchImpl as unknown as typeof fetch })).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
    const r = await compareKey(await makeOrg('NoRadar'), 'CVE-2026-0001')
    expect(r.sources.some((s) => s.source === 'cloudflare-radar')).toBe(false)
  })

  it('classifies indicators', () => {
    expect(classifyIndicator('1.2.3.4')).toBe('ip')
    expect(classifyIndicator('Example.COM')).toBe('domain')
    expect(classifyIndicator('CVE-2026-1')).toBeNull()
  })

  it('enriches an IP when enabled, with attribution, and never caches the token', async () => {
    process.env.RADAR_ENABLED = 'true'
    process.env.CLOUDFLARE_API_TOKEN = 'cf-test-token-value'
    resetEnvForTests()
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('https://api.cloudflare.com/client/v4/radar/entities/ip?ip=203.0.113.7&format=json')
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer cf-test-token-value')
      return Response.json({ success: true, result: { ip: { asn: '64500', asnName: 'EXAMPLE', asnOrgName: 'Example Net', locationName: 'Australia', ip: '203.0.113.7' } } })
    })
    const card = await radarCard('203.0.113.7', { fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(card?.present).toBe(true)
    expect(card?.title).toBe('AS64500 Example Net')
    expect(card?.attribution).toMatch(/Cloudflare Radar/)
    const cached = JSON.stringify(await getDb().select().from(tiFetchCache))
    expect(cached).not.toContain('cf-test-token-value')
  })

  it('failures degrade to an absent card, not an error', async () => {
    process.env.RADAR_ENABLED = 'true'
    process.env.CLOUDFLARE_API_TOKEN = 'x'
    resetEnvForTests()
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 500 }))
    const card = await radarCard('broken.example', { fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(card?.present).toBe(false)
  })
})
