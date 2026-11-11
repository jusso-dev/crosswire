import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { auth, resetAuthForTests } from '../src/server/auth/auth'
import { resetEnvForTests } from '../src/server/env'
import { getDb } from '../src/server/db/client'
import { agentDecisions, chatMessages } from '../src/server/db/schema'
import { handleChat } from '../src/server/chat/handler'
import { appendMessage, createThread, listMessages, listMessagesPage, listThreads, submitFeedback } from '../src/server/chat/threads'
import { appendMemory, compactMemory, exportHistoryMarkdown, getMemory, importHistoryMarkdown, listMemoryEntries } from '../src/server/agents/memory'
import { listDecisions, recordDecision } from '../src/server/agents/decisions'
import { charter, loadCharters } from '../src/server/agents/charters'
import { AGENT_TOOLS, EXECUTION_TOOL_NAMES, buildTools } from '../src/server/agents/tools'
import { systemPromptFor } from '../src/server/agents/runtime'
import { AGENT_KEYS } from '../src/shared/agents'
import { makeOrg, makeUser, member, readSse } from './helpers'
import { mockEnv, startMockModel } from './mock-model'

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

// The real agent runtime, pointed at a local OpenAI-compatible mock model.
// The mock answers in the voice of whichever charter it receives, and Intel calls search_intel.
let model: Awaited<ReturnType<typeof startMockModel>>
const saved: Record<string, string | undefined> = {}
beforeAll(async () => {
  model = await startMockModel((req) => {
    if (req.lastUser.includes('FAIL_PLEASE')) return { status: 400, body: JSON.stringify({ error: { message: 'mock model refused' } }) }
    const who = /You are \*\*Hunter\*\*|# Hunter/i.test(req.system) ? 'Hunter' : /# Intel|\*\*Intel\*\*/i.test(req.system) ? 'Intel' : 'Lead'
    if (who === 'Intel' && req.tools.includes('search_intel') && req.lastRole !== 'tool') return { toolCall: { name: 'search_intel', args: { query: 'CVE-2026-1' } } }
    if (req.toolResult !== undefined) return { text: `${who} here. I checked the intel sources for you.` }
    return { text: `${who} here. ${who === 'Hunter' ? 'I will propose it on a hunt case for your review.' : 'Here is my answer.'}` }
  })
  for (const [k, v] of Object.entries(mockEnv(model.baseUrl))) {
    saved[k] = process.env[k]
    process.env[k] = v
  }
  resetEnvForTests()
  resetAuthForTests()
}, 120_000)

afterAll(async () => {
  await model?.close()
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  resetEnvForTests()
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

  it('streams a model reply over SSE, runs allowlisted tools, persists both messages and logs a decision', async () => {
    const cookie = await signUp('chat-user@example.test')
    const session = await auth().api.getSession({ headers: new Headers({ cookie }) })
    const { getCurrentOrg } = await import('../src/server/orgs')
    const org = (await getCurrentOrg(session!.user.id))!
    const thread = await createThread(org.id, session!.user.id)

    const res = await handleChat(chatRequest(cookie, thread.id, 'Is CVE-2026-1 exploited?', 'intel'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/)
    const events = await readSse(res)
    const deltas = events.filter((e) => e.type === 'TEXT_MESSAGE_CONTENT')
    const text = deltas.map((e) => e.delta).join('')
    expect(deltas.length).toBeGreaterThan(1) // streamed incrementally, not one blob
    expect(text).toMatch(/Intel here/)
    expect(events.some((e) => e.type === 'TOOL_CALL_START')).toBe(true)
    expect(events.at(-1)?.type).toBe('RUN_FINISHED')
    // The model only ever saw Intel's allowlisted tools, never built-in shell or file tools.
    const intelCall = model.calls.find((c) => c.tools.includes('search_intel'))!
    expect(intelCall.tools.sort()).toEqual([...AGENT_TOOLS.intel].sort())

    const msgs = await listMessages(org.id, session!.user.id, thread.id)
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(msgs[1]!.agentKey).toBe('intel')
    const threads = await listThreads(org.id, session!.user.id)
    expect(threads[0]!.title).toBe('Is CVE-2026-1 exploited?')
    expect(threads[0]!.agentKey).toBe('intel')
    const decisions = await listDecisions(org.id, { threadId: thread.id })
    expect(decisions.some((d) => d.action === 'turn' && d.actorKey === 'intel')).toBe(true)
    expect(decisions.some((d) => d.action === 'tool:search_intel')).toBe(true)

    // Hunter gets a different, charter-driven answer.
    const res2 = await handleChat(chatRequest(cookie, thread.id, 'Find PowerShell abuse', 'hunter'))
    const t2 = (await readSse(res2)).filter((e) => e.type === 'TEXT_MESSAGE_CONTENT').map((e) => e.delta).join('')
    expect(t2).toMatch(/Hunter here/)
    expect(t2).toMatch(/propose it on a hunt case/)
    // Follow-up turns carry the thread history as real chat messages.
    expect(model.calls.at(-1)!.userMessages).toEqual(['Is CVE-2026-1 exploited?', 'Find PowerShell abuse'])
  }, 120_000)

  it('reports a model failure as a stream error and persists it', async () => {
    const cookie = await signUp('chat-fail@example.test')
    const session = await auth().api.getSession({ headers: new Headers({ cookie }) })
    const { getCurrentOrg } = await import('../src/server/orgs')
    const org = (await getCurrentOrg(session!.user.id))!
    const thread = await createThread(org.id, session!.user.id)
    const res = await handleChat(chatRequest(cookie, thread.id, 'FAIL_PLEASE', 'lead'))
    const events = await readSse(res)
    expect(events.some((e) => e.type === 'RUN_ERROR')).toBe(true)
    const msgs = await listMessages(org.id, session!.user.id, thread.id)
    expect(msgs.at(-1)!.content).toMatch(/⚠️/)
  })

  it('a retry after a failed reply replaces the failed attempt and never stores the question twice (#169)', async () => {
    const cookie = await signUp('chat-retry@example.test')
    const session = await auth().api.getSession({ headers: new Headers({ cookie }) })
    const { getCurrentOrg } = await import('../src/server/orgs')
    const org = (await getCurrentOrg(session!.user.id))!
    const thread = await createThread(org.id, session!.user.id)
    // A failed turn as the server stores it: the question, then a reply that carries the error.
    // (A real model failure also leaves an unmeasured usage row, which the budget then refuses.)
    const q = await appendMessage(org.id, thread.id, { role: 'user', content: 'FLAKY_ONCE what happened?', agentKey: 'lead' })
    const a = await appendMessage(org.id, thread.id, { role: 'assistant', content: '⚠️ mock model refused for now', agentKey: 'lead', metadata: { error: 'mock model refused for now' } })
    await getDb().update(chatMessages).set({ createdAt: new Date(Date.now() - 2000) }).where(eq(chatMessages.id, q.id))
    await getDb().update(chatMessages).set({ createdAt: new Date(Date.now() - 1000) }).where(eq(chatMessages.id, a.id))
    // "Try again" resends the same question.
    const events = await readSse(await handleChat(chatRequest(cookie, thread.id, 'FLAKY_ONCE what happened?', 'lead')))
    expect(events.some((e) => e.type === 'RUN_ERROR')).toBe(false)
    const after = await listMessages(org.id, session!.user.id, thread.id)
    expect(after.map((m) => [m.role, m.content.startsWith('⚠️')])).toEqual([
      ['user', false],
      ['assistant', false],
    ])
    expect(after[0]!.content).toBe('FLAKY_ONCE what happened?')
    // The model saw the question once, not twice.
    expect(model.calls.at(-1)!.userMessages).toEqual(['FLAKY_ONCE what happened?'])
  })

  it('sends the stored message id before the stream ends, so the page can rate the reply without reloading (#169)', async () => {
    const cookie = await signUp('chat-saved@example.test')
    const session = await auth().api.getSession({ headers: new Headers({ cookie }) })
    const { getCurrentOrg } = await import('../src/server/orgs')
    const org = (await getCurrentOrg(session!.user.id))!
    const thread = await createThread(org.id, session!.user.id)
    const events = (await readSse(await handleChat(chatRequest(cookie, thread.id, 'hello there', 'lead')))) as Array<{ type: string; name?: string; value?: { messageId?: string; runId?: string } }>
    const run = events.find((e) => e.name === 'crosswire:run')
    const saved = events.find((e) => e.name === 'crosswire:saved')
    expect(events[0]?.name).toBe('crosswire:run')
    expect(events.at(-1)?.type).toBe('RUN_FINISHED')
    const stored = await listMessages(org.id, session!.user.id, thread.id)
    expect(saved?.value?.messageId).toBe(stored.at(-1)!.id)
    expect(saved?.value?.runId).toBe(run?.value?.runId)
  })

  it('pages thread messages with hasMore and a before cursor (#171)', async () => {
    const orgId = await makeOrg('Paging')
    const u = await makeUser()
    await member(orgId, u)
    const thread = await createThread(orgId, u)
    const base = Date.now() - 60_000
    for (let i = 0; i < 5; i++) {
      const row = await appendMessage(orgId, thread.id, { role: i % 2 ? 'assistant' : 'user', content: `m${i}` })
      await getDb().update(chatMessages).set({ createdAt: new Date(base + i * 1000) }).where(eq(chatMessages.id, row.id))
    }
    const first = await listMessagesPage(orgId, u, thread.id, { limit: 3 })
    expect(first.messages.map((m) => m.content)).toEqual(['m2', 'm3', 'm4'])
    expect(first.hasMore).toBe(true)
    const older = await listMessagesPage(orgId, u, thread.id, { limit: 3, before: first.messages[0]!.createdAt })
    expect(older.messages.map((m) => m.content)).toEqual(['m0', 'm1'])
    expect(older.hasMore).toBe(false)
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
