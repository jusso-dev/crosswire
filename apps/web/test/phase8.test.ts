import { afterEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '../src/server/db/client'
import { huntCases, responseProposals, watchHits } from '../src/server/db/schema'
import { parseEnv, resetEnvForTests, responseSafety } from '../src/server/env'
import { executorMode } from '../src/server/response/executors'
import { createProposal, decideProposal, executeProposal } from '../src/server/response/proposals'
import { loadDemoFixtures } from '../src/server/ops/fixtures'
import { setupChecklist } from '../src/server/ops/setup'
import { migrationStatus } from '../src/server/ops/migrations'
import { RateLimiter, corsHeaders, securityHeaders } from '../src/server/lib/http-security'
import { makeUser, member, team } from './helpers'

const PROD = { NODE_ENV: 'production', APP_URL: 'https://cw.example.com', DATABASE_URL: 'postgres://u:p@h/db', BETTER_AUTH_SECRET: 'x'.repeat(40), APP_ENCRYPTION_KEY: 'a'.repeat(64) }

afterEach(() => {
  for (const k of ['RESPONSE_DRY_RUN', 'RESPONSE_EXECUTOR_LOGICAPP', 'RESPONSE_LOGICAPP_URL', 'CORS_ALLOWED_ORIGINS']) delete process.env[k]
  resetEnvForTests()
})

describe('default-safe response flags (#83)', () => {
  it('unset flags => dry-run ON, executors OFF', () => {
    const s = responseSafety(parseEnv(PROD))
    expect(s.dryRun).toBe(true)
    expect(s.executors).toEqual({ sentinel: 'off', logicapp: 'off', graph: 'off' })
  })

  it('executor=on without explicit RESPONSE_DRY_RUN=false fails closed to dry-run with a warning', () => {
    const s = responseSafety(parseEnv({ ...PROD, RESPONSE_EXECUTOR_LOGICAPP: 'on' }))
    expect(s.executors.logicapp).toBe('dry-run')
    expect(s.warnings.join()).toMatch(/RESPONSE_DRY_RUN/)
    const ambiguous = responseSafety(parseEnv({ ...PROD, RESPONSE_EXECUTOR_LOGICAPP: 'on', RESPONSE_DRY_RUN: '' }))
    expect(ambiguous.executors.logicapp).toBe('dry-run')
  })

  it('explicit RESPONSE_DRY_RUN=false allows a live executor', () => {
    const s = responseSafety(parseEnv({ ...PROD, RESPONSE_EXECUTOR_LOGICAPP: 'on', RESPONSE_DRY_RUN: 'false' }))
    expect(s.dryRun).toBe(false)
    expect(s.executors.logicapp).toBe('on')
  })

  it('execute on an approved proposal only dry-runs while the global guard is on', async () => {
    process.env.RESPONSE_EXECUTOR_LOGICAPP = 'on'
    process.env.RESPONSE_LOGICAPP_URL = 'https://mock.logic.example/x'
    resetEnvForTests()
    expect(executorMode('logic_app')).toBe('dry-run')
    const t = await team()
    const p = await createProposal(t.orgId, { type: 'user', userId: t.analyst }, { title: 'Isolate x', actionType: 'logic_app', targets: { devices: ['d1'] }, blastRadius: { summary: 'One device isolated.' } })
    await decideProposal(t.orgId, { userId: t.owner, role: 'owner' }, p.id, 'approve')
    const fetchImpl = vi.fn()
    const out = await executeProposal(t.orgId, { userId: t.owner, role: 'owner' }, p.id, fetchImpl as unknown as typeof fetch)
    expect(out.mode).toBe('dry-run')
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('demo fixtures + setup checklist (#77, #79)', () => {
  it('loads an obviously fake pack idempotently; watch, hunt and approval data exist', async () => {
    const t = await team()
    const r = await loadDemoFixtures(t.orgId, t.owner)
    expect(r.loaded).toBe(true)
    expect((await loadDemoFixtures(t.orgId, t.owner)).loaded).toBe(false)
    const hunts = await getDb().select().from(huntCases).where(eq(huntCases.orgId, t.orgId))
    expect(hunts.every((h) => h.title.startsWith('[DEMO]'))).toBe(true)
    const [prop] = await getDb().select().from(responseProposals).where(eq(responseProposals.orgId, t.orgId))
    expect(prop!.title).toMatch(/^\[DEMO\]/)
    expect(prop!.status).toBe('pending')
    expect(prop!.lastDryRun).toBeTruthy()
    const hits = await getDb().select().from(watchHits).where(eq(watchHits.orgId, t.orgId))
    expect(hits.length).toBeGreaterThan(0)
  })

  it('checklist reflects real signals', async () => {
    const t = await team()
    const before = await setupChecklist(t.orgId)
    expect(before.items.find((i) => i.key === 'watchlist')!.done).toBe(false)
    expect(before.items.find((i) => i.key === 'dryrun')!.done).toBe(true)
    expect(before.items.find((i) => i.key === 'hunting')!.done).toBe(false)
    await loadDemoFixtures(t.orgId, t.owner)
    const after = await setupChecklist(t.orgId)
    expect(after.items.find((i) => i.key === 'watchlist')!.done).toBe(true)
  })
})

describe('migrations status (#69)', () => {
  it('reports the applied migration as up to date with the shipped journal', async () => {
    const s = await migrationStatus()
    expect(s.upToDate).toBe(true)
    expect(s.expected).toMatch(/^\d{4}_/)
  })
})

describe('security headers, CORS, rate limits (#74)', () => {
  it('sets CSP and HSTS on https only', () => {
    expect(securityHeaders(true)['Strict-Transport-Security']).toMatch(/max-age/)
    expect(securityHeaders(false)['Strict-Transport-Security']).toBeUndefined()
    expect(securityHeaders(false)['Content-Security-Policy']).toMatch(/frame-ancestors 'none'/)
  })

  it('CORS allows APP_URL and configured origins only; never *', () => {
    process.env.CORS_ALLOWED_ORIGINS = 'https://soc.contoso.example, *'
    resetEnvForTests()
    expect(corsHeaders('http://localhost:3000')?.['Access-Control-Allow-Origin']).toBe('http://localhost:3000')
    expect(corsHeaders('https://soc.contoso.example')).not.toBeNull()
    expect(corsHeaders('https://evil.example')).toBeNull()
    expect(corsHeaders(null)).toBeNull()
  })

  it('rate limiter blocks after the limit within the window and resets after it', () => {
    const rl = new RateLimiter(2, 1000)
    expect(rl.check('a', 0).ok).toBe(true)
    expect(rl.check('a', 1).ok).toBe(true)
    const blocked = rl.check('a', 2)
    expect(blocked.ok).toBe(false)
    expect(blocked.retryAfterSec).toBe(1)
    expect(rl.check('b', 2).ok).toBe(true)
    expect(rl.check('a', 1001).ok).toBe(true)
  })
})

describe('member helper sanity', () => {
  it('member() is idempotent-safe for distinct users', async () => {
    const t = await team()
    const u = await makeUser()
    await member(t.orgId, u)
  })
})

describe('phase 8 council regressions', () => {
  it('demo fixtures never write shared TI tables and only touch the loading org', async () => {
    const { cveRecords, pwnIncidents } = await import('../src/server/db/schema')
    const a = await team()
    const b = await team()
    const { addWatch } = await import('../src/server/ti/watchlists')
    await addWatch(b.orgId, b.owner, { type: 'tag', value: 'cisa-kev' })
    await loadDemoFixtures(a.orgId, a.owner)
    expect(await getDb().select().from(cveRecords)).toHaveLength(0)
    expect(await getDb().select().from(pwnIncidents)).toHaveLength(0)
    expect(await getDb().select().from(watchHits).where(eq(watchHits.orgId, b.orgId))).toHaveLength(0)
    const hitsA = await getDb().select().from(watchHits).where(eq(watchHits.orgId, a.orgId))
    expect(hitsA.every((h) => h.source.startsWith('demo:'))).toBe(true)
  })

  it('demo fixtures refuse when the org has a real hunting connector', async () => {
    const { upsertConnector } = await import('../src/server/hunting/broker')
    const t = await team()
    await upsertConnector(t.orgId, { tenantId: '0f0e0d0c-0b0a-0908-0706-050403020100', clientId: '01020304-0506-0708-090a-0b0c0d0e0f10', clientSecret: 'x' })
    await expect(loadDemoFixtures(t.orgId, t.owner)).rejects.toThrow(/demo mode/)
  })

  it('rate-limit client key ignores client-supplied left-hand XFF entries and skips trusted proxies', async () => {
    const { clientKey } = await import('../src/server/lib/http-security')
    const req = (xff: string) => new Request('http://x/api/chat', { headers: { 'x-forwarded-for': xff } })
    expect(clientKey(req('1.1.1.1, 9.9.9.9'), new Set())).toBe('9.9.9.9')
    expect(clientKey(req('spoof, 203.0.113.5, 10.0.0.2'), new Set(['10.0.0.2']))).toBe('203.0.113.5')
  })
})
