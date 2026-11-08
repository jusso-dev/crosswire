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
import { createProposal, decideProposal, expireProposals } from '../src/server/response/proposals'
import { acquireRunSlot, acquireSlot, checkBudget, claimDailyBudget, recordObservedUsage, recordUnmeasuredUsage, releaseOnce } from '../src/server/agents/budgets'
import { reconcileStaleRuns, startRun } from '../src/server/agents/runs'
import { resetEnvForTests } from '../src/server/env'
import { makeOrg, team } from './helpers'

/**
 * Real Postgres (postgres-js driver) checks for queries PGlite accepts but production rejects, e.g.
 * bare Date params inside raw `sql` templates. Runs only when PG_TEST_URL is set (CI service container);
 * the database is dropped and recreated in a dedicated schema-free test DB.
 */
const url = process.env.PG_TEST_URL
const d = url ? describe : describe.skip

d('real Postgres (postgres-js)', () => {
  let client: ReturnType<typeof postgres>
  beforeAll(async () => {
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

  it('expires lapsed pending and approved-unexecuted proposals', async () => {
    const t = await team()
    const p = await createProposal(t.orgId, { type: 'user', userId: t.analyst }, { title: 'x x x', actionType: 'other', targets: { users: ['u'] }, blastRadius: { summary: 'manual test action' } })
    await decideProposal(t.orgId, { userId: t.approver, role: 'approver' }, p.id, 'approve')
    expect(await expireProposals(new Date(Date.now() + 48 * 3600_000))).toBeGreaterThanOrEqual(1)
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
})
