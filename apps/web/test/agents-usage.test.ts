import { EventType, type StreamChunk } from '@tanstack/ai'
import { and, eq, sql } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDb } from '../src/server/db/client'
import { agentCapacity, agentRuns, agentUsage } from '../src/server/db/schema'
import { resetEnvForTests } from '../src/server/env'
import { acquireRunSlot, checkBudget, createUsageTally, releaseOnce } from '../src/server/agents/budgets'
import * as memory from '../src/server/agents/memory'
import * as runs from '../src/server/agents/runs'
import { appendRunEvent, finishRun, listRunEvents, reconcileStaleRuns, SLOT_RELEASE_GRACE_MS, startRun } from '../src/server/agents/runs'
import { budgetTextFor, LlmAgentRuntime, systemPromptFor } from '../src/server/agents/runtime'
import { makeOrg, team } from './helpers'
import { mockEnv, startMockModel, type MockReply, type MockRequest } from './mock-model'

/** Point the runtime at a mock model for one test, then put the environment back. */
async function withMock(reply: (req: MockRequest) => MockReply | Promise<MockReply>, extra: Record<string, string> = {}) {
  const model = await startMockModel(reply)
  const saved: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries({ ...mockEnv(model.baseUrl), ...extra })) {
    saved[key] = process.env[key]
    process.env[key] = value
  }
  resetEnvForTests()
  return {
    model,
    restore: async () => {
      await model.close()
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      resetEnvForTests()
    },
  }
}

afterEach(() => resetEnvForTests())

type DelegateTool = { execute: (args: unknown) => Promise<{ agent: string; answer?: string }> }
function delegateTool(rt: LlmAgentRuntime, orgId: string, userId: string): DelegateTool {
  return (rt as unknown as { delegateTool: (i: unknown, tr: unknown[], p: string | null) => DelegateTool }).delegateTool(
    { orgId, userId, selection: 'lead-orchestrate', threadId: null, messages: [], abortController: new AbortController() },
    [],
    null,
  )
}

async function drain(stream: AsyncIterable<StreamChunk>) {
  let text = ''
  let error: string | null = null
  for await (const chunk of stream) {
    if (chunk.type === EventType.TEXT_MESSAGE_CONTENT && 'delta' in chunk && typeof chunk.delta === 'string') text += chunk.delta
    if (chunk.type === EventType.RUN_ERROR) error = (chunk as { message?: string }).message ?? 'error'
  }
  return { text, error }
}

describe('specialist usage is counted (#185)', () => {
  it('sums every RUN_FINISHED count and ignores other chunks', () => {
    const tally = (chunks: unknown[]) => {
      const t = createUsageTally()
      for (const c of chunks) t.add(c)
      return t
    }
    expect(tally([]).total()).toBeNull()
    expect(tally([{ type: 'TEXT_MESSAGE_CONTENT', delta: 'x', usage: { promptTokens: 9, completionTokens: 9 } }]).total()).toBeNull()
    const sum = tally([
      { type: 'RUN_STARTED' },
      { type: 'RUN_FINISHED', usage: { promptTokens: 12, completionTokens: 4 } },
      { type: 'RUN_FINISHED', usage: { promptTokens: 200, completionTokens: 20 } },
    ])
    expect(sum.total()).toEqual({ inputTokens: 212, outputTokens: 24 })
    expect(sum.missing).toBe(false)
    // One call with no count makes the whole turn unmeasured: the cap cannot be checked.
    const gap = tally([{ type: 'RUN_FINISHED', usage: { promptTokens: 12, completionTokens: 4 } }, { type: 'RUN_FINISHED' }])
    expect(gap.total()).toBeNull()
    expect(gap.missing).toBe(true)
  })

  it('estimates a cut-off call from its reservation and the characters written so far', () => {
    const t = createUsageTally()
    t.add({ type: 'RUN_FINISHED', usage: { promptTokens: 100, completionTokens: 10 } })
    t.add({ type: 'TEXT_MESSAGE_CONTENT', delta: 'x'.repeat(41) })
    expect(t.total()).toEqual({ inputTokens: 100, outputTokens: 10 })
    expect(t.stoppedEstimate(50)).toEqual({ inputTokens: 150, outputTokens: 21 })
  })

  it('a delegated turn stores real counts, so the next chat call in the organisation is not refused', async () => {
    const t = await team()
    const mock = await withMock(() => ({ text: 'specialist answer', usage: { prompt_tokens: 30, completion_tokens: 7 } }))
    try {
      const rt = new LlmAgentRuntime()
      const out = await delegateTool(rt, t.orgId, t.analyst).execute({ agent: 'intel', task: 'what is CVE-2026-1' })
      expect(out.answer).toMatch(/specialist answer/)
      const rows = await getDb().select().from(agentUsage).where(eq(agentUsage.orgId, t.orgId))
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ observed: true, inputTokens: 30, outputTokens: 7 })

      const next = await checkBudget(t.orgId, { sessionId: 'after-delegate', model: 'mock', text: 'second question' })
      expect(next.reason).toBeUndefined()
      expect(next.ok).toBe(true)
      const handle = await rt.run({ orgId: t.orgId, userId: t.analyst, selection: 'lead', threadId: null, messages: [{ role: 'user', content: 'second question' }], abortController: new AbortController() })
      const second = await drain(handle.stream)
      expect(second.error).toBeNull()
      expect(second.text).toMatch(/specialist answer/)
    } finally {
      await mock.restore()
    }
  })

  it('a specialist whose provider sends no count still fails closed', async () => {
    const t = await team()
    const mock = await withMock(() => ({ text: 'answer without usage', omitUsage: true }))
    try {
      await delegateTool(new LlmAgentRuntime(), t.orgId, t.analyst).execute({ agent: 'intel', task: 'what is CVE-2026-2' })
      const [row] = await getDb().select().from(agentUsage).where(and(eq(agentUsage.orgId, t.orgId), eq(agentUsage.observed, true)))
      expect(row?.inputTokens).toBeNull()
      const next = await checkBudget(t.orgId, { sessionId: 'after-unmeasured', model: 'mock', text: 'second question' })
      expect(next.ok).toBe(false)
      expect(next.reason).toMatch(/no token count/)
    } finally {
      await mock.restore()
    }
  })
})

async function readUntilText(stream: AsyncIterable<StreamChunk>, onText: () => void) {
  let text = ''
  let error: string | null = null
  let stopped = false
  for await (const chunk of stream) {
    if (chunk.type === EventType.TEXT_MESSAGE_CONTENT && 'delta' in chunk && typeof chunk.delta === 'string') {
      text += chunk.delta
      if (!stopped) {
        stopped = true
        onText()
      }
    }
    if (chunk.type === EventType.RUN_ERROR) error = (chunk as { message?: string }).message ?? 'error'
  }
  return { text, error }
}

describe('turn usage is the sum of every model call (#186)', () => {
  it('a tool call then text stores both requests', async () => {
    const t = await team()
    const mock = await withMock((req) =>
      req.lastRole === 'tool' ? { text: 'final answer', usage: { prompt_tokens: 200, completion_tokens: 20 } } : { toolCall: { name: 'memory_search', args: { query: 'patch window' } } },
    )
    try {
      const handle = await new LlmAgentRuntime().run({ orgId: t.orgId, userId: t.analyst, selection: 'lead', threadId: null, messages: [{ role: 'user', content: 'when is the patch window?' }], abortController: new AbortController() })
      const out = await drain(handle.stream)
      expect(out.error).toBeNull()
      expect(mock.model.calls).toHaveLength(2)
      const rows = await getDb().select().from(agentUsage).where(eq(agentUsage.orgId, t.orgId))
      expect(rows).toHaveLength(1)
      // The mock's tool-call request reports 12 in and 4 out by default.
      expect(rows[0]).toMatchObject({ observed: true, inputTokens: 212, outputTokens: 24 })
    } finally {
      await mock.restore()
    }
  })

  it('a stopped reply stores an estimate and does not block the next call', async () => {
    const t = await team()
    const mock = await withMock((req) => (req.lastUser === 'hold please' ? { hold: true, text: 'partial answer' } : { text: 'second answer' }))
    try {
      const rt = new LlmAgentRuntime()
      const abort = new AbortController()
      const handle = await rt.run({ orgId: t.orgId, userId: t.analyst, selection: 'lead', threadId: null, messages: [{ role: 'user', content: 'hold please' }], abortController: abort })
      const out = await readUntilText(handle.stream, () => abort.abort(new Error('cancelled')))
      expect(out.text).toContain('partial')
      await handle.release?.()
      const [row] = await getDb().select().from(agentUsage).where(and(eq(agentUsage.orgId, t.orgId), eq(agentUsage.runId, handle.runId!)))
      expect(row?.observed).toBe(false)
      expect(row?.inputTokens).toBeGreaterThan(0)
      expect(row?.outputTokens).toBe(Math.ceil('partial answer'.length / 4))

      const next = await checkBudget(t.orgId, { sessionId: 'after-stop', model: 'mock', text: 'next question' })
      expect(next.reason).toBeUndefined()
      const second = await drain((await rt.run({ orgId: t.orgId, userId: t.analyst, selection: 'lead', threadId: null, messages: [{ role: 'user', content: 'next question' }], abortController: new AbortController() })).stream)
      expect(second.error).toBeNull()
      expect(second.text).toBe('second answer')
    } finally {
      await mock.restore()
    }
  }, 30_000)

  it('a provider error before any count stores an estimate, not the unmeasured marker', async () => {
    const t = await team()
    const mock = await withMock(() => ({ status: 500, body: JSON.stringify({ error: { message: 'provider down' } }) }))
    try {
      const handle = await new LlmAgentRuntime().run({ orgId: t.orgId, userId: t.analyst, selection: 'lead', threadId: null, messages: [{ role: 'user', content: 'hello' }], abortController: new AbortController() })
      const out = await drain(handle.stream)
      expect(out.error).toBeTruthy()
      const rows = await getDb().select().from(agentUsage).where(eq(agentUsage.orgId, t.orgId))
      expect(rows).toHaveLength(1)
      expect(rows[0]?.observed).toBe(false)
      expect(rows[0]?.inputTokens).toBeGreaterThan(0)
      expect((await checkBudget(t.orgId, { sessionId: 'after-error', model: 'mock', text: 'again' })).ok).toBe(true)
    } finally {
      await mock.restore()
    }
  })
})

describe('run setup clean-up and the input estimate (#201)', () => {
  it('a failing memoryContext finishes the run as failed, returns the slot and sends an error event', async () => {
    const t = await team()
    const mock = await withMock(() => ({ text: 'never reached' }))
    // The first read is for the run row's memory hash. The second, inside the system prompt, fails.
    const spy = vi.spyOn(memory, 'memoryContext').mockResolvedValueOnce('').mockRejectedValueOnce(new Error('memory store offline'))
    try {
      const handle = await new LlmAgentRuntime().run({ orgId: t.orgId, userId: t.analyst, selection: 'lead', threadId: null, messages: [{ role: 'user', content: 'hello' }], abortController: new AbortController() })
      const out = await drain(handle.stream)
      expect(out.error).toMatch(/memory store offline/)
      const [run] = await getDb().select().from(agentRuns).where(eq(agentRuns.id, handle.runId!))
      expect(run?.status).toBe('failed')
      expect(await getDb().select().from(agentUsage).where(eq(agentUsage.orgId, t.orgId))).toHaveLength(0)
      expect(mock.model.calls).toHaveLength(0)
    } finally {
      spy.mockRestore()
      await mock.restore()
    }
  })

  it('a failure after the slot is taken returns the slot and drops the daily claim', async () => {
    const t = await team()
    const mock = await withMock(() => ({ text: 'never reached' }))
    const real = runs.recordRunOutput
    const spy = vi.spyOn(runs, 'recordRunOutput').mockImplementation(async (runId, orgId, kind, value) => {
      if (kind === 'routing') throw new Error('replay store offline')
      return real(runId, orgId, kind, value)
    })
    try {
      const handle = await new LlmAgentRuntime().run({ orgId: t.orgId, userId: t.analyst, selection: 'lead', threadId: null, messages: [{ role: 'user', content: 'hello' }], abortController: new AbortController() })
      expect((await drain(handle.stream)).error).toMatch(/replay store offline/)
      const [run] = await getDb().select().from(agentRuns).where(eq(agentRuns.id, handle.runId!))
      expect(run).toMatchObject({ status: 'failed', slotHeld: true, slotReleased: true })
      const [capacity] = await getDb().select().from(agentCapacity).where(eq(agentCapacity.orgId, t.orgId))
      expect(capacity?.inflight).toBe(0)
      expect(await getDb().select().from(agentUsage).where(eq(agentUsage.orgId, t.orgId))).toHaveLength(0)
    } finally {
      spy.mockRestore()
      await mock.restore()
    }
  })

  it('the estimate includes the system prompt, so a long charter counts against BUDGET_MAX_INPUT_TOKENS', async () => {
    const t = await team()
    const prompt = await systemPromptFor(t.orgId, 'lead', false)
    expect(budgetTextFor(prompt, [{ content: 'hi' }])).toBe(`${prompt}\nhi`)
    // The message alone is 1 token; the charter is a few hundred.
    const cap = String(Math.ceil(prompt.length / 4) - 10)
    const mock = await withMock(() => ({ text: 'should not run' }), { BUDGET_MAX_INPUT_TOKENS: cap })
    try {
      const handle = await new LlmAgentRuntime().run({ orgId: t.orgId, userId: t.analyst, selection: 'lead', threadId: null, messages: [{ role: 'user', content: 'hi' }], abortController: new AbortController() })
      expect((await drain(handle.stream)).error).toMatch(/BUDGET_MAX_INPUT_TOKENS/)
      expect(mock.model.calls).toHaveLength(0)
    } finally {
      await mock.restore()
    }
  })
})

describe('run slots and run events (#191)', () => {
  async function plantFailure(table: string, when: string) {
    const name = `cw_fail_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
    await getDb().execute(sql.raw(`create function ${name}() returns trigger language plpgsql as $$ begin raise exception 'planted failure'; end $$;`))
    await getDb().execute(sql.raw(`create trigger ${name} before update on ${table} for each row when (${when}) execute function ${name}();`))
    return async () => {
      await getDb().execute(sql.raw(`drop trigger ${name} on ${table}`))
      await getDb().execute(sql.raw(`drop function ${name}()`))
    }
  }

  it('a failed decrement keeps the slot claim, and a retry of the same release returns it', async () => {
    const orgId = await makeOrg()
    const run = await startRun({ orgId, agentKey: 'lead' })
    await acquireRunSlot(orgId, run!.id)
    const drop = await plantFailure('agent_capacity', 'new.inflight < old.inflight')
    const release = releaseOnce(orgId, run!.id)
    await expect(release()).rejects.toThrow(/agent_capacity/)
    const [mid] = await getDb().select().from(agentRuns).where(eq(agentRuns.id, run!.id))
    expect(mid?.slotReleased).toBe(false)
    await drop()
    await release()
    const [after] = await getDb().select().from(agentRuns).where(eq(agentRuns.id, run!.id))
    expect(after?.slotReleased).toBe(true)
    const [capacity] = await getDb().select().from(agentCapacity).where(eq(agentCapacity.orgId, orgId))
    expect(capacity?.inflight).toBe(0)
  })

  it('a slot that cannot be claimed on the row is not counted', async () => {
    const orgId = await makeOrg()
    const run = await startRun({ orgId, agentKey: 'lead' })
    await acquireRunSlot(orgId, run!.id)
    await expect(acquireRunSlot(orgId, run!.id)).rejects.toThrow(/could not be claimed/)
    const [capacity] = await getDb().select().from(agentCapacity).where(eq(agentCapacity.orgId, orgId))
    expect(capacity?.inflight).toBe(1)
  })

  it('concurrent event writes for one run all land with distinct sequence numbers', async () => {
    const orgId = await makeOrg()
    const run = await startRun({ orgId, agentKey: 'lead' })
    await Promise.all(Array.from({ length: 8 }, (_, i) => appendRunEvent(run!.id, orgId, 'probe', { i })))
    const seqs = (await listRunEvents(orgId, run!.id)).map((e) => e.seq)
    expect(seqs).toEqual(Array.from({ length: 9 }, (_, i) => i + 1))
  })

  it('one bad row does not stop the cleanup, and a later cleanup returns its slot', async () => {
    const orgId = await makeOrg()
    const old = new Date(Date.now() - 10 * 60_000)
    const bad = await startRun({ orgId, agentKey: 'hunter' })
    const good = await startRun({ orgId, agentKey: 'intel' })
    for (const r of [bad!, good!]) {
      await acquireRunSlot(orgId, r.id)
      await getDb().update(agentRuns).set({ startedAt: old }).where(eq(agentRuns.id, r.id))
    }
    const drop = await plantFailure('agent_runs', `new.slot_released and new.id = '${bad!.id}'`)
    try {
      await expect(reconcileStaleRuns()).resolves.toEqual({ interrupted: 2 })
    } finally {
      await drop()
    }
    const rows = await getDb().select().from(agentRuns).where(eq(agentRuns.orgId, orgId))
    expect(rows.find((r) => r.id === good!.id)?.slotReleased).toBe(true)
    expect(rows.find((r) => r.id === bad!.id)).toMatchObject({ status: 'interrupted', slotReleased: false })
    // The finished row still holds its slot. After the grace period the cleanup returns it.
    await getDb().update(agentRuns).set({ finishedAt: new Date(Date.now() - SLOT_RELEASE_GRACE_MS - 1000) }).where(eq(agentRuns.id, bad!.id))
    await reconcileStaleRuns()
    const [badAfter] = await getDb().select().from(agentRuns).where(eq(agentRuns.id, bad!.id))
    expect(badAfter?.slotReleased).toBe(true)
    const [capacity] = await getDb().select().from(agentCapacity).where(eq(agentCapacity.orgId, orgId))
    expect(capacity?.inflight).toBe(0)
  })

  it('a finished row whose own release failed is returned after the grace period, and not before', async () => {
    const orgId = await makeOrg()
    const run = await startRun({ orgId, agentKey: 'scribe' })
    await acquireRunSlot(orgId, run!.id)
    await finishRun(orgId, run!.id, 'completed')
    await reconcileStaleRuns()
    const [early] = await getDb().select().from(agentRuns).where(eq(agentRuns.id, run!.id))
    expect(early?.slotReleased).toBe(false)
    await getDb().update(agentRuns).set({ finishedAt: new Date(Date.now() - SLOT_RELEASE_GRACE_MS - 1000) }).where(eq(agentRuns.id, run!.id))
    await reconcileStaleRuns()
    const [capacity] = await getDb().select().from(agentCapacity).where(eq(agentCapacity.orgId, orgId))
    expect(capacity?.inflight).toBe(0)
  })
})
