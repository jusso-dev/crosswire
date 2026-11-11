import { afterEach, expect, it } from 'vitest'
import { and, eq, inArray } from 'drizzle-orm'
import { getDb } from '../src/server/db/client'
import { responseEvents, responseProposals } from '../src/server/db/schema'
import { resetEnvForTests } from '../src/server/env'
import { createProposal, decideProposal, executeProposal, expireProposals, failStaleExecutions, listEvents, STALE_EXECUTION_ERROR } from '../src/server/response/proposals'
import { team } from './helpers'

/**
 * Races on the approval model (#139, #121), shared by the PGlite suite (response-concurrency.test.ts)
 * and the real-Postgres suite (pg-real.test.ts). Call inside a `describe`. The single-decision rule
 * and the atomic execution claim (`isNull(execution)`) are what these prove: removing the claim guard
 * makes "two concurrent executions run the executor once" fail on both drivers.
 */

const ENV = ['RESPONSE_EXECUTOR_LOGICAPP', 'RESPONSE_LOGICAPP_URL', 'RESPONSE_LOGICAPP_ORG_ID', 'RESPONSE_DRY_RUN'] as const
const base = {
  title: 'Run the containment Logic App',
  actionType: 'logic_app' as const,
  targets: { devices: ['race-wks-001'] },
  blastRadius: { summary: 'One workstation loses network access except to Defender.' },
  payload: { action: 'isolate' },
}

function liveLogicApp() {
  Object.assign(process.env, { RESPONSE_DRY_RUN: 'false', RESPONSE_EXECUTOR_LOGICAPP: 'on', RESPONSE_LOGICAPP_URL: 'https://mock.logic.example/invoke?sig=race-test' })
  resetEnvForTests()
}

/** A fetch that counts calls and answers slowly, so racing callers overlap inside the executor. */
function countingFetch() {
  const counter = { calls: 0 }
  const fetchImpl = (async () => {
    counter.calls++
    await new Promise((r) => setTimeout(r, 25))
    return Response.json({ runId: 'run-1' }, { status: 202 })
  }) as unknown as typeof fetch
  return { counter, fetchImpl }
}

async function approved() {
  const t = await team()
  // The Logic App acts for one organisation (#190): bind it to this test's org.
  process.env.RESPONSE_LOGICAPP_ORG_ID = t.orgId
  resetEnvForTests()
  const p = await createProposal(t.orgId, { type: 'user', userId: t.analyst }, base)
  await decideProposal(t.orgId, { userId: t.approver, role: 'approver' }, p.id, 'approve')
  return { t, p }
}

const statusOf = async (id: string) => (await getDb().select({ status: responseProposals.status }).from(responseProposals).where(eq(responseProposals.id, id)))[0]?.status

export function responseRaceSuite() {
  afterEach(() => {
    for (const k of ENV) delete process.env[k]
    resetEnvForTests()
  })

  it('two concurrent executions run the executor exactly once', async () => {
    liveLogicApp()
    const { t, p } = await approved()
    const { counter, fetchImpl } = countingFetch()
    const results = await Promise.allSettled([
      executeProposal(t.orgId, { userId: t.approver, role: 'approver' }, p.id, fetchImpl),
      executeProposal(t.orgId, { userId: t.owner, role: 'owner' }, p.id, fetchImpl),
    ])
    expect(counter.calls).toBe(1)
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
    expect(String(refused.reason)).toMatch(/Execution already started|Only approved proposals/)
    const events = (await listEvents(t.orgId, p.id)).map((e) => e.event)
    expect(events.filter((e) => e === 'execute_attempt')).toHaveLength(1)
    expect(events.filter((e) => e === 'executed')).toHaveLength(1)
    expect(await statusOf(p.id)).toBe('executed')
  })

  it('the claim records live mode, so an interrupted execution never reads as a dry run', async () => {
    liveLogicApp()
    const { t, p } = await approved()
    let seen: Record<string, unknown> | null = null
    const fetchImpl = (async () => {
      // Read the row while the call is in flight: this is what the page shows if the process stops now.
      ;[{ execution: seen }] = (await getDb().select({ execution: responseProposals.execution }).from(responseProposals).where(eq(responseProposals.id, p.id))) as [{ execution: Record<string, unknown> | null }]
      return Response.json({}, { status: 202 })
    }) as unknown as typeof fetch
    await executeProposal(t.orgId, { userId: t.approver, role: 'approver' }, p.id, fetchImpl)
    expect(seen).toMatchObject({ status: 'in_progress', mode: 'live', by: t.approver })
  })

  it('concurrent approve and reject store exactly one decision and one event', async () => {
    const t = await team()
    const p = await createProposal(t.orgId, { type: 'user', userId: t.analyst }, base)
    const results = await Promise.allSettled([
      decideProposal(t.orgId, { userId: t.approver, role: 'approver' }, p.id, 'approve', 'approve it'),
      decideProposal(t.orgId, { userId: t.owner, role: 'owner' }, p.id, 'reject', 'reject it'),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(String((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason)).toMatch(/already/)
    const decisions = await getDb()
      .select({ event: responseEvents.event })
      .from(responseEvents)
      .where(and(eq(responseEvents.proposalId, p.id), inArray(responseEvents.event, ['approved', 'rejected'])))
    expect(decisions).toHaveLength(1)
    const [row] = await getDb().select().from(responseProposals).where(eq(responseProposals.id, p.id))
    // The stored decision, decider and comment all belong to the one that won.
    expect(row!.status).toBe(decisions[0]!.event)
    expect(row!.decidedBy).toBe(row!.status === 'approved' ? t.approver : t.owner)
    expect(row!.decisionComment).toBe(row!.status === 'approved' ? 'approve it' : 'reject it')
  })

  it('an expired proposal never executes, even racing the expiry job', async () => {
    liveLogicApp()
    const { t, p } = await approved()
    await getDb().update(responseProposals).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(responseProposals.id, p.id))
    const { counter, fetchImpl } = countingFetch()
    const results = await Promise.allSettled([
      executeProposal(t.orgId, { userId: t.approver, role: 'approver' }, p.id, fetchImpl),
      expireProposals(),
      executeProposal(t.orgId, { userId: t.owner, role: 'owner' }, p.id, fetchImpl),
    ])
    expect(counter.calls).toBe(0)
    expect(results[0]!.status).toBe('rejected')
    expect(results[2]!.status).toBe('rejected')
    expect(await statusOf(p.id)).toBe('expired')
    expect((await listEvents(t.orgId, p.id)).map((e) => e.event)).not.toContain('execute_attempt')
  })

  it('approve racing expiry never approves a lapsed proposal', async () => {
    const t = await team()
    const p = await createProposal(t.orgId, { type: 'user', userId: t.analyst }, base)
    await getDb().update(responseProposals).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(responseProposals.id, p.id))
    const [decided] = await Promise.allSettled([decideProposal(t.orgId, { userId: t.approver, role: 'approver' }, p.id, 'approve'), expireProposals()])
    expect(decided.status).toBe('rejected')
    expect(await statusOf(p.id)).toBe('expired')
    expect((await listEvents(t.orgId, p.id)).map((e) => e.event)).not.toContain('approved')
  })

  it('expiry counts exactly: pending and approved-unexecuted expire, claimed and decided do not', async () => {
    const later = new Date(Date.now() + 48 * 3600_000)
    // Clear anything an earlier test left open, so the next count is exact.
    await expireProposals(later)
    const t = await team()
    const mk = (title: string) => createProposal(t.orgId, { type: 'user', userId: t.analyst }, { ...base, title })
    const approver = { userId: t.approver, role: 'approver' as const }
    const pending = [await mk('pending one'), await mk('pending two')]
    const approvedOpen = [await mk('approved one'), await mk('approved two'), await mk('approved three')]
    for (const p of approvedOpen) await decideProposal(t.orgId, approver, p.id, 'approve')
    const claimed = await mk('approved and claimed')
    await decideProposal(t.orgId, approver, claimed.id, 'approve')
    await getDb().update(responseProposals).set({ execution: { status: 'in_progress', mode: 'live', by: t.approver, at: new Date().toISOString() } }).where(eq(responseProposals.id, claimed.id))
    const rejected = await mk('rejected one')
    await decideProposal(t.orgId, approver, rejected.id, 'reject')

    expect(await expireProposals(later)).toBe(pending.length + approvedOpen.length)
    for (const p of pending) expect(await statusOf(p.id)).toBe('expired')
    for (const p of approvedOpen) expect(await statusOf(p.id)).toBe('expired')
    expect(await statusOf(claimed.id)).toBe('approved')
    expect(await statusOf(rejected.id)).toBe('rejected')
    const expiredEvents = await getDb().select({ id: responseEvents.id }).from(responseEvents).where(and(eq(responseEvents.orgId, t.orgId), eq(responseEvents.event, 'expired')))
    expect(expiredEvents).toHaveLength(5)
    // Nothing left to expire: a second run is a no-op.
    expect(await expireProposals(later)).toBe(0)
  })

  it('the stale-claim sweep fails old in-progress claims once, keeps fresh ones, and never retries', async () => {
    const { t, p: old } = await approved()
    const fresh = await createProposal(t.orgId, { type: 'user', userId: t.analyst }, { ...base, title: 'fresh claim' })
    await decideProposal(t.orgId, { userId: t.approver, role: 'approver' }, fresh.id, 'approve')
    const claimAt = (ms: number) => ({ status: 'in_progress', mode: 'live', by: t.approver, at: new Date(Date.now() - ms).toISOString() })
    await getDb().update(responseProposals).set({ execution: claimAt(11 * 60_000) }).where(eq(responseProposals.id, old.id))
    await getDb().update(responseProposals).set({ execution: claimAt(60_000) }).where(eq(responseProposals.id, fresh.id))

    const [a, b] = await Promise.all([failStaleExecutions(), failStaleExecutions()])
    expect(a + b).toBe(1)
    const [row] = await getDb().select().from(responseProposals).where(eq(responseProposals.id, old.id))
    expect(row!.status).toBe('failed')
    expect(row!.execution).toMatchObject({ status: 'failed', mode: 'live', by: t.approver, error: STALE_EXECUTION_ERROR })
    const failed = (await listEvents(t.orgId, old.id)).filter((e) => e.event === 'execute_failed')
    expect(failed).toHaveLength(1)
    expect(failed[0]!.data).toMatchObject({ reason: 'stale_claim' })
    expect(failed[0]!.actorType).toBe('system')
    expect(await statusOf(fresh.id)).toBe('approved')

    // Never retried: a failed proposal cannot be executed again, and a second sweep does nothing.
    await expect(executeProposal(t.orgId, { userId: t.approver, role: 'approver' }, old.id)).rejects.toThrow(/Only approved/)
    expect(await failStaleExecutions()).toBe(0)
  })
}
