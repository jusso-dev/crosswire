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
import { team } from './helpers'

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
})
