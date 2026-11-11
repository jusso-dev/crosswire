import { EventType, type StreamChunk } from '@tanstack/ai'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { auth, resetAuthForTests } from '../src/server/auth/auth'
import { getDb } from '../src/server/db/client'
import { agentCapacity, agentRunOutputs, agentRuns, agentUsage } from '../src/server/db/schema'
import { resetEnvForTests } from '../src/server/env'
import { handleChat } from '../src/server/chat/handler'
import { createThread, listMessages } from '../src/server/chat/threads'
import { acquireRunSlot, acquireSlot, checkBudget, releaseOnce } from '../src/server/agents/budgets'
import { LlmAgentRuntime, withTimeout } from '../src/server/agents/runtime'
import { finishRun, requestRunCancel, reconcileStaleRuns, startRun } from '../src/server/agents/runs'
import { getCurrentOrg } from '../src/server/orgs'
import { makeOrg, team } from './helpers'
import { mockEnv, startMockModel } from './mock-model'

const BASE = 'http://localhost:3000'
const ENV_KEYS = ['MODEL_PROVIDER', 'OPENAI_BASE_URL', 'OPENAI_API_KEY', 'OPENAI_MODEL'] as const

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key]
  resetEnvForTests()
})

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

function chatRequest(cookie: string, threadId: string, text: string, signal: AbortSignal) {
  return new Request(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({
      threadId,
      runId: crypto.randomUUID(),
      state: {},
      messages: [{ id: crypto.randomUUID(), role: 'user', content: text, parts: [{ type: 'text', content: text }] }],
      tools: [],
      context: [],
      forwardedProps: { agentKey: 'lead' },
    }),
    signal,
  })
}

/** Wait until `check` returns true, without a fixed sleep (#178). */
async function waitFor(check: () => Promise<boolean>) {
  await vi.waitFor(
    async () => {
      if (!(await check())) throw new Error('timed out waiting for run state')
    },
    { timeout: 5_000, interval: 20 },
  )
}

describe('cancellation races', () => {
  it('decrements one slot when the same release runs twice at once', async () => {
    const orgId = await makeOrg()
    await acquireSlot(orgId)
    await acquireSlot(orgId)
    const release = releaseOnce(orgId)
    await Promise.all([release(), release(), release()])
    const [once] = await getDb().select().from(agentCapacity).where(eq(agentCapacity.orgId, orgId))
    expect(once?.inflight).toBe(1)
    await release()
    const [again] = await getDb().select().from(agentCapacity).where(eq(agentCapacity.orgId, orgId))
    expect(again?.inflight).toBe(1)
  })

  it('releases only slots a reconciled run held, once, and does not touch another org', async () => {
    const orgId = await makeOrg()
    const other = await makeOrg()
    const live = await startRun({ orgId, agentKey: 'lead' })
    await acquireRunSlot(orgId, live!.id)
    const staleHeld = await startRun({ orgId, agentKey: 'hunter' })
    await acquireRunSlot(orgId, staleHeld!.id)
    await getDb().update(agentRuns).set({ startedAt: new Date(Date.now() - 10 * 60_000) }).where(eq(agentRuns.id, staleHeld!.id))
    const cancelledHeld = await startRun({ orgId, agentKey: 'scribe' })
    await acquireRunSlot(orgId, cancelledHeld!.id)
    await requestRunCancel(orgId, cancelledHeld!.id)
    const neverHeld = await startRun({ orgId, agentKey: 'intel' })
    await getDb().update(agentRuns).set({ startedAt: new Date(Date.now() - 10 * 60_000) }).where(eq(agentRuns.id, neverHeld!.id))
    const otherRun = await startRun({ orgId: other, agentKey: 'lead' })
    await acquireRunSlot(other, otherRun!.id)

    const healed = await reconcileStaleRuns()
    expect(healed.interrupted).toBe(3)
    const rows = await getDb().select().from(agentRuns).where(eq(agentRuns.orgId, orgId))
    expect(rows.find((row) => row.id === live!.id)?.status).toBe('running')
    expect(rows.find((row) => row.id === staleHeld!.id)?.status).toBe('interrupted')
    expect(rows.find((row) => row.id === staleHeld!.id)?.slotReleased).toBe(true)
    expect(rows.find((row) => row.id === cancelledHeld!.id)?.status).toBe('interrupted')
    expect(rows.find((row) => row.id === neverHeld!.id)?.slotReleased).toBe(false)
    const [capacity] = await getDb().select().from(agentCapacity).where(eq(agentCapacity.orgId, orgId))
    expect(capacity?.inflight).toBe(1)
    const [otherCap] = await getDb().select().from(agentCapacity).where(eq(agentCapacity.orgId, other))
    expect(otherCap?.inflight).toBe(1)
    const second = await reconcileStaleRuns()
    expect(second.interrupted).toBe(0)
    const [after] = await getDb().select().from(agentCapacity).where(eq(agentCapacity.orgId, orgId))
    expect(after?.inflight).toBe(1)
    const [otherAfter] = await getDb().select().from(agentCapacity).where(eq(agentCapacity.orgId, other))
    expect(otherAfter?.inflight).toBe(1)
  })

  it('does not put a released slot back while the run is still marked running', async () => {
    const orgId = await makeOrg()
    const run = await startRun({ orgId, agentKey: 'lead' })
    await acquireRunSlot(orgId, run!.id)
    const release = releaseOnce(orgId, run!.id)
    await release()
    const [released] = await getDb().select().from(agentCapacity).where(eq(agentCapacity.orgId, orgId))
    expect(released?.inflight).toBe(0)
    await reconcileStaleRuns()
    const [after] = await getDb().select().from(agentCapacity).where(eq(agentCapacity.orgId, orgId))
    expect(after?.inflight).toBe(0)
    await release()
    const [again] = await getDb().select().from(agentCapacity).where(eq(agentCapacity.orgId, orgId))
    expect(again?.inflight).toBe(0)
  })

  it('keeps a finished specialist slot until release, then returns it once', async () => {
    const orgId = await makeOrg()
    const holder = await startRun({ orgId, agentKey: 'lead' })
    await acquireRunSlot(orgId, holder!.id)
    const child = await startRun({ orgId, agentKey: 'hunter' })
    await acquireRunSlot(orgId, child!.id)
    await finishRun(orgId, child!.id, 'completed')
    await reconcileStaleRuns()
    const [mid] = await getDb().select().from(agentCapacity).where(eq(agentCapacity.orgId, orgId))
    expect(mid?.inflight).toBe(2)
    const release = releaseOnce(orgId, child!.id)
    await Promise.all([release(), release()])
    const [after] = await getDb().select().from(agentCapacity).where(eq(agentCapacity.orgId, orgId))
    expect(after?.inflight).toBe(1)
  })

  it('a client disconnect mid-stream ends only the stream: the run completes and the reply is saved (#128)', async () => {
    const answer = 'the full answer arrives after the client left'
    // The model answers only when the test releases it, so the client can leave mid-run.
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    let asked!: () => void
    const modelAsked = new Promise<void>((resolve) => (asked = resolve))
    const model = await startMockModel(async () => {
      asked()
      await gate
      return { text: answer }
    })
    const saved: Record<string, string | undefined> = {}
    try {
      for (const [key, value] of Object.entries(mockEnv(model.baseUrl))) {
        saved[key] = process.env[key]
        process.env[key] = value
      }
      resetEnvForTests()
      resetAuthForTests()
      const cookie = await signUp(`leave-${crypto.randomUUID().slice(0, 8)}@example.test`)
      const session = await auth().api.getSession({ headers: new Headers({ cookie }) })
      const org = (await getCurrentOrg(session!.user.id))!
      const thread = await createThread(org.id, session!.user.id)
      const abort = new AbortController()
      const res = await handleChat(chatRequest(cookie, thread.id, 'Please answer after I leave', abort.signal))
      expect(res.status).toBe(200)
      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      // The first event names the run, so the page can offer Stop and "Watch the steps".
      const first = decoder.decode((await reader.read()).value)
      expect(first).toContain('crosswire:run')
      await modelAsked
      const [running] = await getDb().select().from(agentRuns).where(eq(agentRuns.orgId, org.id))
      expect(running?.status).toBe('running')
      await getDb().update(agentCapacity).set({ inflight: 5 }).where(eq(agentCapacity.orgId, org.id))

      // The analyst follows "Watch the steps": the browser aborts the request and stops reading.
      abort.abort()
      await reader.cancel()
      release()

      await vi.waitFor(
        async () => {
          const rows = await listMessages(org.id, session!.user.id, thread.id)
          expect(rows.at(-1)?.role).toBe('assistant')
        },
        { timeout: 10_000, interval: 20 },
      )
      const runs = await getDb().select().from(agentRuns).where(eq(agentRuns.orgId, org.id))
      const [capacity] = await getDb().select().from(agentCapacity).where(eq(agentCapacity.orgId, org.id))
      expect({ statuses: runs.map((row) => row.status), cancel: runs.map((row) => row.cancelRequestedAt != null), inflight: capacity?.inflight, runs: runs.length }).toEqual({
        statuses: ['completed'],
        cancel: [false],
        inflight: 4,
        runs: 1,
      })
      const messages = await listMessages(org.id, session!.user.id, thread.id)
      expect(messages.map((m) => [m.role, m.content])).toEqual([
        ['user', 'Please answer after I leave'],
        ['assistant', answer],
      ])
      expect((messages[1]!.metadata as { runId?: string }).runId).toBe(running!.id)
      const outputs = await getDb().select().from(agentRunOutputs).where(eq(agentRunOutputs.orgId, org.id))
      expect(outputs.find((row) => row.kind === 'assistant')?.body).toBe(answer)
    } finally {
      release()
      await model.close()
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      resetEnvForTests()
    }
  })

  it('Stop still ends a run as interrupted, saves what was written, and does not label it a timeout', async () => {
    const partial = 'partial answer that stays whole'
    const model = await startMockModel(() => ({ hold: true, text: partial }))
    const saved: Record<string, string | undefined> = {}
    try {
      for (const [key, value] of Object.entries(mockEnv(model.baseUrl))) {
        saved[key] = process.env[key]
        process.env[key] = value
      }
      resetEnvForTests()
      resetAuthForTests()
      const cookie = await signUp(`cancel-${crypto.randomUUID().slice(0, 8)}@example.test`)
      const session = await auth().api.getSession({ headers: new Headers({ cookie }) })
      const org = (await getCurrentOrg(session!.user.id))!
      const thread = await createThread(org.id, session!.user.id)
      const abort = new AbortController()
      const res = await handleChat(chatRequest(cookie, thread.id, 'Please hold this turn', abort.signal))
      expect(res.status).toBe(200)
      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let seen = ''
      while (!seen.includes(partial)) {
        const next = await reader.read()
        if (next.done) break
        seen += decoder.decode(next.value)
      }
      expect(seen).toContain(partial)
      const [running] = await getDb().select().from(agentRuns).where(eq(agentRuns.orgId, org.id))
      expect(running?.status).toBe('running')
      expect(running?.cancelRequestedAt).toBeNull()
      await getDb().update(agentCapacity).set({ inflight: 5 }).where(eq(agentCapacity.orgId, org.id))
      await requestRunCancel(org.id, running!.id)
      while (true) {
        const next = await reader.read()
        if (next.done) break
        seen += decoder.decode(next.value)
      }
      expect(abort.signal.aborted).toBe(false)
      // The stored id reaches the page before the stream ends (#169).
      expect(seen).toContain('crosswire:saved')
      const events = seen
        .split('\n\n')
        .map((b) => b.replace(/^data: /, '').trim())
        .filter(Boolean)
        .map((b) => JSON.parse(b) as { type: string; name?: string })
      const savedAt = events.findIndex((e) => e.name === 'crosswire:saved')
      const terminalAt = events.findIndex((e) => e.type === 'RUN_FINISHED' || e.type === 'RUN_ERROR')
      expect(savedAt).toBeGreaterThan(-1)
      if (terminalAt !== -1) expect(savedAt).toBeLessThan(terminalAt)
      const stored = await listMessages(org.id, session!.user.id, thread.id)
      expect(stored.at(-1)).toMatchObject({ role: 'assistant', content: partial })
      const runs = await getDb().select().from(agentRuns).where(eq(agentRuns.orgId, org.id))
      const [capacity] = await getDb().select().from(agentCapacity).where(eq(agentCapacity.orgId, org.id))
      expect({ statuses: runs.map((row) => row.status), cancel: runs.map((row) => row.cancelRequestedAt != null), inflight: capacity?.inflight, runs: runs.length }).toEqual({
        statuses: ['interrupted'],
        cancel: [true],
        inflight: 4,
        runs: 1,
      })
      const outputs = await getDb().select().from(agentRunOutputs).where(eq(agentRunOutputs.orgId, org.id))
      const assistant = outputs.find((row) => row.kind === 'assistant')
      expect(assistant?.body).toBe(partial)
      expect(assistant?.body.includes('[truncated')).toBe(false)
      expect(seen.toLowerCase().includes('timed out')).toBe(false)
    } finally {
      await model.close()
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      resetEnvForTests()
    }
  })

  it('does not report a client abort as a timeout, and does report the timeout abort', async () => {
    const client = new AbortController()
    client.abort()
    const clientText: string[] = []
    async function* done() {
      yield { type: EventType.TEXT_MESSAGE_CONTENT, delta: 'kept', timestamp: Date.now() } as unknown as StreamChunk
    }
    for await (const chunk of withTimeout(done(), 60_000, client)) {
      if (chunk.type === EventType.RUN_ERROR) clientText.push((chunk as { message?: string }).message ?? '')
      if (chunk.type === EventType.TEXT_MESSAGE_CONTENT && 'delta' in chunk && typeof chunk.delta === 'string') clientText.push(chunk.delta)
    }
    expect(clientText).toEqual(['kept'])

    const timed = new AbortController()
    async function* untilAbort(signal: AbortSignal) {
      yield { type: EventType.TEXT_MESSAGE_CONTENT, delta: 'wait', timestamp: Date.now() } as unknown as StreamChunk
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve()
        else signal.addEventListener('abort', () => resolve(), { once: true })
      })
    }
    const timedText: string[] = []
    for await (const chunk of withTimeout(untilAbort(timed.signal), 1000, timed)) {
      if (chunk.type === EventType.RUN_ERROR) timedText.push((chunk as { message?: string }).message ?? '')
    }
    expect(timedText).toEqual(['Agent timed out after 1s.'])
  })

  it('releases a specialist slot when abort fires during the non-streaming call', async () => {
    const t = await team()
    const model = await startMockModel(() => ({ hold: true, text: 'specialist still running' }))
    const saved = { ...process.env }
    Object.assign(process.env, mockEnv(model.baseUrl))
    resetEnvForTests()
    const abort = new AbortController()
    try {
      const rt = new LlmAgentRuntime()
      const tool = (
        rt as unknown as {
          delegateParallelTool: (
            input: unknown,
            traces: unknown[],
          ) => { execute: (args: unknown) => Promise<{ results: Array<{ error?: string; answer?: string }> }> }
        }
      ).delegateParallelTool({ orgId: t.orgId, userId: t.analyst, selection: 'lead-orchestrate', threadId: null, messages: [], abortController: abort }, [])
      const pending = tool.execute({ tasks: [{ agent: 'hunter', task: 'hold this specialist' }] })
      await waitFor(async () => model.calls.length >= 1)
      await getDb().update(agentCapacity).set({ inflight: 5 }).where(eq(agentCapacity.orgId, t.orgId))
      abort.abort()
      const out = await pending
      const [capacity] = await getDb().select().from(agentCapacity).where(eq(agentCapacity.orgId, t.orgId))
      const runs = await getDb().select().from(agentRuns).where(eq(agentRuns.orgId, t.orgId))
      expect(out.results[0]?.error).toBeTruthy()
      expect(out.results[0]?.error?.includes('timed out')).toBe(false)
      expect(capacity?.inflight).toBe(4)
      expect(runs.map((row) => row.status)).toEqual(['interrupted'])
    } finally {
      await model.close()
      for (const key of Object.keys(process.env)) {
        if (!(key in saved)) delete process.env[key]
      }
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      resetEnvForTests()
    }
  })

  it('stops a held specialist when another caller requests cancel, and does not label it a timeout', async () => {
    const t = await team()
    const model = await startMockModel(() => ({ hold: true, text: 'specialist still running' }))
    const saved = { ...process.env }
    Object.assign(process.env, mockEnv(model.baseUrl))
    resetEnvForTests()
    const abort = new AbortController()
    try {
      const rt = new LlmAgentRuntime()
      const tool = (
        rt as unknown as {
          delegateParallelTool: (
            input: unknown,
            traces: unknown[],
          ) => { execute: (args: unknown) => Promise<{ results: Array<{ error?: string; answer?: string }> }> }
        }
      ).delegateParallelTool({ orgId: t.orgId, userId: t.analyst, selection: 'lead-orchestrate', threadId: null, messages: [], abortController: abort }, [])
      const pending = tool.execute({ tasks: [{ agent: 'hunter', task: 'hold this specialist' }] })
      await waitFor(async () => {
        const rows = await getDb().select().from(agentRuns).where(eq(agentRuns.orgId, t.orgId))
        return model.calls.length >= 1 && rows.some((row) => row.status === 'running')
      })
      await getDb().update(agentCapacity).set({ inflight: 5 }).where(eq(agentCapacity.orgId, t.orgId))
      const [running] = await getDb().select().from(agentRuns).where(eq(agentRuns.orgId, t.orgId))
      await requestRunCancel(t.orgId, running!.id)
      const out = await pending
      const [capacity] = await getDb().select().from(agentCapacity).where(eq(agentCapacity.orgId, t.orgId))
      const runs = await getDb().select().from(agentRuns).where(eq(agentRuns.orgId, t.orgId))
      expect(out.results[0]?.error).toBeTruthy()
      expect(out.results[0]?.error?.toLowerCase().includes('timed out')).toBe(false)
      expect(abort.signal.aborted).toBe(true)
      expect(capacity?.inflight).toBe(4)
      expect(runs.map((row) => row.status)).toEqual(['interrupted'])
      expect(runs[0]?.cancelRequestedAt).toBeTruthy()
    } finally {
      await model.close()
      for (const key of Object.keys(process.env)) {
        if (!(key in saved)) delete process.env[key]
      }
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      resetEnvForTests()
    }
  })

  it('marks a specialist failed when the slot is refused and does not take another slot', async () => {
    const t = await team()
    process.env.BUDGET_MAX_INFLIGHT = '1'
    resetEnvForTests()
    try {
      await acquireSlot(t.orgId)
      const rt = new LlmAgentRuntime()
      const tool = (
        rt as unknown as {
          delegateParallelTool: (input: unknown, traces: unknown[]) => { execute: (args: unknown) => Promise<{ results: Array<{ error?: string }> }> }
        }
      ).delegateParallelTool({ orgId: t.orgId, userId: t.analyst, selection: 'lead-orchestrate', threadId: null, messages: [], abortController: new AbortController() }, [])
      const out = await tool.execute({ tasks: [{ agent: 'hunter', task: 'slot should refuse' }] })
      expect(out.results[0]?.error).toMatch(/inflight/)
      const runs = await getDb().select().from(agentRuns).where(eq(agentRuns.orgId, t.orgId))
      expect(runs.map((row) => row.status)).toEqual(['failed'])
      const [capacity] = await getDb().select().from(agentCapacity).where(eq(agentCapacity.orgId, t.orgId))
      expect(capacity?.inflight).toBe(1)
    } finally {
      delete process.env.BUDGET_MAX_INFLIGHT
      resetEnvForTests()
    }
  })

  it('records an unmeasured row when the model sends no usage and then refuses the daily cap', async () => {
    const t = await team()
    const model = await startMockModel(() => ({ text: 'answer without usage', omitUsage: true }))
    const saved: Record<string, string | undefined> = {}
    try {
      for (const [key, value] of Object.entries(mockEnv(model.baseUrl))) {
        saved[key] = process.env[key]
        process.env[key] = value
      }
      resetEnvForTests()
      const rt = new LlmAgentRuntime()
      const handle = await rt.run({
        orgId: t.orgId,
        userId: t.analyst,
        selection: 'lead',
        threadId: null,
        messages: [{ role: 'user', content: 'hello from the test' }],
        abortController: new AbortController(),
      })
      let text = ''
      for await (const chunk of handle.stream) {
        if (chunk.type === EventType.TEXT_MESSAGE_CONTENT && 'delta' in chunk && typeof chunk.delta === 'string') text += chunk.delta
      }
      expect(text).toContain('answer without usage')
      const rows = await getDb().select().from(agentUsage).where(eq(agentUsage.orgId, t.orgId))
      expect(rows).toHaveLength(1)
      expect(rows[0]?.inputTokens).toBeNull()
      expect(rows[0]?.estimatedCostMicros).toBeNull()
      const next = await checkBudget(t.orgId, { sessionId: 'again', model: 'mock', text: 'another note' })
      expect(next.ok).toBe(false)
      expect(next.reason).toMatch(/no token count/)
      const [capacity] = await getDb().select().from(agentCapacity).where(eq(agentCapacity.orgId, t.orgId))
      expect(capacity?.inflight).toBe(0)
    } finally {
      await model.close()
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      resetEnvForTests()
    }
  })

  it('treats a 0/0 usage chunk with assistant text as unmeasured, including under a spend cap', async () => {
    const t = await team()
    const model = await startMockModel(() => ({ text: 'answer with a blank usage line', usage: { prompt_tokens: 0, completion_tokens: 0 } }))
    const saved: Record<string, string | undefined> = {}
    try {
      for (const [key, value] of Object.entries({ ...mockEnv(model.baseUrl), BUDGET_USD_PER_MILLION_TOKENS: '2' })) {
        saved[key] = process.env[key]
        process.env[key] = value
      }
      resetEnvForTests()
      const rt = new LlmAgentRuntime()
      const handle = await rt.run({
        orgId: t.orgId,
        userId: t.analyst,
        selection: 'lead',
        threadId: null,
        messages: [{ role: 'user', content: 'hello from the test' }],
        abortController: new AbortController(),
      })
      let text = ''
      for await (const chunk of handle.stream) {
        if (chunk.type === EventType.TEXT_MESSAGE_CONTENT && 'delta' in chunk && typeof chunk.delta === 'string') text += chunk.delta
      }
      expect(text).toContain('answer with a blank usage line')
      const rows = await getDb().select().from(agentUsage).where(eq(agentUsage.orgId, t.orgId))
      expect(rows).toHaveLength(1)
      expect(rows[0]?.observed).toBe(true)
      expect(rows[0]?.inputTokens).toBeNull()
      expect(rows[0]?.outputTokens).toBeNull()
      expect(rows[0]?.estimatedCostMicros).toBeNull()
      const next = await checkBudget(t.orgId, { sessionId: 'blank-usage', model: 'mock', text: 'another note' })
      expect(next.ok).toBe(false)
      expect(next.reason).toMatch(/no token count/)
      process.env.BUDGET_MAX_SPEND_MICROS = '50'
      resetEnvForTests()
      const capped = await checkBudget(t.orgId, { sessionId: 'blank-usage-cap', model: 'mock', text: 'another note' })
      expect(capped.ok).toBe(false)
      expect(capped.reason).toMatch(/no token count/)
    } finally {
      await model.close()
      delete process.env.BUDGET_MAX_SPEND_MICROS
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      resetEnvForTests()
    }
  })
})
