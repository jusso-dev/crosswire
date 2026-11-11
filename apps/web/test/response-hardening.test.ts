import { afterEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '../src/server/db/client'
import { responseProposals } from '../src/server/db/schema'
import { approvalSafetyWarnings, parseEnv, resetEnvForTests, startupWarnings } from '../src/server/env'
import { dryRun, liveClaimDeadline, type ExecContext, type ProposalForExecution } from '../src/server/response/executors'
import {
  auditBundle,
  createProposal,
  decideProposal,
  executeProposal,
  failStaleExecutions,
  getProposal,
  listEvents,
  STALE_EXECUTION_ERROR,
} from '../src/server/response/proposals'
import { team } from './helpers'

const LOGIC_APP = { RESPONSE_DRY_RUN: 'false', RESPONSE_EXECUTOR_LOGICAPP: 'on', RESPONSE_LOGICAPP_URL: 'https://mock.logic.example/invoke?sig=hardening' }
const ENV_KEYS = [...Object.keys(LOGIC_APP), 'RESPONSE_LOGICAPP_ORG_ID', 'RESPONSE_MAX_LIVE_TARGETS', 'RESPONSE_ALLOW_SELF_APPROVAL', 'APPROVAL_BINDING']

function withEnv(vars: Record<string, string>) {
  Object.assign(process.env, vars)
  resetEnvForTests()
}
afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k]
  resetEnvForTests()
})

const base = {
  title: 'Run the containment Logic App',
  actionType: 'logic_app' as const,
  targets: { devices: ['wks-001'] },
  blastRadius: { summary: 'One workstation loses network access except to Defender.' },
  payload: { action: 'isolate' },
}

type Team = Awaited<ReturnType<typeof team>>
async function approvedBy(t: Team, input: Parameters<typeof createProposal>[2] = base, requester = t.analyst, approver = t.approver) {
  const p = await createProposal(t.orgId, { type: 'user', userId: requester }, input)
  await decideProposal(t.orgId, { userId: approver, role: 'approver' }, p.id, 'approve')
  return p
}

const ok = () => vi.fn(async () => Response.json({ runId: 'run-1' }, { status: 202 })) as unknown as typeof fetch & ReturnType<typeof vi.fn>

async function expectRefusedUnclaimed(t: Team, id: string, pattern: RegExp) {
  const f = ok()
  await expect(executeProposal(t.orgId, { userId: t.approver, role: 'approver' }, id, f)).rejects.toThrow(pattern)
  expect(f).not.toHaveBeenCalled()
  const row = await getProposal(t.orgId, id)
  expect(row!.status).toBe('approved')
  expect(row!.execution).toBeNull()
}

describe('Logic App executor is bound to one organisation (#190)', () => {
  it('refuses every proposal when RESPONSE_LOGICAPP_ORG_ID is unset', async () => {
    withEnv(LOGIC_APP)
    const t = await team()
    const p = await approvedBy(t)
    await expectRefusedUnclaimed(t, p.id, /RESPONSE_LOGICAPP_ORG_ID is not configured/)
  })

  it("refuses another organisation's proposal before claiming or calling, and runs the bound one", async () => {
    withEnv(LOGIC_APP)
    const bound = await team()
    const other = await team()
    withEnv({ RESPONSE_LOGICAPP_ORG_ID: bound.orgId })
    const theirs = await approvedBy(other)
    await expectRefusedUnclaimed(other, theirs.id, /bound to another organisation/)

    const ours = await approvedBy(bound)
    const f = ok()
    expect((await executeProposal(bound.orgId, { userId: bound.approver, role: 'approver' }, ours.id, f)).status).toBe('succeeded')
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('applies RESPONSE_MAX_LIVE_TARGETS across devices, users and incidents', async () => {
    withEnv(LOGIC_APP)
    const t = await team()
    withEnv({ RESPONSE_LOGICAPP_ORG_ID: t.orgId, RESPONSE_MAX_LIVE_TARGETS: '10' })
    const many = await approvedBy(t, { ...base, targets: { devices: Array.from({ length: 6 }, (_, i) => `wks-${i}`), users: Array.from({ length: 5 }, (_, i) => `u${i}@example.test`) } })
    await expectRefusedUnclaimed(t, many.id, /11 targets exceeds RESPONSE_MAX_LIVE_TARGETS=10/)
    const big = await approvedBy(t, { ...base, targets: { devices: Array.from({ length: 50 }, (_, i) => `wks-${i}`), users: Array.from({ length: 50 }, (_, i) => `u${i}`), incidents: Array.from({ length: 50 }, (_, i) => `inc-${i}`) } })
    await expectRefusedUnclaimed(t, big.id, /150 targets exceeds/)
  })

  it('allows only known action values', async () => {
    withEnv(LOGIC_APP)
    const t = await team()
    withEnv({ RESPONSE_LOGICAPP_ORG_ID: t.orgId })
    const free = await approvedBy(t, { ...base, payload: { action: 'delete_all_mailboxes' } })
    await expectRefusedUnclaimed(t, free.id, /payload.action must be one of/)
    const notText = await approvedBy(t, { ...base, payload: { action: { nested: true } } })
    await expectRefusedUnclaimed(t, notText.id, /payload.action must be one of/)
    // No action means the documented default, `contain`.
    const plain = await approvedBy(t, { ...base, payload: {} })
    const f = ok()
    await executeProposal(t.orgId, { userId: t.approver, role: 'approver' }, plain.id, f)
    expect(JSON.parse(String((f.mock.calls[0] as unknown as [string, RequestInit])[1].body)).action).toBe('contain')
  })

  it('a demo proposal never runs live, for any executor', async () => {
    withEnv(LOGIC_APP)
    const t = await team()
    withEnv({ RESPONSE_LOGICAPP_ORG_ID: t.orgId })
    const demo = await approvedBy(t, { ...base, payload: { action: 'isolate', demo: true } })
    await expectRefusedUnclaimed(t, demo.id, /Demo fixture/)
    // Every executor's plan carries the same block, so a dry run shows it too.
    const ctx: ExecContext = { responseTenantId: 't', responseHasCredential: true, playbookAllowlist: [], workspace: null }
    const graph: ProposalForExecution = { id: 'x', orgId: t.orgId, actionType: 'graph_containment', targets: { devices: ['a'.repeat(40)] }, payload: { action: 'isolate', demo: true } }
    expect(dryRun(graph, ctx).blocked).toContain('Demo fixture: demo proposals never run live.')
  })
})

describe('live claim deadline and guarded final write (#204)', () => {
  const ctx: ExecContext = { responseTenantId: 't', responseHasCredential: true, playbookAllowlist: [], workspace: null }

  it('the deadline covers every call at its timeout, beyond the old 10-minute sweep', () => {
    const p = (n: number): ProposalForExecution => ({ id: 'x', orgId: 'o', actionType: 'graph_containment', targets: { devices: Array.from({ length: n }, (_, i) => i.toString(16).padStart(40, '0')) }, payload: {} })
    const start = new Date('2026-11-11T00:00:00.000Z')
    const minutes = (d: Date) => (d.getTime() - start.getTime()) / 60_000
    expect(minutes(liveClaimDeadline(p(1), ctx, start))).toBeGreaterThan(10)
    // 50 calls at 30 seconds each (plus token time) is more than 25 minutes.
    expect(minutes(liveClaimDeadline(p(50), ctx, start))).toBeGreaterThan(25 + 10)
  })

  it('the claim stores its deadline and the sweep leaves it alone until then', async () => {
    withEnv(LOGIC_APP)
    const t = await team()
    withEnv({ RESPONSE_LOGICAPP_ORG_ID: t.orgId })
    const p = await approvedBy(t)
    let claim: Record<string, unknown> | null = null
    let sweptEarly = -1
    const f = (async () => {
      ;[{ execution: claim }] = (await getDb().select({ execution: responseProposals.execution }).from(responseProposals).where(eq(responseProposals.id, p.id))) as [{ execution: Record<string, unknown> }]
      // Ten and a half minutes in: the old fixed 10-minute cutoff would have failed this claim.
      sweptEarly = await failStaleExecutions(undefined, new Date(Date.now() + 10.5 * 60_000))
      return Response.json({}, { status: 202 })
    }) as unknown as typeof fetch
    expect((await executeProposal(t.orgId, { userId: t.approver, role: 'approver' }, p.id, f)).status).toBe('succeeded')
    expect(claim).toMatchObject({ status: 'in_progress', mode: 'live', deadline: expect.any(String) })
    expect(new Date(String(claim!.deadline)).getTime()).toBeGreaterThan(new Date(String(claim!.at)).getTime() + 10.5 * 60_000)
    expect(sweptEarly).toBe(0)
    expect((await getProposal(t.orgId, p.id))!.status).toBe('executed')
  })

  it('a slow run that outlasts its deadline keeps the sweep record; the late result is an event only', async () => {
    withEnv(LOGIC_APP)
    const t = await team()
    withEnv({ RESPONSE_LOGICAPP_ORG_ID: t.orgId })
    const p = await approvedBy(t)
    const slow = (async () => {
      // The sweep runs past the deadline while the call is still going.
      expect(await failStaleExecutions(undefined, new Date(Date.now() + 24 * 3600_000))).toBe(1)
      return Response.json({}, { status: 202 })
    }) as unknown as typeof fetch
    const out = await executeProposal(t.orgId, { userId: t.approver, role: 'approver' }, p.id, slow)
    expect(out.status).toBe('succeeded')
    const row = await getProposal(t.orgId, p.id)
    expect(row!.status).toBe('failed')
    expect(row!.execution).toMatchObject({ status: 'failed', error: STALE_EXECUTION_ERROR })
    const events = await listEvents(t.orgId, p.id)
    const stale = events.find((e) => e.event === 'execute_failed' && e.data.reason === 'stale_claim')
    const late = events.find((e) => e.event === 'executed')
    expect(stale).toBeTruthy()
    expect(late!.data).toMatchObject({ lateResult: true, status: 'succeeded' })
  })

  it('the final write only touches this org and an in-progress claim', async () => {
    withEnv(LOGIC_APP)
    const t = await team()
    withEnv({ RESPONSE_LOGICAPP_ORG_ID: t.orgId })
    const p = await approvedBy(t)
    const f = (async () => {
      // Something else closes the claim mid-run (for example an operator marks it failed).
      await getDb().update(responseProposals).set({ status: 'failed', execution: { status: 'failed', mode: 'live', error: 'closed by hand' } }).where(eq(responseProposals.id, p.id))
      return Response.json({}, { status: 202 })
    }) as unknown as typeof fetch
    await executeProposal(t.orgId, { userId: t.approver, role: 'approver' }, p.id, f)
    const row = await getProposal(t.orgId, p.id)
    expect(row!.status).toBe('failed')
    expect(row!.execution).toMatchObject({ error: 'closed by hand' })
  })
})

describe('approval controls are recorded (#205)', () => {
  it('a normal two-person approval records selfApproved false and bindingEnforced true', async () => {
    withEnv(LOGIC_APP)
    const t = await team()
    withEnv({ RESPONSE_LOGICAPP_ORG_ID: t.orgId })
    const p = await approvedBy(t)
    await executeProposal(t.orgId, { userId: t.approver, role: 'approver' }, p.id, ok())
    const byKind = Object.fromEntries((await listEvents(t.orgId, p.id)).map((e) => [e.event, e.data]))
    for (const kind of ['approved', 'execute_attempt', 'executed']) expect(byKind[kind]).toMatchObject({ selfApproved: false, bindingEnforced: true })
    expect((await auditBundle(t.orgId, p.id)).approvalControls).toEqual({ requestedByUserId: t.analyst, decidedBy: t.approver, selfApproved: false, bindingEnforced: true })
  })

  it('self-approval stays off by default, and when allowed it is marked on every event and in the bundle', async () => {
    withEnv(LOGIC_APP)
    const t = await team()
    withEnv({ RESPONSE_LOGICAPP_ORG_ID: t.orgId })
    const p = await createProposal(t.orgId, { type: 'user', userId: t.approver }, base)
    await expect(decideProposal(t.orgId, { userId: t.approver, role: 'approver' }, p.id, 'approve')).rejects.toThrow(/self-approval is off/)
    withEnv({ RESPONSE_ALLOW_SELF_APPROVAL: 'true' })
    await decideProposal(t.orgId, { userId: t.approver, role: 'approver' }, p.id, 'approve')
    await executeProposal(t.orgId, { userId: t.approver, role: 'approver' }, p.id, ok())
    const byKind = Object.fromEntries((await listEvents(t.orgId, p.id)).map((e) => [e.event, e.data]))
    for (const kind of ['approved', 'execute_attempt', 'executed']) expect(byKind[kind]).toMatchObject({ selfApproved: true })
    expect((await auditBundle(t.orgId, p.id)).approvalControls).toMatchObject({ selfApproved: true, requestedByUserId: t.approver, decidedBy: t.approver })
  })

  it('APPROVAL_BINDING=legacy is marked bindingEnforced false on the decision, the execution and the bundle', async () => {
    withEnv(LOGIC_APP)
    const t = await team()
    withEnv({ RESPONSE_LOGICAPP_ORG_ID: t.orgId, APPROVAL_BINDING: 'legacy' })
    const p = await approvedBy(t)
    await executeProposal(t.orgId, { userId: t.approver, role: 'approver' }, p.id, ok())
    const byKind = Object.fromEntries((await listEvents(t.orgId, p.id)).map((e) => [e.event, e.data]))
    for (const kind of ['approved', 'execute_attempt', 'executed']) expect(byKind[kind]).toMatchObject({ bindingEnforced: false })
    expect((await auditBundle(t.orgId, p.id)).approvalControls.bindingEnforced).toBe(false)
  })

  it('the hash binding still refuses changed content when enforced', async () => {
    withEnv(LOGIC_APP)
    const t = await team()
    withEnv({ RESPONSE_LOGICAPP_ORG_ID: t.orgId })
    const p = await approvedBy(t)
    await getDb().update(responseProposals).set({ payload: { action: 'unisolate' } }).where(eq(responseProposals.id, p.id))
    await expectRefusedUnclaimed(t, p.id, /no longer matches/)
  })

  it('start-up warns in production for each switch, and never by default', () => {
    const prod = { NODE_ENV: 'production', APP_URL: 'https://cw.example', DATABASE_URL: 'postgres://u:p@db/cw?sslmode=verify-full', BETTER_AUTH_SECRET: 'x'.repeat(32), APP_ENCRYPTION_KEY: 'a'.repeat(64) }
    expect(startupWarnings(parseEnv(prod))).toEqual([])
    const both = parseEnv({ ...prod, RESPONSE_ALLOW_SELF_APPROVAL: 'true', APPROVAL_BINDING: 'legacy' })
    expect(startupWarnings(both)).toEqual([expect.stringMatching(/^RESPONSE_ALLOW_SELF_APPROVAL=true/), expect.stringMatching(/^APPROVAL_BINDING=legacy/)])
    // Settings shows the same words in any environment.
    expect(approvalSafetyWarnings(parseEnv({ RESPONSE_ALLOW_SELF_APPROVAL: 'true' }))).toHaveLength(1)
    expect(startupWarnings(parseEnv({ RESPONSE_ALLOW_SELF_APPROVAL: 'true' }))).toEqual([])
  })
})
