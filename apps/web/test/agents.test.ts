import { beforeAll, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { auth, resetAuthForTests } from '../src/server/auth/auth'
import { resetEnvForTests } from '../src/server/env'
import { getDb } from '../src/server/db/client'
import { agentDecisions, chatMessages } from '../src/server/db/schema'
import { handleChat } from '../src/server/chat/handler'
import { createThread, listMessages, listThreads, submitFeedback } from '../src/server/chat/threads'
import { appendMemory, compactMemory, exportHistoryMarkdown, getMemory, importHistoryMarkdown, listMemoryEntries } from '../src/server/agents/memory'
import { listDecisions, recordDecision } from '../src/server/agents/decisions'
import { charter, loadCharters } from '../src/server/agents/charters'
import { AGENT_TOOLS, EXECUTION_TOOL_NAMES, buildTools } from '../src/server/agents/tools'
import { systemPromptFor } from '../src/server/agents/runtime'
import { AGENT_KEYS } from '../src/shared/agents'
import { makeOrg, makeUser, member, readSse } from './helpers'

const BASE = 'http://localhost:3000'

async function signUp(email: string) {
  const res = await auth().handler(
    new Request(`${BASE}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE },
      body: JSON.stringify({ email, password: 'correct horse battery staple', name: email }),
    }),
  )
  return res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ')
}

function chatRequest(cookie: string | null, threadId: string, text: string, agentKey = 'lead') {
  return new Request(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({
      threadId,
      runId: crypto.randomUUID(),
      state: {},
      messages: [{ id: crypto.randomUUID(), role: 'user', content: text, parts: [{ type: 'text', content: text }] }],
      tools: [],
      context: [],
      forwardedProps: { agentKey },
    }),
  })
}

beforeAll(() => {
  resetEnvForTests()
  resetAuthForTests()
})

describe('charters + tools (#30, #56)', () => {
  it('loads five charters with the safety line', () => {
    const c = loadCharters()
    for (const k of AGENT_KEYS) expect(c[k]).toMatch(/never execute containment without an approved proposal/i)
  })

  it('no agent has an execute tool; only Responder and Lead can propose responses', () => {
    expect(EXECUTION_TOOL_NAMES).toHaveLength(0)
    const all = Object.keys(buildTools({ orgId: 'o', userId: 'u', agentKey: 'lead', threadId: null, traces: [] }))
    expect(all.some((n) => /execute|run_kql|approve/i.test(n))).toBe(false)
    for (const k of AGENT_KEYS) {
      const hasPropose = AGENT_TOOLS[k].includes('propose_response')
      expect(hasPropose).toBe(k === 'responder' || k === 'lead')
    }
    expect(AGENT_TOOLS.hunter).toContain('propose_kql')
  })

  it('system prompt differs per agent (charter-driven)', async () => {
    const org = await makeOrg('Prompts')
    const hunter = await systemPromptFor(org, 'hunter', false)
    const intel = await systemPromptFor(org, 'intel', false)
    expect(hunter).toContain(charter('hunter'))
    expect(intel).toContain(charter('intel'))
    expect(hunter).not.toEqual(intel)
  })
})

describe('/api/chat (#25, #26, #27, #32)', () => {
  it('returns 401 without a session', async () => {
    const res = await handleChat(chatRequest(null, 'x', 'hi'))
    expect(res.status).toBe(401)
  })

  it('streams a stub reply over SSE, persists both messages, tags the agent, and logs a decision', async () => {
    const cookie = await signUp('chat-user@example.test')
    const session = await auth().api.getSession({ headers: new Headers({ cookie }) })
    const { getCurrentOrg } = await import('../src/server/orgs')
    const org = (await getCurrentOrg(session!.user.id))!
    const thread = await createThread(org.id, session!.user.id)

    const res = await handleChat(chatRequest(cookie, thread.id, 'Is CVE-2026-1 exploited?', 'intel'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/)
    const events = await readSse(res)
    const text = events.filter((e) => e.type === 'TEXT_MESSAGE_CONTENT').map((e) => e.delta).join('')
    expect(text).toMatch(/stub model/)
    expect(text).toMatch(/Intel here/)
    expect(events.at(-1)?.type).toBe('RUN_FINISHED')

    const msgs = await listMessages(org.id, session!.user.id, thread.id)
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(msgs[1]!.agentKey).toBe('intel')
    const threads = await listThreads(org.id, session!.user.id)
    expect(threads[0]!.title).toBe('Is CVE-2026-1 exploited?')
    expect(threads[0]!.agentKey).toBe('intel')
    const decisions = await listDecisions(org.id, { threadId: thread.id })
    expect(decisions.some((d) => d.action === 'turn' && d.actorKey === 'intel')).toBe(true)

    // Hunter gets a different, charter-driven answer.
    const res2 = await handleChat(chatRequest(cookie, thread.id, 'Find PowerShell abuse', 'hunter'))
    const t2 = (await readSse(res2)).filter((e) => e.type === 'TEXT_MESSAGE_CONTENT').map((e) => e.delta).join('')
    expect(t2).toMatch(/Hunter here/)
    expect(t2).toMatch(/propose it on a hunt case/)
  })

  it("user B cannot read or post to user A's thread", async () => {
    const orgId = await makeOrg('Iso')
    const a = await makeUser()
    await member(orgId, a)
    const thread = await createThread(orgId, a)
    const cookieB = await signUp('intruder@example.test')
    const res = await handleChat(chatRequest(cookieB, thread.id, 'hello'))
    expect(res.status).toBe(404)
    const b = await makeUser()
    await member(orgId, b)
    await expect(listMessages(orgId, b, thread.id)).rejects.toThrow(/not found/i)
    expect(await listThreads(orgId, b)).toHaveLength(0)
  })
})

describe('memory + decisions + learning loop (#31, #33, #35)', () => {
  it('appends, persists, isolates by org, and redacts token-like strings', async () => {
    const a = await makeOrg('MemA')
    const b = await makeOrg('MemB')
    const e = await appendMemory({ orgId: a, agentKey: 'hunter', body: 'Use client_secret=abcdef123456 for tenant X' })
    expect(e.redacted).toBe(true)
    expect(e.body).not.toContain('abcdef123456')
    expect(await listMemoryEntries(a, 'hunter')).toHaveLength(1)
    expect(await listMemoryEntries(b, 'hunter')).toHaveLength(0)
  })

  it('round-trips history.md export/import', async () => {
    const org = await makeOrg('Md')
    await appendMemory({ orgId: org, agentKey: 'intel', body: 'Fortinet appears weekly in watch hits' })
    const md = await exportHistoryMarkdown(org, 'intel')
    expect(md).toMatch(/^# intel history/)
    const other = await makeOrg('Md2')
    expect(await importHistoryMarkdown(other, 'intel', md)).toBe(1)
    expect((await listMemoryEntries(other, 'intel'))[0]!.body).toBe('Fortinet appears weekly in watch hits')
  })

  it('decision log is org-scoped and never stores raw tokens', async () => {
    const a = await makeOrg('DecA')
    const b = await makeOrg('DecB')
    await recordDecision({ orgId: a, actorType: 'agent', actorKey: 'hunter', action: 'tool:stub', input: { auth: 'Bearer eyJabcdefghij.eyJabcdefghij.sigabcdefghij' } })
    const rows = await listDecisions(a)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.inputSummary).not.toContain('eyJabcdefghij.eyJabcdefghij')
    expect(await listDecisions(b)).toHaveLength(0)
  })

  it('feedback appends a memory entry and an audit row', async () => {
    const org = await makeOrg('Fb')
    const u = await makeUser()
    await member(org, u)
    const t = await createThread(org, u)
    const [msg] = await getDb().insert(chatMessages).values({ orgId: org, threadId: t.id, role: 'assistant', content: 'Answer', agentKey: 'intel' }).returning()
    const r = await submitFeedback(org, u, msg!.id, 'wrong', 'Wrong vendor')
    const entries = await listMemoryEntries(org, 'intel')
    expect(entries.find((e) => e.id === r.memoryEntryId)?.kind).toBe('feedback')
  })

  it('compaction shrinks history, bumps the version, and keeps safety bullets', async () => {
    const org = await makeOrg('Nap')
    await appendMemory({ orgId: org, agentKey: 'responder', body: 'Never isolate the domain controllers DC01 and DC02 without the CISO.' })
    for (let i = 0; i < 40; i++) await appendMemory({ orgId: org, agentKey: 'responder', body: `Routine fact number ${i} about the estate` })
    const r = await compactMemory(org, 'responder', { keepLatest: 5 })
    expect(r.after).toBeLessThan(r.before)
    expect(r.version).toBe(1)
    const mem = await getMemory(org, 'responder')
    expect(mem!.body).toContain('[safety] Never isolate the domain controllers DC01 and DC02 without the CISO.')
    const live = await listMemoryEntries(org, 'responder', { limit: 100 })
    expect(live.some((e) => e.kind === 'safety')).toBe(true)
    // Raw entries are append-only: compaction marks, never deletes.
    const all = await listMemoryEntries(org, 'responder', { includeCompacted: true, limit: 500 })
    expect(all).toHaveLength(41)
    const again = await compactMemory(org, 'responder', { keepLatest: 5 })
    expect(again.version).toBe(2)
    expect((await getMemory(org, 'responder'))!.body).toContain('DC01 and DC02')
  })

  it('tool calls write decision rows (stub tool via registry)', async () => {
    const org = await makeOrg('Tools')
    const u = await makeUser()
    await member(org, u)
    const ctx = { orgId: org, userId: u, agentKey: 'scribe' as const, threadId: null, traces: [] }
    const tools = buildTools(ctx)
    await (tools.remember!.execute as (a: unknown) => Promise<unknown>)({ fact: 'Weekly patch window is Tuesday' })
    const rows = await getDb().select().from(agentDecisions).where(and(eq(agentDecisions.orgId, org), eq(agentDecisions.action, 'tool:remember')))
    expect(rows).toHaveLength(1)
  })
})
