import { afterEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '../src/server/db/client'
import { responseProposals } from '../src/server/db/schema'
import { resetEnvForTests } from '../src/server/env'
import {
  auditBundle,
  createProposal,
  decideProposal,
  dryRunProposal,
  executeProposal,
  expireProposals,
  listEvents,
  listProposals,
  toView,
} from '../src/server/response/proposals'
import { buildTools } from '../src/server/agents/tools'
import { ForbiddenError } from '../src/server/response/rbac'
import { makeOrg, team } from './helpers'

const base = {
  title: 'Isolate demo-wks-001',
  actionType: 'logic_app' as const,
  targets: { devices: ['demo-wks-001'] },
  blastRadius: { summary: 'One workstation loses network access except to Defender.' },
  payload: { action: 'isolate' },
}

function withEnv(vars: Record<string, string>) {
  Object.assign(process.env, vars)
  resetEnvForTests()
}
afterEach(() => {
  for (const k of ['RESPONSE_EXECUTOR_LOGICAPP', 'RESPONSE_LOGICAPP_URL', 'RESPONSE_ALLOW_SELF_APPROVAL', 'RESPONSE_DRY_RUN']) delete process.env[k]
  resetEnvForTests()
})

describe('proposal model (#50)', () => {
  it('creates with action type, scope, blast radius counts and expiry; org-isolated', async () => {
    const t = await team()
    const p = await createProposal(t.orgId, { type: 'user', userId: t.analyst }, base)
    expect(p.status).toBe('pending')
    expect(p.blastRadius).toMatchObject({ devices: 1, users: 0, incidents: 0 })
    expect(p.expiresAt.getTime()).toBeGreaterThan(Date.now())
    expect(await listProposals(await makeOrg('Other'))).toHaveLength(0)
    expect(toView(p).actionType).toBe('logic_app')
  })

  it('rejects empty blast radius, missing targets and invalid types', async () => {
    const t = await team()
    await expect(createProposal(t.orgId, { type: 'user', userId: t.analyst }, { ...base, blastRadius: { summary: '' } })).rejects.toThrow(/Blast radius/)
    await expect(createProposal(t.orgId, { type: 'user', userId: t.analyst }, { ...base, targets: {} })).rejects.toThrow(/target/)
    await expect(createProposal(t.orgId, { type: 'user', userId: t.analyst }, { ...base, actionType: 'nuke' as never })).rejects.toThrow()
  })
})

describe('approval workflow + RBAC (#51, #55)', () => {
  it('analyst 403, approver 200; default members are not approvers', async () => {
    const t = await team()
    const p = await createProposal(t.orgId, { type: 'user', userId: t.owner }, base)
    await expect(decideProposal(t.orgId, { userId: t.analyst, role: 'analyst' }, p.id, 'approve')).rejects.toBeInstanceOf(ForbiddenError)
    const ok = await decideProposal(t.orgId, { userId: t.approver, role: 'approver' }, p.id, 'approve', 'looks scoped')
    expect(ok.status).toBe('approved')
    await expect(decideProposal(t.orgId, { userId: t.owner, role: 'owner' }, p.id, 'approve')).rejects.toThrow(/already approved/)
  })

  it('self-approval is denied by default and allowed only when configured', async () => {
    const t = await team()
    const p = await createProposal(t.orgId, { type: 'user', userId: t.approver }, base)
    await expect(decideProposal(t.orgId, { userId: t.approver, role: 'approver' }, p.id, 'approve')).rejects.toThrow(/self-approval is off/)
    withEnv({ RESPONSE_ALLOW_SELF_APPROVAL: 'true' })
    expect((await decideProposal(t.orgId, { userId: t.approver, role: 'approver' }, p.id, 'approve')).status).toBe('approved')
  })

  it('agent proposals count as requested by the user who chatted (no self-approval loophole)', async () => {
    const t = await team()
    const tools = buildTools({ orgId: t.orgId, userId: t.approver, agentKey: 'responder', threadId: null, traces: [] })
    const r = (await (tools.propose_response!.execute as (a: unknown) => Promise<{ proposalId: string; approvalInbox: string }>)(base))
    expect(r.approvalInbox).toMatch(/\/app\/approvals\//)
    await expect(decideProposal(t.orgId, { userId: t.approver, role: 'approver' }, r.proposalId, 'approve')).rejects.toThrow(/self-approval/)
  })

  it('expired proposals refuse approve and execute', async () => {
    const t = await team()
    const p = await createProposal(t.orgId, { type: 'user', userId: t.analyst }, base)
    await getDb().update(responseProposals).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(responseProposals.id, p.id))
    expect(await expireProposals()).toBeGreaterThanOrEqual(1)
    await expect(decideProposal(t.orgId, { userId: t.approver, role: 'approver' }, p.id, 'approve')).rejects.toThrow(/expired/)
    await expect(executeProposal(t.orgId, { userId: t.approver, role: 'approver' }, p.id)).rejects.toThrow(/Only approved/)
  })
})

describe('executors + dry run + audit (#52, #53, #54)', () => {
  it('flags default to off; unapproved proposals can never reach an executor', async () => {
    const t = await team()
    const p = await createProposal(t.orgId, { type: 'user', userId: t.analyst }, base)
    const fetchImpl = vi.fn()
    await expect(executeProposal(t.orgId, { userId: t.owner, role: 'owner' }, p.id, fetchImpl as unknown as typeof fetch)).rejects.toThrow(/Only approved/)
    await decideProposal(t.orgId, { userId: t.owner, role: 'owner' }, p.id, 'approve')
    await expect(executeProposal(t.orgId, { userId: t.owner, role: 'owner' }, p.id, fetchImpl as unknown as typeof fetch)).rejects.toThrow(/executor is off/)
    await expect(executeProposal(t.orgId, { userId: t.analyst, role: 'analyst' }, p.id, fetchImpl as unknown as typeof fetch)).rejects.toBeInstanceOf(ForbiddenError)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('dry run never calls mutating endpoints and is visible on the proposal', async () => {
    withEnv({ RESPONSE_EXECUTOR_LOGICAPP: 'on', RESPONSE_LOGICAPP_URL: 'https://prod-00.example.logic.azure.com/workflows/x/triggers/manual/paths/invoke?sig=SECRETSIG' })
    const globalFetch = vi.spyOn(globalThis, 'fetch')
    const t = await team()
    const p = await createProposal(t.orgId, { type: 'user', userId: t.analyst }, base)
    const out = await dryRunProposal(t.orgId, { userId: t.approver, role: 'approver' }, p.id)
    expect(out.mode).toBe('dry-run')
    expect(out.calls[0]!.method).toBe('POST')
    expect(out.calls[0]!.url).not.toContain('SECRETSIG')
    expect(globalFetch).not.toHaveBeenCalled()
    const [row] = await getDb().select().from(responseProposals).where(eq(responseProposals.id, p.id))
    expect(row!.lastDryRun).toBeTruthy()
    expect(row!.rollbackNotes).toMatch(/Logic App run/)
    globalFetch.mockRestore()

    for (const type of ['sentinel_playbook', 'graph_containment'] as const) {
      const s = await createProposal(t.orgId, { type: 'user', userId: t.analyst }, { ...base, actionType: type })
      const d = await dryRunProposal(t.orgId, { userId: t.approver, role: 'approver' }, s.id)
      expect(d.status).toBe('planned')
      expect(d.calls.length).toBeGreaterThan(0)
    }
  })

  it('live Logic App executor runs against a mock HTTP server only after approval; full lifecycle audited', async () => {
    withEnv({ RESPONSE_DRY_RUN: 'false', RESPONSE_EXECUTOR_LOGICAPP: 'on', RESPONSE_LOGICAPP_URL: 'https://mock.logic.example/invoke?sig=abc123secret' })
    const t = await team()
    const p = await createProposal(t.orgId, { type: 'agent', agentKey: 'responder', onBehalfOfUserId: t.analyst }, base)
    await dryRunProposal(t.orgId, { userId: t.approver, role: 'approver' }, p.id)
    await decideProposal(t.orgId, { userId: t.approver, role: 'approver' }, p.id, 'approve')
    const fetchImpl = vi.fn(async (_u: string, init: RequestInit) => {
      expect(JSON.parse(String(init.body)).targets.devices).toEqual(['demo-wks-001'])
      return Response.json({ runId: 'run-1', access_token: 'should-be-redacted-xyz' }, { status: 202 })
    })
    const out = await executeProposal(t.orgId, { userId: t.approver, role: 'approver' }, p.id, fetchImpl as unknown as typeof fetch)
    expect(out.status).toBe('succeeded')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    await expect(executeProposal(t.orgId, { userId: t.approver, role: 'approver' }, p.id, fetchImpl as unknown as typeof fetch)).rejects.toThrow(/Only approved/)
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    const events = (await listEvents(t.orgId, p.id)).map((e) => e.event)
    expect(events).toEqual(['created', 'dry_run', 'approved', 'execute_attempt', 'executed'])
    const bundle = JSON.stringify(await auditBundle(t.orgId, p.id))
    expect(bundle).not.toContain('should-be-redacted-xyz')
    expect(bundle).not.toContain('abc123secret')
    expect(bundle).toContain('rollback')
  })

  it('stub executors in on mode record a stub outcome without any network call', async () => {
    const t = await team()
    process.env.RESPONSE_EXECUTOR_GRAPH = 'on'
    process.env.RESPONSE_DRY_RUN = 'false'
    resetEnvForTests()
    const p = await createProposal(t.orgId, { type: 'user', userId: t.analyst }, { ...base, actionType: 'graph_containment' })
    await decideProposal(t.orgId, { userId: t.owner, role: 'owner' }, p.id, 'approve')
    const fetchImpl = vi.fn()
    const out = await executeProposal(t.orgId, { userId: t.owner, role: 'owner' }, p.id, fetchImpl as unknown as typeof fetch)
    expect(out.status).toBe('stub')
    expect(fetchImpl).not.toHaveBeenCalled()
    delete process.env.RESPONSE_EXECUTOR_GRAPH
    delete process.env.RESPONSE_DRY_RUN
  })
})
