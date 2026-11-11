import { afterEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '../src/server/db/client'
import { auditEvents, huntSchedules, orgNotificationChannels, orgResponseConnectors, responseProposals } from '../src/server/db/schema'
import { resetEnvForTests } from '../src/server/env'
import { upsertConnector, TokenBroker, setTokenBroker, type Sts } from '../src/server/hunting/broker'
import {
  allowedResponseSecretRefPrefix,
  ResponseNotConfiguredError,
  ResponseTokenBroker,
  resolveResponseSecret,
  setResponseTokenBroker,
  upsertResponseConnector,
} from '../src/server/response/connector'
import { assertAllowedResponseRequest, BlockedResponseRequestError } from '../src/server/response/executors'
import { createProposal, decideProposal, dryRunProposal, executeProposal, expireProposals, findRollback, getProposal, listEvents, proposeRollback } from '../src/server/response/proposals'
import { addChannel, assertWebhookUrl, buildPayload, plain, deleteChannel, listChannels, notify, setNotifyFetch, testChannel, WebhookUrlError } from '../src/server/notify/notify'
import { runMatcher } from '../src/server/ti/matcher'
import { addWatch } from '../src/server/ti/watchlists'
import { approveAndRunKql, createHunt, getHunt, proposeKql, setHuntStatus } from '../src/server/hunting/hunts'
import { createSchedule, disableSchedule, reapproveSchedule, runDueSchedules } from '../src/server/hunting/schedules'
import { huntReportMarkdown, REPORT_MAX_CHARS } from '../src/server/hunting/report'
import { LlmAgentRuntime, delegateParallelInput } from '../src/server/agents/runtime'
import { mockEnv, startMockModel } from './mock-model'
import { AGENT_TOOLS, EXECUTION_TOOL_NAMES } from '../src/server/agents/tools'
import { makeUser, member, team } from './helpers'

const TENANT = '0f0e0d0c-0b0a-0908-0706-050403020100'
const CLIENT = '01020304-0506-0708-090a-0b0c0d0e0f10'
const RESP_CLIENT = '11121314-1516-1718-191a-1b1c1d1e1f20'
const SUB = 'd0cfe6b2-9ac0-4464-9919-dccaee2e48c0'
const PLAYBOOK = `/subscriptions/${SUB}/resourceGroups/soc-rg/providers/Microsoft.Logic/workflows/contain-user`
const M1 = 'a'.repeat(40)
const M2 = 'b'.repeat(40)
const M3 = 'c'.repeat(40)

function withEnv(vars: Record<string, string>) {
  Object.assign(process.env, vars)
  resetEnvForTests()
}
const LIVE = { RESPONSE_DRY_RUN: 'false', RESPONSE_EXECUTOR_GRAPH: 'on', RESPONSE_EXECUTOR_SENTINEL: 'on' }
afterEach(() => {
  for (const k of ['RESPONSE_DRY_RUN', 'RESPONSE_EXECUTOR_GRAPH', 'RESPONSE_EXECUTOR_SENTINEL', 'RESPONSE_MAX_LIVE_TARGETS', 'NOTIFICATIONS_ENABLED', 'SCHEDULED_HUNTS_ENABLED']) delete process.env[k]
  resetEnvForTests()
  setNotifyFetch((...a) => fetch(...a))
  vi.restoreAllMocks()
})

function fakeSts(prefix: string) {
  return { clientCredentials: vi.fn(async (i: { clientId: string; scope: string }) => ({ accessToken: `${prefix}:${i.clientId}:${i.scope}`, expiresAt: Date.now() + 3600_000 })) } satisfies Sts
}

async function liveTeam() {
  const t = await team()
  await upsertConnector(t.orgId, { tenantId: TENANT, clientId: CLIENT, clientSecret: 'hunting-secret-xyz', sentinelSubscriptionId: SUB, sentinelResourceGroup: 'soc-rg', sentinelWorkspaceName: 'soc-ws' })
  await upsertResponseConnector(t.orgId, t.owner, { tenantId: TENANT, clientId: RESP_CLIENT, clientSecret: 'response-secret-xyz', playbookAllowlist: [PLAYBOOK] })
  const sts = fakeSts('resp')
  setResponseTokenBroker(new ResponseTokenBroker(sts))
  return { ...t, sts }
}

const isolate = (devices: string[]) => ({
  title: 'Isolate beaconing hosts',
  actionType: 'graph_containment' as const,
  targets: { devices },
  blastRadius: { summary: 'Hosts lose network access except to Defender until released.' },
  payload: { action: 'isolate' },
})

async function approved(t: Awaited<ReturnType<typeof liveTeam>>, input: Parameters<typeof createProposal>[2]) {
  const p = await createProposal(t.orgId, { type: 'user', userId: t.analyst }, input)
  await decideProposal(t.orgId, { userId: t.approver, role: 'approver' }, p.id, 'approve')
  return p
}

// ---------------------------------------------------------------------------------------------
describe('response connector (#88)', () => {
  it('response tokens come only from the response connector; hunting never mints them', async () => {
    const t = await liveTeam()
    const huntSts = fakeSts('hunt')
    const hunting = new TokenBroker(huntSts)
    expect(await hunting.acquire({ orgId: t.orgId, scope: 's' })).toBe(`hunt:${CLIENT}:s`)
    const resp = new ResponseTokenBroker(t.sts)
    expect(await resp.acquire({ orgId: t.orgId, scope: 's' })).toBe(`resp:${RESP_CLIENT}:s`)

    // An org with only a hunting connector has no response credential at all.
    const only = await team()
    await upsertConnector(only.orgId, { tenantId: TENANT, clientId: CLIENT, clientSecret: 'hunting-only' })
    await expect(new ResponseTokenBroker(fakeSts('x')).acquire({ orgId: only.orgId, scope: 's' })).rejects.toBeInstanceOf(ResponseNotConfiguredError)
  })

  it('stores the secret encrypted, refuses foreign secret refs and non-Logic App playbooks, keeps the secret on allowlist edits', async () => {
    const t = await team()
    await upsertResponseConnector(t.orgId, t.owner, { tenantId: TENANT, clientId: RESP_CLIENT, clientSecret: 'resp-secret-123' })
    const [row] = await getDb().select().from(orgResponseConnectors).where(eq(orgResponseConnectors.orgId, t.orgId))
    expect(row!.clientSecretEnc).not.toContain('resp-secret-123')
    await upsertResponseConnector(t.orgId, t.owner, { tenantId: TENANT, clientId: RESP_CLIENT, playbookAllowlist: [PLAYBOOK] })
    const [after] = await getDb().select().from(orgResponseConnectors).where(eq(orgResponseConnectors.orgId, t.orgId))
    expect(resolveResponseSecret(after!)).toBe('resp-secret-123')
    expect(after!.playbookAllowlist).toEqual([PLAYBOOK])

    await expect(upsertResponseConnector(t.orgId, t.owner, { tenantId: TENANT, clientId: RESP_CLIENT, clientSecretRef: 'env:DATABASE_URL' })).rejects.toThrow(/must be env:/)
    await expect(upsertResponseConnector(t.orgId, t.owner, { tenantId: TENANT, clientId: RESP_CLIENT, clientSecretRef: 'env:CROSSWIRE_HUNT_X_SECRET' })).rejects.toThrow(/must be env:/)
    await expect(upsertResponseConnector(t.orgId, t.owner, { tenantId: TENANT, clientId: RESP_CLIENT, playbookAllowlist: ['https://evil.example/x'] })).rejects.toThrow(/Logic App resource id/)
    expect(allowedResponseSecretRefPrefix(t.orgId)).toMatch(/^CROSSWIRE_RESP_/)
  })
})

describe('live Microsoft executors (#89)', () => {
  it('response allowlist: only POST isolate/unisolate and runPlaybook', () => {
    expect(() => assertAllowedResponseRequest('POST', `https://api.security.microsoft.com/api/machines/${M1}/isolate`)).not.toThrow()
    const bad: Array<[string, string]> = [
      ['GET', `https://api.security.microsoft.com/api/machines/${M1}/isolate`],
      ['POST', `https://api.security.microsoft.com/api/machines/${M1}/offboard`],
      ['POST', 'https://api.security.microsoft.com/api/machines/not-a-machine/isolate'],
      ['POST', `http://api.security.microsoft.com/api/machines/${M1}/isolate`],
      ['POST', 'https://graph.microsoft.com/v1.0/users/x/revokeSignInSessions'],
      ['POST', 'https://management.azure.com/subscriptions/x/resourceGroups/y/providers/Microsoft.Logic/workflows/z/run'],
    ]
    for (const [m, u] of bad) expect(() => assertAllowedResponseRequest(m, u), `${m} ${u}`).toThrow(BlockedResponseRequestError)
  })

  it('dry run plans the exact Defender calls and makes no request', async () => {
    withEnv(LIVE)
    const t = await liveTeam()
    const spy = vi.spyOn(globalThis, 'fetch')
    const p = await createProposal(t.orgId, { type: 'user', userId: t.analyst }, isolate([M1, M2]))
    const d = await dryRunProposal(t.orgId, { userId: t.approver, role: 'approver' }, p.id)
    expect(d.status).toBe('planned')
    expect(d.calls.map((c) => c.url)).toEqual([`https://api.security.microsoft.com/api/machines/${M1}/isolate`, `https://api.security.microsoft.com/api/machines/${M2}/isolate`])
    expect(d.calls[0]!.body).toMatchObject({ IsolationType: 'Selective' })
    expect(spy).not.toHaveBeenCalled()
    expect(t.sts.clientCredentials).not.toHaveBeenCalled()
  })

  it('isolates each device with a response-connector token; records partial failures per device', async () => {
    withEnv(LIVE)
    const t = await liveTeam()
    const p = await approved(t, isolate([M1, M2]))
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer resp:${RESP_CLIENT}:https://api.securitycenter.microsoft.com/.default`)
      expect(init.redirect).toBe('error')
      return url.includes(M2) ? Response.json({ error: { code: 'Forbidden' } }, { status: 403 }) : Response.json({ id: 'action-1', status: 'Pending' }, { status: 201 })
    })
    const out = await executeProposal(t.orgId, { userId: t.approver, role: 'approver' }, p.id, fetchImpl as unknown as typeof fetch)
    expect(out.status).toBe('partial')
    expect(out.results!.map((r) => [r.target!.id, r.ok])).toEqual([
      [M1, true],
      [M2, false],
    ])
    expect((await getProposal(t.orgId, p.id))!.status).toBe('failed')
    const ev = (await listEvents(t.orgId, p.id)).at(-1)!
    expect(ev.event).toBe('execute_failed')
    expect(JSON.stringify(ev.data)).not.toContain('resp:')
  })

  it('runs an allowlisted Sentinel playbook per incident; refuses non-allowlisted playbooks before any token', async () => {
    withEnv(LIVE)
    const t = await liveTeam()
    const ok = await approved(t, {
      title: 'Run contain-user on incident',
      actionType: 'sentinel_playbook',
      targets: { incidents: ['inc-1'] },
      blastRadius: { summary: 'Disables the signed-in user on incident inc-1 via playbook.' },
      payload: { playbookResourceId: PLAYBOOK.toUpperCase() },
    })
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe(`https://management.azure.com/subscriptions/${SUB}/resourceGroups/soc-rg/providers/Microsoft.OperationalInsights/workspaces/soc-ws/providers/Microsoft.SecurityInsights/incidents/inc-1/runPlaybook?api-version=2025-09-01`)
      expect(JSON.parse(String(init.body))).toEqual({ logicAppsResourceId: PLAYBOOK.toUpperCase(), tenantId: TENANT })
      return new Response(null, { status: 204 })
    })
    expect((await executeProposal(t.orgId, { userId: t.approver, role: 'approver' }, ok.id, fetchImpl as unknown as typeof fetch)).status).toBe('succeeded')

    t.sts.clientCredentials.mockClear()
    const evil = await approved(t, {
      title: 'Run unknown playbook',
      actionType: 'sentinel_playbook',
      targets: { incidents: ['inc-2'] },
      blastRadius: { summary: 'Agent-chosen playbook that nobody allowlisted.' },
      payload: { playbookResourceId: `/subscriptions/${SUB}/resourceGroups/soc-rg/providers/Microsoft.Logic/workflows/wipe-everything` },
    })
    const f2 = vi.fn()
    await expect(executeProposal(t.orgId, { userId: t.approver, role: 'approver' }, evil.id, f2 as unknown as typeof fetch)).rejects.toThrow(/allowlist/)
    expect(f2).not.toHaveBeenCalled()
    expect(t.sts.clientCredentials).not.toHaveBeenCalled()
    expect((await getProposal(t.orgId, evil.id))!.execution).toBeNull()
  })

  it('caps live targets and rejects non-machine ids', async () => {
    withEnv({ ...LIVE, RESPONSE_MAX_LIVE_TARGETS: '2' })
    const t = await liveTeam()
    const many = await approved(t, isolate([M1, M2, M3]))
    await expect(executeProposal(t.orgId, { userId: t.approver, role: 'approver' }, many.id, vi.fn() as unknown as typeof fetch)).rejects.toThrow(/RESPONSE_MAX_LIVE_TARGETS=2/)
    const named = await approved(t, isolate(['demo-wks-001']))
    await expect(executeProposal(t.orgId, { userId: t.approver, role: 'approver' }, named.id, vi.fn() as unknown as typeof fetch)).rejects.toThrow(/machine ids/)
  })

  it('dry-run default still holds: on is downgraded unless RESPONSE_DRY_RUN=false', async () => {
    withEnv({ RESPONSE_EXECUTOR_GRAPH: 'on' })
    const t = await liveTeam()
    const p = await approved(t, isolate([M1]))
    const f = vi.fn()
    const out = await executeProposal(t.orgId, { userId: t.approver, role: 'approver' }, p.id, f as unknown as typeof fetch)
    expect(out.mode).toBe('dry-run')
    expect(f).not.toHaveBeenCalled()
  })
})

describe('rollback as a gated proposal (#90)', () => {
  it('proposes unisolate for exactly the devices that were isolated; same approval rules; once only', async () => {
    withEnv(LIVE)
    const t = await liveTeam()
    const p = await approved(t, isolate([M1, M2]))
    await executeProposal(t.orgId, { userId: t.approver, role: 'approver' }, p.id, vi.fn(async (url: string) =>
      url.includes(M2) ? new Response('nope', { status: 500 }) : Response.json({}, { status: 201 }),
    ) as unknown as typeof fetch)

    const rb = await proposeRollback(t.orgId, { userId: t.approver }, p.id)
    expect(rb.status).toBe('pending')
    expect(rb.rollbackOfId).toBe(p.id)
    expect(rb.targets.devices).toEqual([M1])
    expect(rb.payload).toMatchObject({ action: 'unisolate' })
    expect((await findRollback(t.orgId, p.id))!.id).toBe(rb.id)
    await expect(proposeRollback(t.orgId, { userId: t.approver }, p.id)).rejects.toThrow(/already exists/)
    // The approver who proposed the rollback cannot approve it.
    await expect(decideProposal(t.orgId, { userId: t.approver, role: 'approver' }, rb.id, 'approve')).rejects.toThrow(/self-approval/)
    await decideProposal(t.orgId, { userId: t.owner, role: 'owner' }, rb.id, 'approve')
    const urls: string[] = []
    const out = await executeProposal(t.orgId, { userId: t.owner, role: 'owner' }, rb.id, vi.fn(async (u: string) => (urls.push(u), Response.json({}, { status: 201 }))) as unknown as typeof fetch)
    expect(out.status).toBe('succeeded')
    expect(urls).toEqual([`https://api.security.microsoft.com/api/machines/${M1}/unisolate`])
    expect((await listEvents(t.orgId, p.id)).map((e) => e.event)).toContain('rollback_proposed')
  })

  it('refuses rollback for pending/rejected/dry-run-only proposals and rollbacks of rollbacks; playbooks become manual', async () => {
    withEnv(LIVE)
    const t = await liveTeam()
    const pending = await createProposal(t.orgId, { type: 'user', userId: t.analyst }, isolate([M1]))
    await expect(proposeRollback(t.orgId, { userId: t.approver }, pending.id)).rejects.toThrow(/Only executed/)

    const pb = await approved(t, {
      title: 'Run contain-user',
      actionType: 'sentinel_playbook',
      targets: { incidents: ['inc-9'] },
      blastRadius: { summary: 'Playbook disables the user on incident inc-9.' },
      payload: { playbookResourceId: PLAYBOOK },
    })
    await executeProposal(t.orgId, { userId: t.approver, role: 'approver' }, pb.id, vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch)
    const manual = await proposeRollback(t.orgId, { userId: t.approver }, pb.id)
    expect(manual.actionType).toBe('other')
    expect(manual.targets.incidents).toEqual(['inc-9'])
    expect(String(manual.payload.rollbackNotes)).toMatch(/Sentinel/)
    await expect(proposeRollback(t.orgId, { userId: t.approver }, manual.id)).rejects.toThrow()
  })

  it('a rejected rollback can be proposed again (partial unique index)', async () => {
    withEnv(LIVE)
    const t = await liveTeam()
    const p = await approved(t, isolate([M1]))
    await executeProposal(t.orgId, { userId: t.approver, role: 'approver' }, p.id, vi.fn(async () => Response.json({}, { status: 201 })) as unknown as typeof fetch)
    const rb = await proposeRollback(t.orgId, { userId: t.approver }, p.id)
    await decideProposal(t.orgId, { userId: t.owner, role: 'owner' }, rb.id, 'reject')
    const again = await proposeRollback(t.orgId, { userId: t.approver }, p.id)
    expect(again.id).not.toBe(rb.id)
  })
})

describe('Teams and Slack notifications (#91)', () => {
  const SLACK = 'https://hooks.slack.com/services/T000/B000/abcdefSECRETtoken'
  const TEAMS = 'https://prod-11.australiaeast.logic.azure.com:443/workflows/abc/triggers/manual/paths/invoke?api-version=2016-06-01&sig=TEAMSSECRET'

  it('allowlists hosts per kind, https only, no credentials or odd ports', () => {
    expect(() => assertWebhookUrl('slack', SLACK)).not.toThrow()
    expect(() => assertWebhookUrl('teams', TEAMS)).not.toThrow()
    expect(() => assertWebhookUrl('teams', 'https://contoso.webhook.office.com/webhookb2/x')).not.toThrow()
    for (const [k, u] of [
      ['slack', 'http://hooks.slack.com/services/x'],
      ['slack', 'https://hooks.slack.com.evil.example/x'],
      ['slack', 'https://user:pw@hooks.slack.com/x'],
      ['slack', 'https://hooks.slack.com:8443/x'],
      ['teams', SLACK],
      ['teams', 'https://logic.azure.com.evil.example/x'],
      ['teams', 'https://169.254.169.254/latest'],
    ] as const) {
      expect(() => assertWebhookUrl(k, u), u).toThrow(WebhookUrlError)
    }
  })

  it('stores URLs encrypted, never returns or logs them, and payloads are redacted deep links', async () => {
    const t = await team()
    const id = await addChannel(t.orgId, t.owner, { kind: 'slack', name: 'SOC', url: SLACK, events: ['approval_pending'] })
    const [row] = await getDb().select().from(orgNotificationChannels).where(eq(orgNotificationChannels.id, id))
    expect(row!.urlEnc).not.toContain('SECRET')
    const views = await listChannels(t.orgId)
    expect(JSON.stringify(views)).not.toContain('SECRET')
    expect(views[0]!.urlHost).toBe('hooks.slack.com')

    const bodies: string[] = []
    setNotifyFetch(vi.fn(async (_u: string | URL | Request, init?: RequestInit) => (bodies.push(String(init!.body)), new Response('ok'))) as unknown as typeof fetch)
    await createProposal(t.orgId, { type: 'user', userId: t.analyst }, { ...isolate([M1]), blastRadius: { summary: 'token=abcdef123456 should be redacted from the summary' } })
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toMatch(/\/app\/approvals\//)
    expect(bodies[0]).not.toContain('abcdef123456')
    const audit = await getDb().select().from(auditEvents).where(eq(auditEvents.orgId, t.orgId))
    expect(JSON.stringify(audit)).not.toContain('SECRET')

    const teams = buildPayload('teams', { title: 'x', lines: ['y'], link: '/app' }) as { attachments: Array<{ contentType: string }> }
    expect(teams.attachments[0]!.contentType).toBe('application/vnd.microsoft.card.adaptive')
    await deleteChannel(t.orgId, t.owner, id)
    expect(await listChannels(t.orgId)).toHaveLength(0)
  })

  it('a failing webhook never breaks the triggering action; only subscribed events are sent', async () => {
    const t = await team()
    await addChannel(t.orgId, t.owner, { kind: 'teams', name: 'Teams', url: TEAMS, events: ['watch_hit'] })
    const f = vi.fn(async () => {
      throw new Error(`connect ECONNREFUSED ${TEAMS}`)
    })
    setNotifyFetch(f as unknown as typeof fetch)
    // approval_pending is not subscribed: nothing sent, proposal still created.
    await createProposal(t.orgId, { type: 'user', userId: t.analyst }, isolate([M1]))
    expect(f).not.toHaveBeenCalled()

    await addWatch(t.orgId, t.owner, { type: 'keyword', value: 'fortinet' })
    const stats = await runMatcher({ orgId: t.orgId, records: [{ source: 'test', sourceId: '1', title: 'Fortinet bug', text: 'fortinet', url: null, cveIds: [], tags: [], vendors: [] }] })
    expect(stats.inserted).toBe(1)
    expect(f).toHaveBeenCalledTimes(1)
    const [c] = await getDb().select().from(orgNotificationChannels).where(eq(orgNotificationChannels.orgId, t.orgId))
    expect(c!.lastStatus).toBe('Error')
    const audit = await getDb().select().from(auditEvents).where(eq(auditEvents.orgId, t.orgId))
    expect(audit.some((a) => a.action === 'notification_failed')).toBe(true)
    expect(JSON.stringify(audit)).not.toContain('TEAMSSECRET')
    // Re-running finds nothing new, so nothing is sent again.
    await runMatcher({ orgId: t.orgId, records: [{ source: 'test', sourceId: '1', title: 'Fortinet bug', text: 'fortinet', url: null, cveIds: [], tags: [], vendors: [] }] })
    expect(f).toHaveBeenCalledTimes(1)
    expect((await testChannel(t.orgId, c!.id)).ok).toBe(false)
  })

  it('NOTIFICATIONS_ENABLED=false sends nothing', async () => {
    withEnv({ NOTIFICATIONS_ENABLED: 'false' })
    const t = await team()
    await addChannel(t.orgId, t.owner, { kind: 'slack', name: 's', url: SLACK, events: ['execution'] })
    const f = vi.fn()
    setNotifyFetch(f as unknown as typeof fetch)
    expect(await notify(t.orgId, 'execution', { title: 'x' })).toEqual({ sent: 0, failed: 0 })
    expect(f).not.toHaveBeenCalled()
  })
})

describe('scheduled hunts (#92)', () => {
  async function ranProposal() {
    // Tests in this file share one database: park schedules left by earlier tests so counts are exact.
    await getDb().update(huntSchedules).set({ enabled: false })
    const t = await team()
    const hunt = await createHunt(t.orgId, t.analyst, { title: 'Encoded PowerShell' })
    const p = await proposeKql(t.orgId, { type: 'agent', id: 'hunter' }, { huntId: hunt.id, target: 'defender', kql: 'DeviceProcessEvents | where ProcessCommandLine has "-enc" | take 10' })
    return { t, hunt, p }
  }

  it('only approvers can schedule, and only a query that ran', async () => {
    const { t, p } = await ranProposal()
    await expect(createSchedule(t.orgId, { userId: t.approver, role: 'approver' }, { proposalId: p.id, intervalMinutes: 60 })).rejects.toThrow(/ran successfully/)
    await approveAndRunKql(t.orgId, t.analyst, p.id)
    await expect(createSchedule(t.orgId, { userId: t.analyst, role: 'analyst' }, { proposalId: p.id, intervalMinutes: 60 })).rejects.toThrow(/owners and approvers/)
    await expect(createSchedule(t.orgId, { userId: t.approver, role: 'approver' }, { proposalId: p.id, intervalMinutes: 5 })).rejects.toThrow(/between 60/)
    const s = await createSchedule(t.orgId, { userId: t.approver, role: 'approver' }, { proposalId: p.id, intervalMinutes: 60, approvalDays: 365 })
    expect(s.kql).toBe(p.kql)
    expect(s.approvalExpiresAt.getTime() - s.approvedAt.getTime()).toBeLessThanOrEqual(30 * 86_400_000)
  })

  it('runs due schedules once across concurrent workers and records evidence + notifies on change', async () => {
    const { t, hunt, p } = await ranProposal()
    await approveAndRunKql(t.orgId, t.analyst, p.id)
    const s = await createSchedule(t.orgId, { userId: t.approver, role: 'approver' }, { proposalId: p.id, intervalMinutes: 60 })
    await getDb().update(huntSchedules).set({ lastRowCount: 0 }).where(eq(huntSchedules.id, s.id))
    const future = new Date(Date.now() + 61 * 60_000)
    const sent = vi.fn(async () => new Response('ok'))
    setNotifyFetch(sent as unknown as typeof fetch)
    await addChannel(t.orgId, t.owner, { kind: 'slack', name: 's', url: 'https://hooks.slack.com/services/a/b/c', events: ['scheduled_hunt'] })

    const [a, b] = await Promise.all([runDueSchedules(() => future), runDueSchedules(() => future)])
    expect(a.ran + b.ran).toBe(1)
    const h = await getHunt(t.orgId, hunt.id)
    expect(h!.evidence.filter((e) => e.type === 'scheduled_result')).toHaveLength(1)
    const [after] = await getDb().select().from(huntSchedules).where(eq(huntSchedules.id, s.id))
    expect(after!.lastStatus).toBe('run')
    expect(after!.nextRunAt.getTime()).toBeGreaterThan(future.getTime())
    expect(sent).toHaveBeenCalledTimes(1)
    // Not due again until the next interval.
    expect((await runDueSchedules(() => future)).ran).toBe(0)
  })

  it('lapsed approval disables the schedule; it never runs again until re-approved', async () => {
    const { t, hunt, p } = await ranProposal()
    await approveAndRunKql(t.orgId, t.analyst, p.id)
    const s = await createSchedule(t.orgId, { userId: t.approver, role: 'approver' }, { proposalId: p.id, intervalMinutes: 60, approvalDays: 1 })
    const later = new Date(Date.now() + 2 * 86_400_000)
    const r = await runDueSchedules(() => later)
    expect(r).toEqual({ ran: 0, expired: 1 })
    const [row] = await getDb().select().from(huntSchedules).where(eq(huntSchedules.id, s.id))
    expect(row!.enabled).toBe(false)
    expect(row!.disabledReason).toMatch(/approval expired/)
    expect((await getHunt(t.orgId, hunt.id))!.evidence.some((e) => e.type === 'schedule_disabled')).toBe(true)
    await expect(reapproveSchedule(t.orgId, { userId: t.analyst, role: 'analyst' }, s.id)).rejects.toThrow()
    await reapproveSchedule(t.orgId, { userId: t.owner, role: 'owner' }, s.id)
    const [re] = await getDb().select().from(huntSchedules).where(eq(huntSchedules.id, s.id))
    expect(re!.enabled).toBe(true)
    expect(re!.approvedBy).toBe(t.owner)
    await disableSchedule(t.orgId, { userId: t.owner, role: 'owner' }, s.id)
    expect((await runDueSchedules(() => new Date(Date.now() + 2 * 3600_000))).ran).toBe(0)
  })

  it('SCHEDULED_HUNTS_ENABLED=false stops the worker loop', async () => {
    withEnv({ SCHEDULED_HUNTS_ENABLED: 'false' })
    expect(await runDueSchedules(() => new Date(Date.now() + 86_400_000))).toEqual({ ran: 0, expired: 0 })
  })

  it('agents have no schedule tool and no execute tools', () => {
    expect(EXECUTION_TOOL_NAMES).toHaveLength(0)
    for (const tools of Object.values(AGENT_TOOLS)) for (const name of tools) expect(name).not.toMatch(/schedule|execute|approve|rollback/)
  })
})

describe('parallel Lead fan-out (#93)', () => {
  it('runs distinct specialists concurrently; one failure does not drop the others', async () => {
    const t = await team()
    let inFlight = 0
    let maxInFlight = 0
    // Real model calls against a local mock endpoint. Scribe's model call fails.
    const mock = await startMockModel(async (req) => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((r) => setTimeout(r, 150))
      inFlight--
      const who = /^# (\w+)/m.exec(req.system)?.[1]?.toLowerCase() ?? 'unknown'
      if (who === 'scribe') return { status: 500, body: JSON.stringify({ error: { message: 'scribe exploded' } }) }
      return { text: `${who} answer` }
    })
    const saved = { ...process.env }
    Object.assign(process.env, mockEnv(mock.baseUrl))
    resetEnvForTests()
    try {
      const rt = new LlmAgentRuntime()
      const tool = (rt as unknown as { delegateParallelTool: (i: unknown, tr: unknown[]) => { execute: (a: unknown) => Promise<{ results: Array<{ agent: string; answer?: string; error?: string }> }> } }).delegateParallelTool(
        { orgId: t.orgId, userId: t.analyst, selection: 'lead-orchestrate', threadId: null, messages: [], abortController: new AbortController() },
        [],
      )
      const out = await tool.execute({ tasks: [{ agent: 'intel', task: 'what is CVE-1' }, { agent: 'hunter', task: 'hunt for it' }, { agent: 'scribe', task: 'remember it' }] })
      expect(maxInFlight).toBeGreaterThan(1)
      expect(out.results.find((r) => r.agent === 'Intel')!.answer).toMatch(/intel answer/)
      expect(out.results.find((r) => r.agent === 'Hunter')!.answer).toMatch(/hunter answer/)
      expect(out.results.find((r) => r.agent === 'Scribe')!.error).toBeTruthy()
      expect(out.results).toHaveLength(3)
    } finally {
          await mock.close()
      process.env = saved
      resetEnvForTests()
    }
  }, 120_000)

  it('refuses duplicate specialists, more than 4 tasks, and lead itself', () => {
    expect(delegateParallelInput.safeParse({ tasks: [{ agent: 'intel', task: 'aaaaa' }, { agent: 'intel', task: 'bbbbb' }] }).success).toBe(false)
    expect(delegateParallelInput.safeParse({ tasks: Array.from({ length: 5 }, (_, i) => ({ agent: ['intel', 'hunter', 'responder', 'scribe', 'intel'][i], task: 'aaaaa' })) }).success).toBe(false)
    expect(delegateParallelInput.safeParse({ tasks: [{ agent: 'lead', task: 'aaaaa' }] }).success).toBe(false)
    expect(delegateParallelInput.safeParse({ tasks: [{ agent: 'intel', task: 'aaaaa' }, { agent: 'hunter', task: 'bbbbb' }] }).success).toBe(true)
  })
})

describe('hunt report export (#94)', () => {
  it('includes each query that ran with its approver, is org-scoped, redacted and audited', async () => {
    const t = await team()
    const approverName = await makeUser('approver.person@example.test')
    await member(t.orgId, approverName, 'approver')
    const hunt = await createHunt(t.orgId, t.analyst, { title: 'Beacon | hunt', hypothesis: 'C2 over HTTPS. password=hunter2hunter2' })
    const p = await proposeKql(t.orgId, { type: 'user', id: t.analyst }, { huntId: hunt.id, target: 'defender', kql: 'DeviceNetworkEvents | take 5' })
    await approveAndRunKql(t.orgId, approverName, p.id)

    const r = await huntReportMarkdown(t.orgId, hunt.id, t.analyst)
    expect(r!.filename).toMatch(/^crosswire-hunt-beacon-hunt-/)
    expect(r!.markdown).toContain('DeviceNetworkEvents | take 5')
    expect(r!.markdown).toContain('approver.person@example.test')
    expect(r!.markdown).not.toContain('hunter2hunter2')
    expect(r!.markdown).toContain('Beacon \\| hunt')
    expect(r!.markdown.length).toBeLessThanOrEqual(REPORT_MAX_CHARS + 100)

    const other = await team()
    expect(await huntReportMarkdown(other.orgId, hunt.id, other.analyst)).toBeNull()
    const audit = await getDb().select().from(auditEvents).where(eq(auditEvents.orgId, t.orgId))
    expect(audit.some((a) => a.action === 'hunt_report_exported')).toBe(true)
  })
})

describe('council review fixes (v2)', () => {
  it('an approved rollback that lapses expires, so a new rollback can be proposed', async () => {
    withEnv(LIVE)
    const t = await liveTeam()
    const p = await approved(t, isolate([M1]))
    await executeProposal(t.orgId, { userId: t.approver, role: 'approver' }, p.id, vi.fn(async () => Response.json({}, { status: 201 })) as unknown as typeof fetch)
    const rb = await proposeRollback(t.orgId, { userId: t.approver }, p.id)
    await decideProposal(t.orgId, { userId: t.owner, role: 'owner' }, rb.id, 'approve')
    expect(await expireProposals(new Date(Date.now() + 48 * 3600_000))).toBeGreaterThanOrEqual(1)
    expect((await getProposal(t.orgId, rb.id))!.status).toBe('expired')
    const again = await proposeRollback(t.orgId, { userId: t.approver }, p.id)
    expect(again.targets.devices).toEqual([M1])
  })

  it('execute on an expired approval marks it expired', async () => {
    withEnv(LIVE)
    const t = await liveTeam()
    const p = await approved(t, isolate([M1]))
    await getDb().update(responseProposals).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(responseProposals.id, p.id))
    await expect(executeProposal(t.orgId, { userId: t.approver, role: 'approver' }, p.id, vi.fn() as unknown as typeof fetch)).rejects.toThrow(/expired/)
    expect((await getProposal(t.orgId, p.id))!.status).toBe('expired')
  })

  it('Logic App rollback keeps the original device and incident targets', async () => {
    withEnv({ ...LIVE, RESPONSE_EXECUTOR_LOGICAPP: 'on', RESPONSE_LOGICAPP_URL: 'https://mock.logic.example/invoke?sig=s3cret' })
    const t = await liveTeam()
    const p = await approved(t, { ...isolate(['host-1']), actionType: 'logic_app' })
    await executeProposal(t.orgId, { userId: t.approver, role: 'approver' }, p.id, vi.fn(async () => Response.json({}, { status: 202 })) as unknown as typeof fetch)
    const rb = await proposeRollback(t.orgId, { userId: t.approver }, p.id)
    expect(rb.actionType).toBe('other')
    expect(rb.targets.devices).toEqual(['host-1'])
    delete process.env.RESPONSE_EXECUTOR_LOGICAPP
    delete process.env.RESPONSE_LOGICAPP_URL
  })

  it('duplicate targets are collapsed, so nothing runs twice', async () => {
    withEnv(LIVE)
    const t = await liveTeam()
    const p = await approved(t, isolate([M1, M1]))
    expect(p.targets.devices).toEqual([M1])
    const f = vi.fn(async () => Response.json({}, { status: 201 }))
    await executeProposal(t.orgId, { userId: t.approver, role: 'approver' }, p.id, f as unknown as typeof fetch)
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('bad incident ids, unknown containment actions and secretless connectors are blocked before the claim', async () => {
    withEnv(LIVE)
    const t = await liveTeam()
    const inc = await approved(t, { title: 'Bad incident', actionType: 'sentinel_playbook', targets: { incidents: ['ok-1', '..'] }, blastRadius: { summary: 'Path trick in the incident id.' }, payload: { playbookResourceId: PLAYBOOK } })
    const f = vi.fn()
    await expect(executeProposal(t.orgId, { userId: t.approver, role: 'approver' }, inc.id, f as unknown as typeof fetch)).rejects.toThrow(/incident ids/)
    const rel = await approved(t, { ...isolate([M1]), payload: { action: 'release' } })
    await expect(executeProposal(t.orgId, { userId: t.approver, role: 'approver' }, rel.id, f as unknown as typeof fetch)).rejects.toThrow(/isolate" or "unisolate/)
    expect(f).not.toHaveBeenCalled()
    expect((await getProposal(t.orgId, inc.id))!.execution).toBeNull()

    const bare = await team()
    await expect(upsertResponseConnector(bare.orgId, bare.owner, { tenantId: TENANT, clientId: RESP_CLIENT })).rejects.toThrow(/required the first time/)
  })

  it('notification text cannot inject Slack links/mentions or Teams markdown links', () => {
    expect(plain('slack', '<!channel> <https://evil|Approve>')).not.toMatch(/<[!h]/)
    expect(plain('teams', '[Approve](https://evil)')).toBe('\\[Approve\\]\\(https://evil\\)')
    const body = JSON.stringify(buildPayload('slack', { title: '<https://evil|click>' }))
    expect(body).not.toContain('<https://evil')
  })

  it('closing a hunt disables its schedules; double scheduling the same query is refused', async () => {
    await getDb().update(huntSchedules).set({ enabled: false })
    const t = await team()
    const hunt = await createHunt(t.orgId, t.analyst, { title: 'Close me' })
    const p = await proposeKql(t.orgId, { type: 'user', id: t.analyst }, { huntId: hunt.id, target: 'defender', kql: 'DeviceInfo | take 1' })
    await approveAndRunKql(t.orgId, t.analyst, p.id)
    const s = await createSchedule(t.orgId, { userId: t.approver, role: 'approver' }, { proposalId: p.id, intervalMinutes: 60 })
    await expect(createSchedule(t.orgId, { userId: t.approver, role: 'approver' }, { proposalId: p.id, intervalMinutes: 60 })).rejects.toThrow(/already has an enabled schedule/)
    // An analyst cannot close it: that would stop a schedule an approver signed off on.
    await expect(setHuntStatus(t.orgId, { userId: t.analyst, role: 'analyst' }, hunt.id, 'closed')).rejects.toThrow(/Only owners and approvers/)
    const [still] = await getDb().select().from(huntSchedules).where(eq(huntSchedules.id, s.id))
    expect(still!.enabled).toBe(true)
    await setHuntStatus(t.orgId, { userId: t.approver, role: 'approver' }, hunt.id, 'closed')
    const [row] = await getDb().select().from(huntSchedules).where(eq(huntSchedules.id, s.id))
    expect(row!.enabled).toBe(false)
    expect(row!.disabledReason).toBe('hunt closed')
    expect((await runDueSchedules(() => new Date(Date.now() + 2 * 3600_000))).ran).toBe(0)
  })

  it('each claim uses a fresh clock, so a long loop never hands out an already-expired lease', async () => {
    await getDb().update(huntSchedules).set({ enabled: false })
    const t = await team()
    const hunt = await createHunt(t.orgId, t.analyst, { title: 'Two schedules' })
    const ids: string[] = []
    for (const kql of ['DeviceInfo | take 2', 'DeviceInfo | take 3']) {
      const p = await proposeKql(t.orgId, { type: 'user', id: t.analyst }, { huntId: hunt.id, target: 'defender', kql })
      await approveAndRunKql(t.orgId, t.analyst, p.id)
      ids.push((await createSchedule(t.orgId, { userId: t.approver, role: 'approver' }, { proposalId: p.id, intervalMinutes: 60 })).id)
    }
    let clock = Date.now() + 61 * 60_000
    // Every read of the clock moves it 20 minutes on, like a slow loop.
    const r = await runDueSchedules(() => new Date((clock += 20 * 60_000)))
    expect(r.ran).toBe(2)
    const rows = await getDb().select().from(huntSchedules).where(eq(huntSchedules.huntId, hunt.id))
    for (const row of rows) expect(row.lastRunAt!.getTime()).toBeGreaterThan(Date.now() + 61 * 60_000)
    const runs = rows.map((x) => x.lastRunAt!.getTime())
    expect(new Set(runs).size).toBe(2)
  })

  it('hunt report escapes markdown and keeps fences intact', async () => {
    const t = await team()
    const hunt = await createHunt(t.orgId, t.analyst, { title: '[click](https://evil) <img src=x>' , hypothesis: '<script>x</script> [a](b)' })
    const p = await proposeKql(t.orgId, { type: 'user', id: t.analyst }, { huntId: hunt.id, target: 'defender', kql: 'DeviceInfo | where x == "````" | take 1' })
    await approveAndRunKql(t.orgId, t.analyst, p.id)
    const r = (await huntReportMarkdown(t.orgId, hunt.id, t.analyst))!.markdown
    expect(r).not.toContain('[click](https://evil)')
    expect(r).not.toMatch(/<script>|<img/)
    expect(r).toContain('`````kql')
  })
})

// Keep the hunting broker default for other files.
setTokenBroker(new TokenBroker())
void responseProposals
