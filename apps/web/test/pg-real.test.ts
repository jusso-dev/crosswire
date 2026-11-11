import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import path from 'node:path'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { eq } from 'drizzle-orm'
import { setDb, getDb, type Db } from '../src/server/db/client'
import * as schema from '../src/server/db/schema'
import { approveAndRunKql, createHunt, proposeKql } from '../src/server/hunting/hunts'
import { createSchedule, runDueSchedules } from '../src/server/hunting/schedules'
import { acquireRunSlot, acquireSlot, checkBudget, claimDailyBudget, recordObservedUsage, recordUnmeasuredUsage, releaseOnce, releaseRunSlot } from '../src/server/agents/budgets'
import { appendRunEvent, listRunEvents, reconcileStaleRuns, startRun } from '../src/server/agents/runs'
import { resetEnvForTests } from '../src/server/env'
import { makeOrg, team } from './helpers'
import { responseRaceSuite } from './response-races'

/**
 * Real Postgres (postgres-js driver) checks for queries PGlite accepts but production rejects, e.g.
 * bare Date params inside raw `sql` templates, plus approval races on parallel connections. Runs only
 * when PG_TEST_URL is set (CI service container). The suite DROPS the public schema, so it refuses any
 * URL that is not a local `*_test` database (#138). In CI a missing PG_TEST_URL fails instead of skipping.
 */
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1', '[::1]', 'postgres']

/** Why this URL is not a disposable local test database, or null when it is. */
function unsafeTestDbReason(raw: string): string | null {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return 'PG_TEST_URL is not a valid URL.'
  }
  const db = decodeURIComponent(u.pathname.replace(/^\//, ''))
  if (!LOCAL_HOSTS.includes(u.hostname)) return `PG_TEST_URL host "${u.hostname}" is not local. Use localhost, 127.0.0.1, ::1 or the CI service "postgres".`
  if (!db.endsWith('_test')) return `PG_TEST_URL database "${db || '(none)'}" does not end in "_test".`
  return null
}

const url = process.env.PG_TEST_URL
const refusal = url ? unsafeTestDbReason(url) : null
const d = url ? describe : describe.skip

describe('real Postgres test set-up', () => {
  it('is not skipped in CI', () => {
    if (process.env.CI && !url) throw new Error('PG_TEST_URL is not set. CI must run the real Postgres tests, not skip them.')
  })

  it('only accepts a local database whose name ends in _test', () => {
    expect(unsafeTestDbReason('postgres://crosswire:x@localhost:5432/crosswire_test')).toBeNull()
    expect(unsafeTestDbReason('postgres://u:x@postgres:5432/crosswire_test')).toBeNull()
    expect(unsafeTestDbReason('postgres://u:x@[::1]:5432/a_test')).toBeNull()
    expect(unsafeTestDbReason('postgres://u:x@localhost:5432/crosswire')).toMatch(/_test/)
    expect(unsafeTestDbReason('postgres://u:x@db.example.com:5432/crosswire_test')).toMatch(/not local/)
    expect(unsafeTestDbReason('postgres://u:x@crosswire.postgres.database.azure.com/crosswire_test')).toMatch(/not local/)
    expect(unsafeTestDbReason('not a url')).toMatch(/not a valid URL/)
  })
})

d('real Postgres (postgres-js)', () => {
  let client: ReturnType<typeof postgres>
  beforeAll(async () => {
    // Refuse before any SQL runs: this suite drops the public schema.
    if (refusal) throw new Error(`Refusing to run the real Postgres tests: ${refusal} This suite drops the public schema.`)
    client = postgres(url!, { max: 4, onnotice: () => {} })
    await client.unsafe('drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;')
    const db = drizzle(client, { schema })
    await migrate(db, { migrationsFolder: path.resolve(__dirname, '../drizzle') })
    setDb(db as unknown as Db)
  })
  afterAll(async () => {
    await client?.end({ timeout: 5 })
  })

  it('claims and runs a due schedule exactly once across concurrent workers', async () => {
    const t = await team()
    const hunt = await createHunt(t.orgId, t.analyst, { title: 'Real PG schedule' })
    const p = await proposeKql(t.orgId, { type: 'user', id: t.analyst }, { huntId: hunt.id, target: 'defender', kql: 'DeviceInfo | take 1' })
    await approveAndRunKql(t.orgId, t.analyst, p.id)
    const s = await createSchedule(t.orgId, { userId: t.approver, role: 'approver' }, { proposalId: p.id, intervalMinutes: 60 })
    const at = () => new Date(Date.now() + 61 * 60_000)
    const [a, b, c] = await Promise.all([runDueSchedules(at), runDueSchedules(at), runDueSchedules(at)])
    expect(a.ran + b.ran + c.ran).toBe(1)
    const [row] = await getDb().select().from(schema.huntSchedules).where(eq(schema.huntSchedules.id, s.id))
    expect(row!.lastStatus).toBe('run')
  })

  describe('approval races on parallel connections', () => {
    responseRaceSuite()
  })

  it('keeps an unset rate unpriced and releases one capacity slot', async () => {
    const orgId = await makeOrg('Pg budget')
    const savedSpend = process.env.BUDGET_MAX_SPEND_MICROS
    const savedRate = process.env.BUDGET_USD_PER_MILLION_TOKENS
    try {
      delete process.env.BUDGET_MAX_SPEND_MICROS
      delete process.env.BUDGET_USD_PER_MILLION_TOKENS
      resetEnvForTests()
      const stored = await recordObservedUsage({ orgId, agentKey: 'lead', provider: 'openai-compatible', model: 'mock', inputTokens: 100, outputTokens: 0 })
      expect(stored?.estimatedCostMicros).toBeNull()

      process.env.BUDGET_MAX_SPEND_MICROS = '1000000'
      process.env.BUDGET_USD_PER_MILLION_TOKENS = '2'
      resetEnvForTests()
      const refused = await checkBudget(orgId, { sessionId: 'pg', model: 'mock', text: 'hello' })
      expect(refused.ok).toBe(false)
      expect(refused.reason).toMatch(/unpriced/)

      await acquireSlot(orgId)
      await acquireSlot(orgId)
      const release = releaseOnce(orgId)
      await Promise.all([release(), release(), release()])
      const [capacity] = await getDb().select().from(schema.agentCapacity).where(eq(schema.agentCapacity.orgId, orgId))
      expect(capacity?.inflight).toBe(1)
    } finally {
      if (savedSpend === undefined) delete process.env.BUDGET_MAX_SPEND_MICROS
      else process.env.BUDGET_MAX_SPEND_MICROS = savedSpend
      if (savedRate === undefined) delete process.env.BUDGET_USD_PER_MILLION_TOKENS
      else process.env.BUDGET_USD_PER_MILLION_TOKENS = savedRate
      resetEnvForTests()
    }
  })

  it('refuses a call with no token count and returns a held slot once', async () => {
    const orgId = await makeOrg('Pg claim')
    const other = await makeOrg('Pg other')
    const savedSpend = process.env.BUDGET_MAX_SPEND_MICROS
    const savedRate = process.env.BUDGET_USD_PER_MILLION_TOKENS
    try {
      delete process.env.BUDGET_MAX_SPEND_MICROS
      delete process.env.BUDGET_USD_PER_MILLION_TOKENS
      resetEnvForTests()
      const run = await startRun({ orgId, agentKey: 'lead' })
      await recordUnmeasuredUsage({ orgId, runId: run!.id, agentKey: 'lead', provider: 'openai-compatible', model: 'mock' })
      const refused = await checkBudget(orgId, { sessionId: 'pg-unmeasured', model: 'mock', text: 'hello' })
      expect(refused.ok).toBe(false)
      expect(refused.reason).toMatch(/no token count/)
      await recordObservedUsage({ orgId: other, agentKey: 'lead', provider: 'openai-compatible', model: 'mock', inputTokens: 0, outputTokens: 0 })
      const zeroes = await checkBudget(other, { sessionId: 'pg-zero', model: 'mock', text: 'hello' })
      expect(zeroes.ok).toBe(true)

      const held = await startRun({ orgId, agentKey: 'hunter' })
      await acquireRunSlot(orgId, held!.id)
      const release = releaseOnce(orgId, held!.id)
      await Promise.all([release(), release()])
      const [once] = await getDb().select().from(schema.agentCapacity).where(eq(schema.agentCapacity.orgId, orgId))
      expect(once?.inflight).toBe(0)
      await getDb().update(schema.agentRuns).set({ startedAt: new Date(Date.now() - 10 * 60_000) }).where(eq(schema.agentRuns.id, held!.id))
      await reconcileStaleRuns()
      const [after] = await getDb().select().from(schema.agentCapacity).where(eq(schema.agentCapacity.orgId, orgId))
      expect(after?.inflight).toBe(0)
    } finally {
      if (savedSpend === undefined) delete process.env.BUDGET_MAX_SPEND_MICROS
      else process.env.BUDGET_MAX_SPEND_MICROS = savedSpend
      if (savedRate === undefined) delete process.env.BUDGET_USD_PER_MILLION_TOKENS
      else process.env.BUDGET_USD_PER_MILLION_TOKENS = savedRate
      resetEnvForTests()
    }
  })

  it('locks the org row so parallel daily reservations admit only what still fits', async () => {
    const orgId = await makeOrg('Pg reserve')
    const savedDaily = process.env.BUDGET_DAILY_INPUT_TOKENS
    const savedSpend = process.env.BUDGET_MAX_SPEND_MICROS
    const savedRate = process.env.BUDGET_USD_PER_MILLION_TOKENS
    try {
      process.env.BUDGET_DAILY_INPUT_TOKENS = '30'
      delete process.env.BUDGET_MAX_SPEND_MICROS
      delete process.env.BUDGET_USD_PER_MILLION_TOKENS
      resetEnvForTests()
      const text = 'x'.repeat(40)
      const runs = await Promise.all(Array.from({ length: 8 }, () => startRun({ orgId, agentKey: 'lead' })))
      const claimed = await Promise.all(runs.map((run) => claimDailyBudget(orgId, run!.id, { sessionId: run!.id, model: 'mock', text, agentKey: 'lead', provider: 'openai-compatible' })))
      expect(claimed.filter((row) => row.ok)).toHaveLength(3)
      expect(claimed.filter((row) => !row.ok).every((row) => /exhausted/.test(row.reason ?? ''))).toBe(true)
    } finally {
      if (savedDaily === undefined) delete process.env.BUDGET_DAILY_INPUT_TOKENS
      else process.env.BUDGET_DAILY_INPUT_TOKENS = savedDaily
      if (savedSpend === undefined) delete process.env.BUDGET_MAX_SPEND_MICROS
      else process.env.BUDGET_MAX_SPEND_MICROS = savedSpend
      if (savedRate === undefined) delete process.env.BUDGET_USD_PER_MILLION_TOKENS
      else process.env.BUDGET_USD_PER_MILLION_TOKENS = savedRate
      resetEnvForTests()
    }
  })

  it('parallel run-event writes on separate connections get distinct sequence numbers (#191)', async () => {
    const orgId = await makeOrg('Pg events')
    const run = await startRun({ orgId, agentKey: 'lead' })
    await Promise.all(Array.from({ length: 8 }, (_, i) => appendRunEvent(run!.id, orgId, 'probe', { i })))
    const seqs = (await listRunEvents(orgId, run!.id)).map((e) => e.seq)
    expect(seqs).toEqual(Array.from({ length: 9 }, (_, i) => i + 1))
  })

  it('parallel slot acquire and release on separate connections leave the count exact (#191)', async () => {
    const orgId = await makeOrg('Pg slots')
    const runs = await Promise.all(Array.from({ length: 6 }, () => startRun({ orgId, agentKey: 'lead' })))
    await Promise.all(runs.map((r) => acquireRunSlot(orgId, r!.id)))
    const [mid] = await getDb().select().from(schema.agentCapacity).where(eq(schema.agentCapacity.orgId, orgId))
    expect(mid?.inflight).toBe(6)
    await Promise.all(runs.flatMap((r) => [releaseRunSlot(orgId, r!.id), releaseRunSlot(orgId, r!.id)]))
    const [after] = await getDb().select().from(schema.agentCapacity).where(eq(schema.agentCapacity.orgId, orgId))
    expect(after?.inflight).toBe(0)
  })
})
