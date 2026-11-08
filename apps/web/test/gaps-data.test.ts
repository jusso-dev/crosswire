import { afterEach, describe, expect, it, vi } from 'vitest'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { getDb } from '../src/server/db/client'
import { agentDecisions, auditEvents, chatMessages, chatThreads, huntEvidence, kqlProposals, messageFeedback, tiFetchCache } from '../src/server/db/schema'
import { resetEnvForTests } from '../src/server/env'
import { approveAndRunKql, createHunt, getHunt, proposeKql } from '../src/server/hunting/hunts'
import { HuntingClient, setHuntingClient } from '../src/server/hunting/client'
import { huntReportMarkdown, REPORT_MAX_CHARS, SCHEDULED_SAMPLE_BUDGET, SCHEDULED_SAMPLE_RUNS } from '../src/server/hunting/report'
import { createSchedule, runDueSchedules } from '../src/server/hunting/schedules'
import { buildTools, withoutSamples } from '../src/server/agents/tools'
import { loadDemoFixtures } from '../src/server/ops/fixtures'
import { DECISION_SAMPLES_REMOVED, runRetention } from '../src/server/ops/retention'
import { politeFetch } from '../src/server/ti/http'
import { team } from './helpers'

const DAY = 86_400_000
const ENV_KEYS = ['KQL_APPROVAL_POLICY', 'RETENTION_CHAT_DAYS', 'RETENTION_DECISIONS_DAYS', 'RETENTION_SAMPLES_DAYS', 'RETENTION_AUDIT_DAYS', 'TI_MAX_RESPONSE_BYTES'] as const

function withEnv(vars: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
  Object.assign(process.env, vars)
  resetEnvForTests()
}

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k]
  resetEnvForTests()
})

const ago = (days: number) => new Date(Date.now() - days * DAY)

describe('KQL approval policy', () => {
  async function setup() {
    setHuntingClient(new HuntingClient())
    const t = await team()
    const hunt = await createHunt(t.orgId, t.analyst, { title: 'Policy' })
    const byUser = (id: string, kql = 'DeviceInfo | take 1') => proposeKql(t.orgId, { type: 'user', id }, { huntId: hunt.id, target: 'defender', kql })
    return { t, hunt, byUser }
  }

  it('records requestedBy: the user for a user proposal, the chat user for an agent proposal', async () => {
    const { t, hunt, byUser } = await setup()
    expect((await byUser(t.analyst)).requestedBy).toBe(t.analyst)
    const tools = buildTools({ orgId: t.orgId, userId: t.analyst, agentKey: 'hunter', threadId: null, traces: [] })
    const out = (await (tools.propose_kql!.execute as (a: unknown) => Promise<{ proposalId: string }>)({ huntId: hunt.id, target: 'defender', kql: 'DeviceEvents | take 5' }))
    const [row] = await getDb().select().from(kqlProposals).where(eq(kqlProposals.id, out.proposalId))
    expect(row!.proposedByType).toBe('agent')
    expect(row!.proposedById).toBe('hunter')
    expect(row!.requestedBy).toBe(t.analyst)
  })

  it("'member' (default): any member runs, edits allowed, role not needed", async () => {
    const { t, byUser } = await setup()
    const p = await byUser(t.analyst)
    expect((await approveAndRunKql(t.orgId, t.analyst, p.id, 'DeviceInfo | take 2')).status).toBe('run')
  })

  it("'approver': analysts are refused with a clear message; approvers and owners run", async () => {
    withEnv({ KQL_APPROVAL_POLICY: 'approver' })
    const { t, byUser } = await setup()
    const p = await byUser(t.analyst)
    await expect(approveAndRunKql(t.orgId, t.analyst, p.id, undefined, 'analyst')).rejects.toThrow('Only owners and approvers can run searches in this organisation.')
    // No role passed fails closed.
    await expect(approveAndRunKql(t.orgId, t.approver, p.id)).rejects.toThrow(/Only owners and approvers/)
    const [still] = await getDb().select().from(kqlProposals).where(eq(kqlProposals.id, p.id))
    expect(still!.status).toBe('proposed')
    // An approver may run their own proposal, edited, under 'approver'.
    const own = await byUser(t.approver)
    expect((await approveAndRunKql(t.orgId, t.approver, own.id, 'DeviceInfo | take 3', 'approver')).status).toBe('run')
    expect((await approveAndRunKql(t.orgId, t.owner, p.id, undefined, 'owner')).status).toBe('run')
  })

  it("'second-person': requester and proposer cannot run it; another approver can, unedited", async () => {
    withEnv({ KQL_APPROVAL_POLICY: 'second-person' })
    const { t, hunt, byUser } = await setup()
    const p = await byUser(t.approver)
    await expect(approveAndRunKql(t.orgId, t.approver, p.id, undefined, 'approver')).rejects.toThrow(/another approver must run it/)
    await expect(approveAndRunKql(t.orgId, t.analyst, p.id, undefined, 'analyst')).rejects.toThrow(/Only owners and approvers/)

    // Editing at approval is refused, even for a different approver; the proposal stays pending.
    await expect(approveAndRunKql(t.orgId, t.owner, p.id, 'DeviceInfo | take 9', 'owner')).rejects.toThrow(/Propose the edited search as a new search/)
    const [still] = await getDb().select().from(kqlProposals).where(eq(kqlProposals.id, p.id))
    expect(still!.status).toBe('proposed')
    // Whitespace-only differences are not an edit (assertSafeKql trims).
    expect((await approveAndRunKql(t.orgId, t.owner, p.id, '  DeviceInfo | take 1  ', 'owner')).status).toBe('run')

    // The edit, proposed as a new search by the editor, needs someone else.
    const edit = await proposeKql(t.orgId, { type: 'user', id: t.owner }, { huntId: hunt.id, target: 'defender', kql: 'DeviceInfo | take 9' })
    await expect(approveAndRunKql(t.orgId, t.owner, edit.id, undefined, 'owner')).rejects.toThrow(/another approver/)
    expect((await approveAndRunKql(t.orgId, t.approver, edit.id, undefined, 'approver')).status).toBe('run')
  })

  it("'second-person': an agent proposal cannot be run by the chat user who asked for it", async () => {
    withEnv({ KQL_APPROVAL_POLICY: 'second-person' })
    const { t, hunt } = await setup()
    const p = await proposeKql(t.orgId, { type: 'agent', id: 'hunter' }, { huntId: hunt.id, target: 'defender', kql: 'DeviceEvents | take 1', requestedBy: t.approver })
    await expect(approveAndRunKql(t.orgId, t.approver, p.id, undefined, 'approver')).rejects.toThrow(/another approver/)
    expect((await approveAndRunKql(t.orgId, t.owner, p.id, undefined, 'owner')).status).toBe('run')
  })

  it("'second-person': legacy rows without requestedBy fall back to the proposer, agents allowed", async () => {
    withEnv({ KQL_APPROVAL_POLICY: 'second-person' })
    const { t, hunt, byUser } = await setup()
    const userP = await byUser(t.approver)
    const agentP = await proposeKql(t.orgId, { type: 'agent', id: 'hunter' }, { huntId: hunt.id, target: 'defender', kql: 'DeviceEvents | take 2', requestedBy: t.approver })
    await getDb().update(kqlProposals).set({ requestedBy: null }).where(inArray(kqlProposals.id, [userP.id, agentP.id]))
    await expect(approveAndRunKql(t.orgId, t.approver, userP.id, undefined, 'approver')).rejects.toThrow(/another approver/)
    expect((await approveAndRunKql(t.orgId, t.approver, agentP.id, undefined, 'approver')).status).toBe('run')
  })
})

describe('TI response size cap', () => {
  const streamOf = (chunks: string[], onPull?: () => void) => {
    let i = 0
    return new ReadableStream<Uint8Array>({
      pull(c) {
        onPull?.()
        if (i < chunks.length) c.enqueue(new TextEncoder().encode(chunks[i++]))
        else c.close()
      },
    })
  }
  const url = () => `https://feeds.example.test/${crypto.randomUUID()}.json`

  it('refuses on Content-Length before reading the body', async () => {
    withEnv({ TI_MAX_RESPONSE_BYTES: '100' })
    let pulls = 0
    const fetchImpl = async () => new Response(streamOf(['x'.repeat(50)], () => pulls++), { status: 200, headers: { 'content-length': '5000' } })
    await expect(politeFetch(url(), { fetchImpl: fetchImpl as unknown as typeof fetch })).rejects.toThrow('TI fetch refused: response larger than 100 bytes')
    expect(pulls).toBeLessThanOrEqual(1)
  })

  it('aborts a chunked response once the streamed byte count passes the cap, and caches nothing', async () => {
    withEnv({ TI_MAX_RESPONSE_BYTES: '100' })
    let pulls = 0
    const u = url()
    const fetchImpl = async () => new Response(streamOf(Array.from({ length: 50 }, () => 'y'.repeat(40)), () => pulls++), { status: 200 })
    await expect(politeFetch(u, { fetchImpl: fetchImpl as unknown as typeof fetch })).rejects.toThrow('TI fetch refused: response larger than 100 bytes')
    expect(pulls).toBeLessThan(10)
    expect(await getDb().select().from(tiFetchCache).where(eq(tiFetchCache.url, u))).toHaveLength(0)
  })

  it('accepts a streamed response at or under the cap, multi-byte characters intact', async () => {
    withEnv({ TI_MAX_RESPONSE_BYTES: '100' })
    const body = '{"name":"Zoë café"}'
    const bytes = new TextEncoder().encode(body)
    // Split inside the multi-byte "ë" so the decoder must stream.
    const split = bytes.indexOf(0xc3) + 1
    const fetchImpl = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(bytes.slice(0, split))
            c.enqueue(bytes.slice(split))
            c.close()
          },
        }),
        { status: 200 },
      )
    const r = await politeFetch(url(), { fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(r.body).toBe(body)
  })

  it('refuses an oversized cached body on the fresh-cache and 304 paths, and deletes the cache row', async () => {
    withEnv({ TI_MAX_RESPONSE_BYTES: '100' })
    const db = getDb()
    const big = 'é'.repeat(60) // 120 bytes, 60 characters: the cap counts bytes
    const fetchImpl = vi.fn(async () => new Response(null, { status: 304 }))

    const fresh = url()
    await db.insert(tiFetchCache).values({ url: fresh, status: 200, body: big, fetchedAt: new Date() })
    await expect(politeFetch(fresh, { fetchImpl: fetchImpl as unknown as typeof fetch })).rejects.toThrow('TI fetch refused: response larger than 100 bytes')
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(await db.select().from(tiFetchCache).where(eq(tiFetchCache.url, fresh))).toHaveLength(0)

    const stale = url()
    await db.insert(tiFetchCache).values({ url: stale, status: 200, etag: '"v1"', body: big, fetchedAt: ago(2) })
    await expect(politeFetch(stale, { fetchImpl: fetchImpl as unknown as typeof fetch })).rejects.toThrow('TI fetch refused: response larger than 100 bytes')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(await db.select().from(tiFetchCache).where(eq(tiFetchCache.url, stale))).toHaveLength(0)

    // At the cap, the cached body is still served.
    const ok = url()
    await db.insert(tiFetchCache).values({ url: ok, status: 200, body: 'x'.repeat(100), fetchedAt: new Date() })
    expect((await politeFetch(ok, { fetchImpl: fetchImpl as unknown as typeof fetch })).fromCache).toBe(true)
  })
})

describe('retention purge', () => {
  it('deletes old chat, decisions and audit, strips old samples keeping counts, and audits the run', async () => {
    setHuntingClient(new HuntingClient())
    const t = await team()
    const db = getDb()

    // Chat: an idle thread (cascades) and an active thread with one old and one new message.
    const [idle] = await db.insert(chatThreads).values({ orgId: t.orgId, userId: t.analyst, title: 'idle' }).returning()
    const [idleMsg] = await db.insert(chatMessages).values({ orgId: t.orgId, threadId: idle!.id, role: 'user', content: 'old', createdAt: ago(400) }).returning()
    await db.insert(messageFeedback).values({ orgId: t.orgId, messageId: idleMsg!.id, userId: t.analyst, rating: 'useful' })
    await db.update(chatThreads).set({ updatedAt: ago(400) }).where(eq(chatThreads.id, idle!.id))
    // An explicit updatedAt wins over the column's $onUpdate.
    const [idleRow] = await db.select().from(chatThreads).where(eq(chatThreads.id, idle!.id))
    expect(idleRow!.updatedAt.getTime()).toBeLessThan(ago(399).getTime())
    const [active] = await db.insert(chatThreads).values({ orgId: t.orgId, userId: t.analyst, title: 'active' }).returning()
    const [oldMsg] = await db.insert(chatMessages).values({ orgId: t.orgId, threadId: active!.id, role: 'user', content: 'old', createdAt: ago(400) }).returning()
    await db.insert(messageFeedback).values({ orgId: t.orgId, messageId: oldMsg!.id, userId: t.analyst, rating: 'wrong' })
    const [newMsg] = await db.insert(chatMessages).values({ orgId: t.orgId, threadId: active!.id, role: 'assistant', content: 'new' }).returning()

    // Decisions and audit.
    const [oldDec] = await db.insert(agentDecisions).values({ orgId: t.orgId, actorType: 'agent', actorKey: 'lead', action: 'x', createdAt: ago(400) }).returning()
    const [newDec] = await db.insert(agentDecisions).values({ orgId: t.orgId, actorType: 'agent', actorKey: 'lead', action: 'y' }).returning()
    // Historical get_hunt outputs logged with sample rows: one past the samples cutoff, one inside it.
    const legacy = '{"proposals":[{"resultSummary":{"sample":[{"DeviceName":"wks-1"}]}}]}'
    const [oldHunt] = await db.insert(agentDecisions).values({ orgId: t.orgId, actorType: 'agent', actorKey: 'hunter', action: 'tool:get_hunt', outputSummary: legacy, createdAt: ago(200) }).returning()
    const [newHunt] = await db.insert(agentDecisions).values({ orgId: t.orgId, actorType: 'agent', actorKey: 'hunter', action: 'tool:get_hunt', outputSummary: legacy, createdAt: ago(10) }).returning()
    const [oldAudit] = await db.insert(auditEvents).values({ category: 'auth', action: 'old', actorType: 'system', createdAt: ago(800) }).returning()
    const [newAudit] = await db.insert(auditEvents).values({ category: 'auth', action: 'new', actorType: 'system', createdAt: ago(100) }).returning()

    // Samples: an old run and a fresh run.
    const hunt = await createHunt(t.orgId, t.analyst, { title: 'Samples' })
    const oldP = await proposeKql(t.orgId, { type: 'user', id: t.analyst }, { huntId: hunt.id, target: 'defender', kql: 'DeviceInfo | take 4' })
    await approveAndRunKql(t.orgId, t.analyst, oldP.id)
    const newP = await proposeKql(t.orgId, { type: 'user', id: t.analyst }, { huntId: hunt.id, target: 'defender', kql: 'DeviceInfo | take 5' })
    await approveAndRunKql(t.orgId, t.analyst, newP.id)
    await db.update(kqlProposals).set({ ranAt: ago(200) }).where(eq(kqlProposals.id, oldP.id))
    const [oldEv] = await db.select().from(huntEvidence).where(and(eq(huntEvidence.huntId, hunt.id), eq(huntEvidence.type, 'kql_result'), sql`${huntEvidence.payload} ->> 'proposalId' = ${oldP.id}`))
    await db.update(huntEvidence).set({ createdAt: ago(200) }).where(eq(huntEvidence.id, oldEv!.id))
    const [before] = await db.select().from(kqlProposals).where(eq(kqlProposals.id, oldP.id))
    const beforeSummary = before!.resultSummary as { rowCount: number; sample: unknown[]; columns: string[] }
    expect(beforeSummary.sample.length).toBeGreaterThan(0)

    // Small batches exercise the loop.
    const counts = await runRetention(new Date(), { batch: 1 })
    expect(counts.chatThreads).toBeGreaterThanOrEqual(1)
    // The idle thread's message (cascade) and the active thread's old message.
    expect(counts.chatMessages).toBeGreaterThanOrEqual(2)
    expect(counts.decisionSamples).toBeGreaterThanOrEqual(1)
    expect(counts.agentDecisions).toBeGreaterThanOrEqual(1)
    expect(counts.auditEvents).toBeGreaterThanOrEqual(1)
    expect(counts.kqlSamples).toBeGreaterThanOrEqual(1)
    expect(counts.evidenceSamples).toBeGreaterThanOrEqual(1)

    expect(await db.select().from(chatThreads).where(eq(chatThreads.id, idle!.id))).toHaveLength(0)
    expect(await db.select().from(chatMessages).where(eq(chatMessages.id, idleMsg!.id))).toHaveLength(0)
    expect(await db.select().from(chatThreads).where(eq(chatThreads.id, active!.id))).toHaveLength(1)
    expect(await db.select().from(chatMessages).where(eq(chatMessages.id, oldMsg!.id))).toHaveLength(0)
    expect(await db.select().from(messageFeedback).where(eq(messageFeedback.messageId, oldMsg!.id))).toHaveLength(0)
    expect(await db.select().from(chatMessages).where(eq(chatMessages.id, newMsg!.id))).toHaveLength(1)
    expect(await db.select().from(agentDecisions).where(eq(agentDecisions.id, oldDec!.id))).toHaveLength(0)
    expect(await db.select().from(agentDecisions).where(eq(agentDecisions.id, newDec!.id))).toHaveLength(1)
    const [oldHuntAfter] = await db.select().from(agentDecisions).where(eq(agentDecisions.id, oldHunt!.id))
    expect(oldHuntAfter!.outputSummary).toBe(DECISION_SAMPLES_REMOVED)
    const [newHuntAfter] = await db.select().from(agentDecisions).where(eq(agentDecisions.id, newHunt!.id))
    expect(newHuntAfter!.outputSummary).toBe(legacy)
    expect(await db.select().from(auditEvents).where(eq(auditEvents.id, oldAudit!.id))).toHaveLength(0)
    expect(await db.select().from(auditEvents).where(eq(auditEvents.id, newAudit!.id))).toHaveLength(1)

    const [after] = await db.select().from(kqlProposals).where(eq(kqlProposals.id, oldP.id))
    expect(after!.resultSummary).toMatchObject({ sample: [], sampleExpired: true, sampleRetentionDays: 180, rowCount: beforeSummary.rowCount, columns: beforeSummary.columns })
    const [fresh] = await db.select().from(kqlProposals).where(eq(kqlProposals.id, newP.id))
    expect((fresh!.resultSummary as { sample: unknown[]; sampleExpired?: boolean }).sampleExpired).toBeUndefined()
    const [ev] = await db.select().from(huntEvidence).where(eq(huntEvidence.id, oldEv!.id))
    expect(ev!.payload).toMatchObject({ sample: [], sampleExpired: true, proposalId: oldP.id })

    const [audit] = await db.select().from(auditEvents).where(eq(auditEvents.action, 'retention_purge'))
    expect(audit!.category).toBe('system')
    expect(audit!.data).toMatchObject({ chatThreads: counts.chatThreads, kqlSamples: counts.kqlSamples })

    // Idempotent: a second run finds nothing to do for these rows.
    const again = await runRetention()
    expect(again.kqlSamples).toBe(0)
    expect(again.evidenceSamples).toBe(0)
    expect(again.chatThreads).toBe(0)
    expect(again.decisionSamples).toBe(0)
  })

  it('counts the messages a thread delete cascades to', async () => {
    withEnv({ RETENTION_DECISIONS_DAYS: '0', RETENTION_SAMPLES_DAYS: '0', RETENTION_AUDIT_DAYS: '0' })
    const t = await team()
    const db = getDb()
    // Clear out anything older tests left past the cutoff, so the counts below are exact.
    await runRetention()
    const [idle] = await db.insert(chatThreads).values({ orgId: t.orgId, userId: t.analyst, title: 'idle' }).returning()
    // Recent messages in an idle thread: only the cascade removes them.
    await db.insert(chatMessages).values([1, 2, 3].map((i) => ({ orgId: t.orgId, threadId: idle!.id, role: 'user' as const, content: `m${i}` })))
    await db.update(chatThreads).set({ updatedAt: ago(400) }).where(eq(chatThreads.id, idle!.id))
    const counts = await runRetention(new Date(), { batch: 10 })
    expect(counts.chatThreads).toBe(1)
    expect(counts.chatMessages).toBe(3)
  })

  it('a failing stage still writes the purge audit with the counts so far and partial: true, then rethrows', async () => {
    withEnv({ RETENTION_SAMPLES_DAYS: '0', RETENTION_AUDIT_DAYS: '0' })
    const t = await team()
    const db = getDb()
    await db.insert(agentDecisions).values({ orgId: t.orgId, actorType: 'agent', actorKey: 'lead', action: 'partial', createdAt: ago(400) })
    // Chat succeeds (real), then the decisions stage fails.
    const realDelete = db.delete.bind(db)
    vi.spyOn(db, 'delete').mockImplementation(((table: unknown) => {
      if (table === agentDecisions) throw new Error('decisions stage down')
      return realDelete(table as never)
    }) as never)
    try {
      await expect(runRetention()).rejects.toThrow('decisions stage down')
    } finally {
      vi.restoreAllMocks()
    }
    const rows = await db.select().from(auditEvents).where(and(eq(auditEvents.action, 'retention_purge'), sql`${auditEvents.data} @> '{"partial":true}'::jsonb`))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.result).toBe('failure')
    expect(rows[0]!.data).toMatchObject({ partial: true, error: 'decisions stage down', agentDecisions: 0, chatThreads: expect.any(Number) })
  })

  it('a setting of 0 keeps that category forever', async () => {
    withEnv({ RETENTION_CHAT_DAYS: '0', RETENTION_DECISIONS_DAYS: '0', RETENTION_SAMPLES_DAYS: '0', RETENTION_AUDIT_DAYS: '0' })
    const t = await team()
    const [dec] = await getDb().insert(agentDecisions).values({ orgId: t.orgId, actorType: 'agent', actorKey: 'lead', action: 'ancient', createdAt: ago(5000) }).returning()
    const [aud] = await getDb().insert(auditEvents).values({ category: 'auth', action: 'ancient', actorType: 'system', createdAt: ago(5000) }).returning()
    const counts = await runRetention()
    expect(counts).toEqual({ chatThreads: 0, chatMessages: 0, agentDecisions: 0, kqlSamples: 0, evidenceSamples: 0, decisionSamples: 0, auditEvents: 0 })
    expect(await getDb().select().from(agentDecisions).where(eq(agentDecisions.id, dec!.id))).toHaveLength(1)
    expect(await getDb().select().from(auditEvents).where(eq(auditEvents.id, aud!.id))).toHaveLength(1)
  })
})

describe('hunt report: repeat-search samples (#99)', () => {
  it('renders a redacted sample per scheduled run (max 5 rows), and notes runs whose sample expired', async () => {
    setHuntingClient(new HuntingClient())
    const t = await team()
    const hunt = await createHunt(t.orgId, t.analyst, { title: 'Repeat samples' })
    const p = await proposeKql(t.orgId, { type: 'user', id: t.analyst }, { huntId: hunt.id, target: 'defender', kql: 'DeviceProcessEvents | take 10' })
    await approveAndRunKql(t.orgId, t.analyst, p.id)
    const s = await createSchedule(t.orgId, { userId: t.approver, role: 'approver' }, { proposalId: p.id, intervalMinutes: 60 })
    expect((await runDueSchedules(() => new Date(Date.now() + 61 * 60_000))).ran).toBeGreaterThanOrEqual(1)

    const db = getDb()
    const [run] = await db.select().from(huntEvidence).where(and(eq(huntEvidence.huntId, hunt.id), eq(huntEvidence.type, 'scheduled_result')))
    expect(run).toBeTruthy()
    // Plant a secret and more than five rows in the run's sample.
    const rows = Array.from({ length: 8 }, (_, i) => ({ DeviceName: `wks-${i}`, Cmd: i === 0 ? 'curl -H "Authorization: Bearer abcdefghijklmnop"' : `row-${i}` }))
    await db.update(huntEvidence).set({ payload: { ...run!.payload, columns: ['DeviceName', 'Cmd'], sample: rows } }).where(eq(huntEvidence.id, run!.id))
    // A second, older run whose sample retention removed.
    await db.insert(huntEvidence).values({ orgId: t.orgId, huntId: hunt.id, type: 'scheduled_result', payload: { scheduleId: s.id, rowCount: 7, columns: ['DeviceName'], sample: [], sampleExpired: true, sampleRetentionDays: 180 }, actorType: 'system', createdAt: ago(1) })

    const md = (await huntReportMarkdown(t.orgId, hunt.id, t.analyst))!.markdown
    const section = md.slice(md.indexOf('Recent scheduled results:'), md.indexOf('## Response proposals'))
    expect(section).toContain('| DeviceName | Cmd |')
    expect(section).toContain('wks-4')
    expect(section).not.toContain('wks-5')
    expect(section).not.toContain('abcdefghijklmnop')
    expect(section).toContain('Bearer [REDACTED]')
    expect(section).toContain('Sample removed after 180 days (retention)')
    expect(section).toContain('7 rows')
    expect(md.length).toBeLessThanOrEqual(REPORT_MAX_CHARS + 200)
    // The workspace still loads the stripped run (counts kept).
    const h = await getHunt(t.orgId, hunt.id)
    expect(h!.evidence.some((e) => (e.payload as { sampleExpired?: boolean }).sampleExpired)).toBe(true)
  })
})

describe('hunt report: scheduled samples stay within their budget', () => {
  it('samples only the most recent runs within their share; older runs keep counts; proposals and timeline still appear', async () => {
    setHuntingClient(new HuntingClient())
    const t = await team()
    const hunt = await createHunt(t.orgId, t.analyst, { title: 'Many runs' })
    const db = getDb()
    // 12 runs with wide samples: each run's block is far larger than its share of the budget would allow for all.
    const wide = 'w'.repeat(70)
    const rows = Array.from({ length: 5 }, (_, i) => Object.fromEntries(Array.from({ length: 8 }, (_, c) => [`C${c}`, `${wide}-${i}`])))
    for (let i = 0; i < 12; i++) {
      await db.insert(huntEvidence).values({
        orgId: t.orgId,
        huntId: hunt.id,
        type: 'scheduled_result',
        payload: { scheduleId: 's', rowCount: 100 + i, columns: Array.from({ length: 8 }, (_, c) => `C${c}`), sample: rows.map((r) => ({ ...r, C0: `run-${i}` })) },
        actorType: 'system',
        createdAt: new Date(Date.now() - (12 - i) * 60_000),
      })
    }
    // listSchedules must return something for the section to render.
    const p = await proposeKql(t.orgId, { type: 'user', id: t.analyst }, { huntId: hunt.id, target: 'defender', kql: 'DeviceInfo | take 1' })
    await approveAndRunKql(t.orgId, t.analyst, p.id)
    await createSchedule(t.orgId, { userId: t.approver, role: 'approver' }, { proposalId: p.id, intervalMinutes: 60 })

    const md = (await huntReportMarkdown(t.orgId, hunt.id, t.analyst))!.markdown
    const section = md.slice(md.indexOf('Recent scheduled results:'), md.indexOf('## Response proposals'))
    const sampled = Array.from({ length: 12 }, (_, i) => i).filter((i) => section.includes(`| run-${i} |`))
    expect(sampled.length).toBeGreaterThan(0)
    expect(sampled.length).toBeLessThanOrEqual(SCHEDULED_SAMPLE_RUNS)
    // Only the most recent runs are sampled.
    expect(Math.min(...sampled)).toBeGreaterThanOrEqual(12 - SCHEDULED_SAMPLE_RUNS)
    expect(section.length).toBeLessThan(SCHEDULED_SAMPLE_BUDGET + 5000)
    // Every run is still listed with its count.
    for (let i = 0; i < 12; i++) expect(section).toContain(`${100 + i} rows`)
    expect(section).toMatch(/listed with row counts only/)
    expect(md).toContain('## Response proposals')
    expect(md).toContain('## Evidence timeline')
    expect(md).not.toContain('report truncated')
  })
})

describe('review follow-ups', () => {
  it('demo data loads under every KQL approval policy', async () => {
    for (const policy of ['approver', 'second-person'] as const) {
      withEnv({ KQL_APPROVAL_POLICY: policy })
      setHuntingClient(new HuntingClient())
      const t = await team()
      const r = await loadDemoFixtures(t.orgId, t.owner)
      expect(r.loaded).toBe(true)
      const ran = await getDb().select().from(kqlProposals).where(and(eq(kqlProposals.orgId, t.orgId), eq(kqlProposals.status, 'run')))
      expect(ran).toHaveLength(1)
    }
  })

  it('the decision log keeps row counts, never sample rows', () => {
    const out = withoutSamples({ proposals: [{ id: 'p', resultSummary: { rowCount: 3, sample: [{ a: 1 }, { a: 2 }] } }], rows: [{ x: 1 }] })
    expect(out).toEqual({ proposals: [{ id: 'p', resultSummary: { rowCount: 3, sampleRows: 2 } }], rowsOmitted: 1 })
    // A sample retention already removed says why, rather than looking like an empty result.
    expect(withoutSamples({ rowCount: 9, sample: [], sampleExpired: true })).toEqual({ rowCount: 9, sampleRows: 'removed (retention)', sampleExpired: true })
  })

  it('get_hunt tool output in agent_decisions has no sample rows', async () => {
    setHuntingClient(new HuntingClient())
    const t = await team()
    const hunt = await createHunt(t.orgId, t.analyst, { title: 'No samples in log' })
    const p = await proposeKql(t.orgId, { type: 'user', id: t.analyst }, { huntId: hunt.id, target: 'defender', kql: 'DeviceInfo | take 5' })
    await approveAndRunKql(t.orgId, t.owner, p.id, undefined, 'owner')
    const tools = buildTools({ orgId: t.orgId, userId: t.analyst, agentKey: 'hunter', threadId: null, traces: [] }) as Record<string, { execute?: (i: unknown) => Promise<unknown> }>
    await tools.get_hunt!.execute!({ huntId: hunt.id })
    const [row] = await getDb().select().from(agentDecisions).where(and(eq(agentDecisions.orgId, t.orgId), eq(agentDecisions.action, 'tool:get_hunt')))
    // The summary is truncated at 1000 characters; whatever is kept must hold no sample rows.
    expect(row!.outputSummary.length).toBeGreaterThan(0)
    expect(row!.outputSummary).not.toMatch(/"sample":\[\{/)
    expect(JSON.stringify(withoutSamples(await getHunt(t.orgId, hunt.id)))).not.toMatch(/"sample":\[\{/)
  })
})
