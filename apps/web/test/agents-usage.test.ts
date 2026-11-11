import { EventType, type StreamChunk } from '@tanstack/ai'
import { and, eq } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { getDb } from '../src/server/db/client'
import { agentUsage } from '../src/server/db/schema'
import { resetEnvForTests } from '../src/server/env'
import { checkBudget, usageFromChunks } from '../src/server/agents/budgets'
import { LlmAgentRuntime } from '../src/server/agents/runtime'
import { team } from './helpers'
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
    expect(usageFromChunks([])).toBeNull()
    expect(usageFromChunks([{ type: 'TEXT_MESSAGE_CONTENT', usage: { promptTokens: 9, completionTokens: 9 } }])).toBeNull()
    expect(
      usageFromChunks([
        { type: 'RUN_STARTED' },
        { type: 'RUN_FINISHED', usage: { promptTokens: 12, completionTokens: 4 } },
        { type: 'RUN_FINISHED' },
        { type: 'RUN_FINISHED', usage: { promptTokens: 200, completionTokens: 20 } },
      ]),
    ).toEqual({ inputTokens: 212, outputTokens: 24 })
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
