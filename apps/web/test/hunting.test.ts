import { afterEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '../src/server/db/client'
import { kqlProposals, orgConnectors } from '../src/server/db/schema'
import { TokenBroker, HuntingNotConfiguredError, allowedSecretRefPrefix, getConnectorView, setTokenBroker, upsertConnector, type Sts } from '../src/server/hunting/broker'
import { HuntingClient, setHuntingClient } from '../src/server/hunting/client'
import { assertAllowedRequest, assertSafeKql, BlockedRequestError, clampRows, clampTimeout, HARD_ROW_CAP, UnsafeQueryError } from '../src/server/hunting/safety'
import { approveAndRunKql, createHunt, expireKqlProposals, getHunt, listHunts, proposeKql, rejectKql } from '../src/server/hunting/hunts'
import { buildTools } from '../src/server/agents/tools'
import { resetEnvForTests } from '../src/server/env'
import { canApproveEveryProposal } from '../src/shared/kql-approval'
import { approveAllPlan, editedBeforeApproval, intervalText, personName, proposerText, shownKql } from '../src/routes/-hunts/helpers'
import { makeOrg, makeUser, member } from './helpers'

const TENANT = '0f0e0d0c-0b0a-0908-0706-050403020100'
const CLIENT = '01020304-0506-0708-090a-0b0c0d0e0f10'

describe('token broker (#44)', () => {
  it('acquires via STS with the decrypted secret, caches until expiry, and never exposes secrets', async () => {
    const org = await makeOrg('Broker')
    await upsertConnector(org, { tenantId: TENANT, clientId: CLIENT, clientSecret: 'super-secret-value-123' })
    const [row] = await getDb().select().from(orgConnectors).where(eq(orgConnectors.orgId, org))
    expect(row!.clientSecretEnc).toBeTruthy()
    expect(row!.clientSecretEnc).not.toContain('super-secret-value-123')

    const sts: Sts = { clientCredentials: vi.fn(async (i) => ({ accessToken: `tok-for-${i.clientSecret.length}`, expiresAt: Date.now() + 3600_000 })) }
    const broker = new TokenBroker(sts)
    expect(await broker.acquire({ orgId: org, scope: 'https://graph.microsoft.com/.default' })).toBe('tok-for-22')
    await broker.acquire({ orgId: org, scope: 'https://graph.microsoft.com/.default' })
    expect(sts.clientCredentials).toHaveBeenCalledTimes(1)
    const view = await getConnectorView(org)
    expect(JSON.stringify(view)).not.toContain('super-secret')
    expect(view!.secretSource).toBe('encrypted')
  })

  it('fails clearly when hunting is not configured for the org', async () => {
    const org = await makeOrg('NoConn')
    await expect(new TokenBroker({ clientCredentials: vi.fn() }).acquire({ orgId: org, scope: 's' })).rejects.toBeInstanceOf(HuntingNotConfiguredError)
  })

  it('resolves env: secret references (Key Vault-backed container secrets)', async () => {
    const org = await makeOrg('EnvRef')
    const name = `${allowedSecretRefPrefix(org)}SECRET`
    process.env[name] = 'from-env'
    await upsertConnector(org, { tenantId: TENANT, clientId: CLIENT, clientSecretRef: `env:${name}` })
    const sts: Sts = { clientCredentials: vi.fn(async (i) => ({ accessToken: i.clientSecret, expiresAt: Date.now() + 3600_000 })) }
    expect(await new TokenBroker(sts).acquire({ orgId: org, scope: 's' })).toBe('from-env')
    delete process.env[name]
  })
})

describe('hunting safety (#49)', () => {
  it('blocks destructive or non-allowlisted Graph paths and methods', () => {
    expect(() => assertAllowedRequest('POST', 'https://graph.microsoft.com/v1.0/security/runHuntingQuery')).not.toThrow()
    const bad: Array<[string, string]> = [
      ['DELETE', 'https://graph.microsoft.com/v1.0/users/abc'],
      ['PATCH', 'https://graph.microsoft.com/v1.0/security/incidents/1'],
      ['POST', 'https://graph.microsoft.com/v1.0/users/abc/revokeSignInSessions'],
      ['POST', 'https://api.securitycenter.microsoft.com/api/machines/abc/isolate'],
      ['POST', 'https://graph.microsoft.com/v1.0/security/runHuntingQuery/../../users'],
      ['POST', 'http://graph.microsoft.com/v1.0/security/runHuntingQuery'],
      ['GET', 'https://evil.example/v1.0/security/runHuntingQuery'],
    ]
    for (const [m, u] of bad) expect(() => assertAllowedRequest(m, u), `${m} ${u}`).toThrow(BlockedRequestError)
  })

  it('rejects unsafe KQL and enforces length', () => {
    for (const q of ['externaldata(x:string)["https://x"]', 'T | evaluate http_request("https://x")', '.drop table X', 'cluster("x").database("y").T']) {
      expect(() => assertSafeKql(q), q).toThrow(UnsafeQueryError)
    }
    expect(() => assertSafeKql('a'.repeat(10_001))).toThrow(/longer than/)
    expect(assertSafeKql('  DeviceProcessEvents | take 10 ')).toBe('DeviceProcessEvents | take 10')
  })

  it('clamps absurd row caps and timeouts', () => {
    expect(clampRows(1_000_000)).toBe(HARD_ROW_CAP)
    expect(clampRows(-5)).toBe(100)
    expect(clampTimeout(10 * 60_000)).toBe(120_000)
  })
})

describe('Advanced Hunting + Sentinel tools (#45, #46)', () => {
  it('demo mode returns labelled fixture rows and enforces the row cap', async () => {
    const org = await makeOrg('Demo')
    const r = await new HuntingClient().runAdvancedHunting({ orgId: org, kql: 'DeviceEvents | take 5000', maxRows: 5000 })
    expect(r.mode).toBe('demo')
    expect(r.rows.length).toBe(HARD_ROW_CAP)
    expect(r.truncated).toBe(true)
    const inc = await new HuntingClient().listSentinelIncidents({ orgId: org })
    expect(inc.mode).toBe('demo')
    expect(inc.incidents[0]!.title).toMatch(/\[demo\]/)
  })

  it('live mode calls only allowlisted endpoints with a broker token and translates errors', async () => {
    const org = await makeOrg('Live')
    await upsertConnector(org, { tenantId: TENANT, clientId: CLIENT, clientSecret: 'x', sentinelWorkspaceId: '11111111-2222-3333-4444-555555555555' })
    setTokenBroker(new TokenBroker({ clientCredentials: async () => ({ accessToken: 'live-token', expiresAt: Date.now() + 3600_000 }) }))
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer live-token')
      if (url.includes('runHuntingQuery')) return Response.json({ schema: [{ name: 'A' }], results: Array.from({ length: 150 }, (_, i) => ({ A: i })) })
      return Response.json({ error: { code: 'InsufficientAccessError', message: 'nope' } }, { status: 403 })
    })
    const client = new HuntingClient(fetchImpl as unknown as typeof fetch)
    const r = await client.runAdvancedHunting({ orgId: org, kql: 'T | take 150' })
    expect(r.mode).toBe('live')
    expect(r.rows).toHaveLength(100)
    expect(r.rowCount).toBe(150)
    await expect(client.runSentinelKql({ orgId: org, kql: 'SecurityEvent | take 1' })).rejects.toThrow(/Permission denied.*HTTP 403/)
  })
})

describe('hunt cases + propose → review → run (#47, #48)', () => {
  it('CRUD is org-scoped and evidence renders in order', async () => {
    const a = await makeOrg('HuntA')
    const b = await makeOrg('HuntB')
    const u = await makeUser()
    await member(a, u)
    const h = await createHunt(a, u, { title: 'PowerShell abuse', hypothesis: 'Encoded commands on workstations' })
    expect((await listHunts(a)).map((x) => x.id)).toContain(h.id)
    expect(await listHunts(b)).toHaveLength(0)
    expect(await getHunt(b, h.id)).toBeNull()
  })

  it('agent tool proposes but cannot execute; human edit is what runs; results land on the trail', async () => {
    setHuntingClient(new HuntingClient())
    const org = await makeOrg('Flow')
    const u = await makeUser()
    await member(org, u)
    const h = await createHunt(org, u, { title: 'Hunt' })
    const tools = buildTools({ orgId: org, userId: u, agentKey: 'hunter', threadId: null, traces: [] })
    const proposed = (await (tools.propose_kql!.execute as (a: unknown) => Promise<{ proposalId: string; note: string }>)({ huntId: h.id, target: 'defender', kql: 'DeviceEvents | take 10' }))
    expect(proposed.note).toMatch(/Not executed/)
    const [p] = await getDb().select().from(kqlProposals).where(eq(kqlProposals.id, proposed.proposalId))
    expect(p!.status).toBe('proposed')
    expect(p!.ranAt).toBeNull()

    const run = await approveAndRunKql(org, u, proposed.proposalId, 'DeviceEvents | where ActionType == "ProcessCreated" | take 3')
    expect(run.status).toBe('run')
    const [after] = await getDb().select().from(kqlProposals).where(eq(kqlProposals.id, proposed.proposalId))
    expect(after!.kql).toBe('DeviceEvents | where ActionType == "ProcessCreated" | take 3')
    expect(after!.originalKql).toBe('DeviceEvents | take 10')
    const trail = (await getHunt(org, h.id))!.evidence.map((e) => e.type)
    expect(trail).toEqual(['kql_proposed', 'kql_approved', 'kql_result'])
    await expect(approveAndRunKql(org, u, proposed.proposalId)).rejects.toThrow(/only a pending proposal/)
  })

  it('rejected and expired proposals never run', async () => {
    const org = await makeOrg('Rej')
    const u = await makeUser()
    await member(org, u)
    const h = await createHunt(org, u, { title: 'Hunt' })
    const p1 = await proposeKql(org, { type: 'agent', id: 'hunter' }, { huntId: h.id, target: 'sentinel', kql: 'SecurityEvent | take 1' })
    await rejectKql(org, u, p1.id)
    await expect(approveAndRunKql(org, u, p1.id)).rejects.toThrow(/rejected/)

    const p2 = await proposeKql(org, { type: 'agent', id: 'hunter' }, { huntId: h.id, target: 'sentinel', kql: 'SecurityEvent | take 1' })
    await getDb().update(kqlProposals).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(kqlProposals.id, p2.id))
    expect(await expireKqlProposals()).toBeGreaterThanOrEqual(1)
    await expect(approveAndRunKql(org, u, p2.id)).rejects.toThrow(/expired/)
  })

  it('blocked KQL never reaches review', async () => {
    const org = await makeOrg('Blocked')
    const u = await makeUser()
    await member(org, u)
    const h = await createHunt(org, u, { title: 'Hunt' })
    await expect(proposeKql(org, { type: 'agent', id: 'hunter' }, { huntId: h.id, target: 'defender', kql: 'externaldata(a:string)["x"]' })).rejects.toThrow(UnsafeQueryError)
  })
})

describe('"Approve all" runs the query shown, edits included (#123)', () => {
  const proposal = (id: string, kql: string, status = 'proposed') => ({ id, kql, status, rationale: `Check: ${id}` })

  it('sends each panel\'s shown text, oldest first, and counts the edits', () => {
    // Loader order is newest first.
    const proposals = [proposal('c', 'C | take 1'), proposal('b', 'B | take 1', 'run'), proposal('a', 'A | take 1')]
    const edits = { a: 'A | where X == 1 | take 1', c: 'C | take 1' }
    const plan = approveAllPlan(proposals, edits)
    expect(plan).toEqual([
      { proposalId: 'a', name: 'a', kql: 'A | where X == 1 | take 1', edited: true },
      { proposalId: 'c', name: 'c', kql: 'C | take 1', edited: false },
    ])
    // The text sent is exactly the text each panel shows.
    for (const item of plan) expect(item.kql).toBe(shownKql(proposals.find((p) => p.id === item.proposalId)!, edits))
  })

  it('what is sent is what runs and is stored, under the member policy', async () => {
    setHuntingClient(new HuntingClient())
    const org = await makeOrg('ApproveAll')
    const u = await makeUser()
    await member(org, u, 'approver')
    const h = await createHunt(org, u, { title: 'Approve all' })
    await proposeKql(org, { type: 'agent', id: 'hunter' }, { huntId: h.id, target: 'defender', kql: 'DeviceEvents | take 10' })
    await proposeKql(org, { type: 'agent', id: 'hunter' }, { huntId: h.id, target: 'defender', kql: 'DeviceInfo | take 10' })
    const pending = (await getHunt(org, h.id))!.proposals
    const narrowed = pending.find((p) => p.kql.startsWith('DeviceEvents'))!
    const plan = approveAllPlan(pending, { [narrowed.id]: 'DeviceEvents | where DeviceName == "wks-1" | take 10' })
    for (const item of plan) expect((await approveAndRunKql(org, u, item.proposalId, item.kql, 'approver')).status).toBe('run')
    const after = (await getHunt(org, h.id))!.proposals
    for (const item of plan) expect(after.find((p) => p.id === item.proposalId)!.kql).toBe(item.kql)
    expect(after.find((p) => p.id === narrowed.id)!.originalKql).toBe('DeviceEvents | take 10')
  })
})

describe('approval rules hold for the hunt page changes', () => {
  afterEach(() => {
    delete process.env.KQL_APPROVAL_POLICY
    resetEnvForTests()
  })

  it("'second-person': Approve all is hidden, and an edited query is still refused by the server", async () => {
    process.env.KQL_APPROVAL_POLICY = 'second-person'
    resetEnvForTests()
    setHuntingClient(new HuntingClient())
    const org = await makeOrg('TwoPeople')
    const asker = await makeUser()
    const other = await makeUser()
    await member(org, asker, 'approver')
    await member(org, other, 'approver')
    const h = await createHunt(org, asker, { title: 'Two people' })
    const p = await proposeKql(org, { type: 'user', id: asker }, { huntId: h.id, target: 'defender', kql: 'DeviceEvents | take 10' })
    const row = (await getHunt(org, h.id))!.proposals[0]!
    expect(canApproveEveryProposal('second-person', { userId: other, role: 'approver' }, [row])).toBe(false)
    // Even if a client sent an Approve all payload with an edit, the server refuses it.
    const [item] = approveAllPlan([row], { [p.id]: 'DeviceEvents | take 1' })
    await expect(approveAndRunKql(org, other, item!.proposalId, item!.kql, 'approver')).rejects.toThrow(/cannot be edited at approval/)
    await expect(approveAndRunKql(org, asker, p.id, undefined, 'approver')).rejects.toThrow(/another approver must run it/)
    const [still] = await getDb().select().from(kqlProposals).where(eq(kqlProposals.id, p.id))
    expect(still!.status).toBe('proposed')
    expect((await approveAndRunKql(org, other, p.id, undefined, 'approver')).status).toBe('run')
  })

  it('the run records who approved it, so the page can name them (#160)', async () => {
    setHuntingClient(new HuntingClient())
    const org = await makeOrg('Named')
    const u = await makeUser()
    await member(org, u)
    const h = await createHunt(org, u, { title: 'Named approver' })
    const p = await proposeKql(org, { type: 'agent', id: 'hunter' }, { huntId: h.id, target: 'defender', kql: 'DeviceEvents | take 10' })
    await approveAndRunKql(org, u, p.id, 'DeviceEvents | take 5')
    const after = (await getHunt(org, h.id))!.proposals[0]!
    expect(after.decidedBy).toBe(u)
    expect(after.decidedAt).toBeInstanceOf(Date)
    expect(editedBeforeApproval(after)).toBe(true)
    expect(personName({ [u]: 'Pat Analyst' }, after.decidedBy)).toBe('Pat Analyst')
    expect(personName({}, after.decidedBy)).toBe('a former member')
    expect(proposerText({}, { proposedByType: 'agent', proposedById: 'hunter', requestedBy: u })).toBe('agent hunter, for a former member')
  })
})

describe('hunt page helpers (#167)', () => {
  it('says intervals with the right plural', () => {
    expect(intervalText(60)).toBe('every hour')
    expect(intervalText(360)).toBe('every 6 hours')
    expect(intervalText(1440)).toBe('every day')
    expect(intervalText(2880)).toBe('every 2 days')
    expect(intervalText(10080)).toBe('every week')
    expect(intervalText(90)).toBe('every 90 minutes')
  })
})
