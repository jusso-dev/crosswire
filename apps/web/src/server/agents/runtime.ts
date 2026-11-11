import { chat, maxIterations, toolDefinition, type AnyTool, type StreamChunk } from '@tanstack/ai'
import { EventType } from '@tanstack/ai'
import { z } from 'zod'
import { AGENT_LABELS, type AgentKey, type AgentSelection, ORCHESTRATE_KEY, selectionAgent } from '../../shared/agents'
import { env } from '../env'
import { memoryContext } from './memory'
import { recordDecision } from './decisions'
import { toolsFor, prepareToolResult, type ToolContext } from './tools'
import { createModelAdapter, modelDescription, ModelNotConfiguredError } from './model'
import { loadPolicy } from './policy'
import { approvedDirectiveBlock } from './directives'
import { prepareModelMessages } from './egress'
import { appendRunEvent, finishRun, getRun, recordRunOutput, reconcileStaleRuns, requestRunCancel, startRun } from './runs'
import { acquireRunSlot, checkBudget, claimDailyBudget, outputCharCap, providerFallback, recordObservedUsage, recordUnmeasuredUsage, releaseDailyClaim, releaseOnce, usageFromChunk, usageFromChunks } from './budgets'
import { sha256 } from './canonical'
import { SQUAD_SDK_PIN } from './squad-sdk'

export interface AgentRunInput {
  orgId: string
  userId: string
  selection: AgentSelection
  threadId: string | null
  /** Conversation so far, oldest first; last item is the analyst's new message. */
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
  abortController: AbortController
  /** Set by the parent turn so a specialist is a child run. */
  parentRunId?: string | null
}

export interface AgentRunHandle {
  stream: AsyncIterable<StreamChunk>
  traces: ToolContext['traces']
  runId?: string
  release?: () => Promise<void>
}

/**
 * AgentRuntime (#32). ADR 0004: Crosswire hosts the agents (charter as system prompt, per-agent
 * tool allowlist, org memory) and runs the tool loop with TanStack AI `chat()`. The model is
 * Azure OpenAI (or an OpenAI-compatible endpoint) via model.ts. The stream is AG-UI chunks.
 * Squad SDK calls validate policy and measure cost. They do not host the turn.
 */
export interface AgentRuntime {
  run(input: AgentRunInput): Promise<AgentRunHandle>
}

export async function systemPromptFor(orgId: string, agentKey: AgentKey, orchestrate: boolean) {
  const policy = loadPolicy()
  const mem = await memoryContext(orgId, agentKey)
  const directives = await approvedDirectiveBlock(orgId)
  return [
    policy.charters[agentKey],
    orchestrate
      ? 'Orchestrate mode: plan briefly. Use `delegate_parallel` for independent questions to different specialists (they run at the same time), or `delegate` when one answer feeds the next. Then give a combined, signed-off answer.'
      : '',
    directives,
    mem ? `## Org memory\n${mem}` : '',
    'Global rule: never execute containment without an approved proposal. You have no execute tools.',
  ]
    .filter(Boolean)
    .join('\n\n')
}

/** Model-backed runtime: Azure OpenAI or an OpenAI-compatible endpoint. */
export class LlmAgentRuntime implements AgentRuntime {
  async run(input: AgentRunInput): Promise<AgentRunHandle> {
    const agentKey = selectionAgent(input.selection)
    const orchestrate = input.selection === ORCHESTRATE_KEY
    const traces: ToolContext['traces'] = []
    const ctx: ToolContext = { orgId: input.orgId, userId: input.userId, agentKey, threadId: input.threadId, traces }
    if (env().RUN_LEDGER !== 'legacy') {
      try {
        await reconcileStaleRuns()
      } catch (err) {
        return { stream: errorStream(`Run recovery failed closed: ${err instanceof Error ? err.message : String(err)}`), traces }
      }
    }
    let policy
    try {
      policy = loadPolicy()
    } catch (err) {
      return { stream: errorStream(err instanceof Error ? err.message : String(err)), traces }
    }
    const messages = prepareModelMessages(input.messages)
    const memory = await memoryContext(input.orgId, agentKey)
    const described = modelDescription()
    const run = await startRun({
      orgId: input.orgId,
      agentKey,
      threadId: input.threadId,
      parentRunId: input.parentRunId,
      modelProvider: described.provider,
      modelName: described.model,
      charterSha256: policy.charterSha256[agentKey],
      policySha256: policy.sha256,
      toolsetSha256: policy.toolsetSha256[agentKey],
      memorySha256: sha256(memory),
    })
    if (run) ctx.runId = run.id
    const tools: AnyTool[] = toolsFor(agentKey, ctx)
    if (orchestrate) tools.push(this.delegateTool(input, traces, run?.id ?? null), this.delegateParallelTool(input, traces, run?.id ?? null))

    await recordDecision({
      orgId: input.orgId,
      actorType: 'agent',
      actorKey: agentKey,
      action: orchestrate ? 'orchestrate_turn' : 'turn',
      input: input.messages.at(-1)?.content ?? '',
      threadId: input.threadId,
    })

    let adapter
    try {
      adapter = createModelAdapter(agentKey)
    } catch (err) {
      const message = err instanceof ModelNotConfiguredError ? err.message : `Chat model error: ${err instanceof Error ? err.message : String(err)}`
      if (run) {
        await recordRunOutput(run.id, input.orgId, 'error', message)
        await finishRun(input.orgId, run.id, 'failed', message)
      }
      return { stream: errorStream(message), traces, runId: run?.id }
    }
    const budgetText = messages.map((m) => m.content).join('\n')
    const budget = run
      ? await claimDailyBudget(input.orgId, run.id, { sessionId: run.id, model: described.model ?? described.provider, text: budgetText, agentKey, provider: env().MODEL_PROVIDER })
      : await checkBudget(input.orgId, { sessionId: input.threadId ?? input.orgId, model: described.model ?? described.provider, text: budgetText })
    if (run) await appendRunEvent(run.id, input.orgId, 'budget_estimate', { estimatedInputTokens: budget.estimatedInputTokens, utilization: budget.utilization ?? null, warning: budget.warning ?? false, ok: budget.ok, observed: false })
    if (!budget.ok) {
      if (run) {
        await recordRunOutput(run.id, input.orgId, 'error', budget.reason ?? 'budget')
        await finishRun(input.orgId, run.id, 'failed', budget.reason)
      }
      return { stream: errorStream(budget.reason ?? 'Budget refused the model call.'), traces, runId: run?.id }
    }
    let slot: { orgId: string } | undefined
    try {
      slot = await acquireRunSlot(input.orgId, run?.id)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (run) {
        await releaseDailyClaim(input.orgId, run.id)
        await recordRunOutput(run.id, input.orgId, 'error', message)
        await finishRun(input.orgId, run.id, 'failed', message)
      }
      return { stream: errorStream(message), traces, runId: run?.id }
    }
    const fallback = providerFallback(env().MODEL_PROVIDER)
    if (run) await recordRunOutput(run.id, input.orgId, 'routing', { provider: fallback.provider, switched: fallback.switched, reason: fallback.reason, sdk: SQUAD_SDK_PIN })
    const release = releaseOnce(slot.orgId, run?.id)
    let stream: AsyncIterable<StreamChunk>
    try {
      stream = chat({
        adapter,
        messages,
        threadId: input.threadId ?? `ephemeral-${crypto.randomUUID()}`,
        systemPrompts: [await systemPromptFor(input.orgId, agentKey, orchestrate)],
        tools,
        agentLoopStrategy: maxIterations(6),
        abortController: input.abortController,
        stream: true,
        // TanStack AI 1.2.0 has no chat() output-cap field. max_tokens is a provider key the library recognises.
        modelOptions: { max_tokens: env().BUDGET_MAX_OUTPUT_TOKENS } as { max_tokens: number },
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (run) {
        await recordUnmeasuredUsage({ orgId: input.orgId, runId: run.id, agentKey, provider: env().MODEL_PROVIDER, model: described.model ?? described.provider })
        await recordRunOutput(run.id, input.orgId, 'error', message)
        await finishRun(input.orgId, run.id, 'failed', message)
      }
      await release()
      return { stream: errorStream(message), traces, runId: run?.id }
    }
    return { stream: this.boundStream(stream, input, run?.id, release), traces, runId: run?.id, release }
  }

  private async *boundStream(stream: AsyncIterable<StreamChunk>, input: AgentRunInput, runId: string | undefined, release: () => Promise<void>): AsyncIterable<StreamChunk> {
    const cap = outputCharCap()
    let chars = 0
    let assistantText = ''
    let lastUsage: { inputTokens: number; outputTokens: number } | null = null
    const iterator = stream[Symbol.asyncIterator]()
    const signal = input.abortController.signal
    const stopCancelWatch = runId ? watchExternalCancel(input.orgId, runId, input.abortController) : () => {}
    const onAbort = new Promise<'abort'>((resolve) => {
      if (signal.aborted) resolve('abort')
      else signal.addEventListener('abort', () => resolve('abort'), { once: true })
    })
    try {
      while (true) {
        const next = await Promise.race([iterator.next(), onAbort])
        if (next === 'abort') {
          await iterator.return?.()
          break
        }
        if (next.done) break
        const chunk = next.value
        const observed = usageFromChunk(chunk)
        if (observed) lastUsage = observed
        if (chunk.type === EventType.TEXT_MESSAGE_CONTENT && 'delta' in chunk && typeof chunk.delta === 'string') {
          assistantText += chunk.delta
          chars += chunk.delta.length
          if (chars > cap) {
            input.abortController.abort(new Error('output budget exceeded'))
            const message = `Output stopped at the configured budget (${env().BUDGET_MAX_OUTPUT_TOKENS} tokens).`
            yield { type: EventType.RUN_ERROR, message, timestamp: Date.now(), error: { message } } as unknown as StreamChunk
            return
          }
        }
        yield chunk
      }
    } finally {
      stopCancelWatch()
      try {
        if (runId) {
          const described = modelDescription()
          await settleUsage({
            orgId: input.orgId,
            runId,
            agentKey: selectionAgent(input.selection),
            provider: env().MODEL_PROVIDER,
            model: described.model ?? described.provider,
            usage: lastUsage,
            assistantText,
          })
        }
      } finally {
        await release()
      }
    }
  }

  /** Run one specialist non-streaming with its own charter and tool allowlist; records a decision. */
  private async runSpecialist(input: AgentRunInput, traces: ToolContext['traces'], agent: Exclude<AgentKey, 'lead'>, task: string, via: 'delegate' | 'delegate_parallel', parentRunId: string | null) {
    const childInput: AgentRunInput = { ...input, selection: agent, parentRunId, messages: [{ role: 'user', content: task }] }
    const sub: ToolContext = { orgId: input.orgId, userId: input.userId, agentKey: agent, threadId: input.threadId, traces }
    const policy = loadPolicy()
    const described = modelDescription()
    const memory = await memoryContext(input.orgId, agent)
    const run = await startRun({
      orgId: input.orgId,
      agentKey: agent,
      threadId: input.threadId,
      parentRunId,
      modelProvider: described.provider,
      modelName: described.model,
      charterSha256: policy.charterSha256[agent],
      policySha256: policy.sha256,
      toolsetSha256: policy.toolsetSha256[agent],
      memorySha256: sha256(memory),
    })
    if (run) sub.runId = run.id
    const budget = run
      ? await claimDailyBudget(input.orgId, run.id, { sessionId: run.id, model: described.model ?? described.provider, text: task, agentKey: agent, provider: env().MODEL_PROVIDER })
      : await checkBudget(input.orgId, { sessionId: `${input.threadId ?? input.orgId}:${agent}`, model: described.model ?? described.provider, text: task })
    if (run) await appendRunEvent(run.id, input.orgId, 'budget_estimate', { estimatedInputTokens: budget.estimatedInputTokens, utilization: budget.utilization ?? null, warning: budget.warning ?? false, ok: budget.ok, observed: false })
    if (!budget.ok) {
      if (run) await finishRun(input.orgId, run.id, 'failed', budget.reason)
      throw new Error(budget.reason ?? 'Budget refused the specialist call.')
    }
    let slot: { orgId: string }
    try {
      slot = await acquireRunSlot(input.orgId, run?.id)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (run) {
        await releaseDailyClaim(input.orgId, run.id)
        await finishRun(input.orgId, run.id, 'failed', message)
      }
      throw err instanceof Error ? err : new Error(message)
    }
    const release = releaseOnce(slot.orgId, run?.id)
    const stopCancelWatch = run ? watchExternalCancel(input.orgId, run.id, input.abortController) : () => {}
    let settled = false
    try {
      const filtered = prepareModelMessages(childInput.messages)
      const text = await promiseUntilAbort(
        chat({
          adapter: createModelAdapter(agent),
          messages: filtered,
          threadId: `${input.threadId ?? 'ephemeral'}:delegate:${agent}:${crypto.randomUUID()}`,
          systemPrompts: [await systemPromptFor(input.orgId, agent, false)],
          tools: toolsFor(agent, sub),
          agentLoopStrategy: maxIterations(4),
          stream: false,
          abortController: input.abortController,
          modelOptions: { max_tokens: env().BUDGET_MAX_OUTPUT_TOKENS } as { max_tokens: number },
        }),
        input.abortController.signal,
      )
      const answer = typeof text === 'string' ? text : ((text as { text?: string }).text ?? '')
      if (run) {
        // chat({ stream: false }) returns { text, chunks }. The counts are on the RUN_FINISHED chunks (#185).
        const chunks = typeof text === 'object' && text && 'chunks' in text && Array.isArray(text.chunks) ? text.chunks : []
        await settleUsage({ orgId: input.orgId, runId: run.id, agentKey: agent, provider: env().MODEL_PROVIDER, model: described.model ?? described.provider, usage: usageFromChunks(chunks), assistantText: answer })
        settled = true
      }
      if (run) await recordRunOutput(run.id, input.orgId, 'assistant', answer)
      const capped = answer.length > outputCharCap() ? `${answer.slice(0, outputCharCap())}\n[output budget]` : answer
      const forParent = typeof prepareToolResult(capped) === 'string' ? (prepareToolResult(capped) as string) : capped
      await recordDecision({ orgId: input.orgId, actorType: 'agent', actorKey: 'lead', action: `delegate:${agent}`, input: task, output: forParent, threadId: input.threadId })
      traces.push({ tool: via, input: { agent, task }, output: forParent.slice(0, 500) })
      if (run) await finishRun(input.orgId, run.id, 'completed')
      return { agent: AGENT_LABELS[agent].name, answer: forParent }
    } catch (err) {
      if (run) await finishRun(input.orgId, run.id, input.abortController.signal.aborted ? 'interrupted' : 'failed', err instanceof Error ? err.message : String(err))
      throw err
    } finally {
      stopCancelWatch()
      try {
        if (run && !settled) {
          await settleUsage({ orgId: input.orgId, runId: run.id, agentKey: agent, provider: env().MODEL_PROVIDER, model: described.model ?? described.provider, usage: null, assistantText: '' })
        }
      } finally {
        await release()
      }
    }
  }

  /** Lead's `delegate` tool: one specialist, sequential. */
  private delegateTool(input: AgentRunInput, traces: ToolContext['traces'], parentRunId: string | null): AnyTool {
    return toolDefinition({
      name: 'delegate',
      description: 'Ask one specialist (hunter, intel, responder, scribe) a focused question and get its answer.',
      inputSchema: z.object({ agent: z.enum(SPECIALISTS), task: z.string().min(5).max(2000) }),
    }).server(async ({ agent, task }) => this.runSpecialist(input, traces, agent, task, 'delegate', parentRunId))
  }

  /**
   * Lead's `delegate_parallel` tool (#93): up to 4 distinct specialists at once. Each result or error is
   * returned; one failure does not drop the others. Shares the turn's abort signal and timeout.
   */
  private delegateParallelTool(input: AgentRunInput, traces: ToolContext['traces'], parentRunId: string | null): AnyTool {
    return toolDefinition({
      name: 'delegate_parallel',
      description: 'Ask up to 4 DIFFERENT specialists independent questions at the same time. Use when no task depends on another task\'s answer.',
      inputSchema: delegateParallelInput,
    }).server(async ({ tasks }) => {
      const settled = await Promise.allSettled(tasks.map((t) => this.runSpecialist(input, traces, t.agent, t.task, 'delegate_parallel', parentRunId)))
      return {
        results: settled.map((r, i) =>
          r.status === 'fulfilled'
            ? r.value
            : { agent: AGENT_LABELS[tasks[i]!.agent].name, error: r.reason instanceof Error ? r.reason.message : String(r.reason) },
        ),
      }
    })
  }
}

const SPECIALISTS = ['hunter', 'intel', 'responder', 'scribe'] as const
export const MAX_PARALLEL_DELEGATES = 4
export const delegateParallelInput = z.object({
  tasks: z
    .array(z.object({ agent: z.enum(SPECIALISTS), task: z.string().min(5).max(2000) }))
    .min(1)
    .max(MAX_PARALLEL_DELEGATES)
    .refine((ts) => new Set(ts.map((t) => t.agent)).size === ts.length, 'Each specialist may appear at most once per delegate_parallel call.'),
})

let runtime: AgentRuntime | undefined
export function agentRuntime(): AgentRuntime {
  runtime ??= new LlmAgentRuntime()
  return runtime
}
export function setAgentRuntime(r: AgentRuntime) {
  runtime = r
}

/** Store the provider's last cumulative counts once. A 0/0 report with assistant text is unmeasured, not free. */
async function settleUsage(input: { orgId: string; runId: string; agentKey: string; provider: string; model: string; usage: { inputTokens: number; outputTokens: number } | null; assistantText: string }) {
  const blank = input.usage !== null && input.usage.inputTokens === 0 && input.usage.outputTokens === 0 && input.assistantText.length > 0
  if (!input.usage || blank) {
    await recordUnmeasuredUsage({ orgId: input.orgId, runId: input.runId, agentKey: input.agentKey, provider: input.provider, model: input.model })
    return
  }
  await recordObservedUsage({ orgId: input.orgId, runId: input.runId, agentKey: input.agentKey, provider: input.provider, model: input.model, inputTokens: input.usage.inputTokens, outputTokens: input.usage.outputTokens })
}

function timeoutAbort(signal: AbortSignal) {
  const reason = signal.reason
  return reason instanceof Error && reason.message === 'agent timeout'
}

/**
 * Abort this process's model call when another process writes cancel_requested_at.
 * The abort reason is "cancelled", so withTimeout does not report a timeout.
 * A specialist shares the turn's controller: cancelling that child also stops the parent stream.
 * A read error retries on the next tick and does not abort a healthy turn.
 */
function watchExternalCancel(orgId: string, runId: string, abort: AbortController): () => void {
  if (abort.signal.aborted) return () => {}
  const timer = setInterval(() => {
    void getRun(orgId, runId)
      .then((row) => {
        if (!row?.cancelRequestedAt || abort.signal.aborted) return
        abort.abort(new Error('cancelled'))
      })
      .catch(() => {
        // A missed read retries on the next tick.
      })
  }, 500)
  const stop = () => clearInterval(timer)
  abort.signal.addEventListener('abort', stop, { once: true })
  return stop
}

/** Reject when the signal aborts, even if the model promise does not. */
function promiseUntilAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
  return new Promise((resolve, reject) => {
    const fail = () => reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
    signal.addEventListener('abort', fail, { once: true })
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', fail))
  })
}

/** Enforce a wall-clock timeout on a stream. Only the timeout abort is reported as a timeout. */
export async function* withTimeout(stream: AsyncIterable<StreamChunk>, ms: number, abort: AbortController): AsyncIterable<StreamChunk> {
  const timer = setTimeout(() => abort.abort(new Error('agent timeout')), ms)
  const timeoutMessage = `Agent timed out after ${Math.round(ms / 1000)}s.`
  let errored = false
  try {
    for await (const chunk of stream) {
      if (chunk.type === EventType.RUN_ERROR) errored = true
      yield chunk
    }
    if (!errored && timeoutAbort(abort.signal)) {
      yield { type: EventType.RUN_ERROR, message: timeoutMessage, timestamp: Date.now(), error: { message: timeoutMessage } } as unknown as StreamChunk
    }
  } catch (err) {
    const message = timeoutAbort(abort.signal) ? timeoutMessage : err instanceof Error ? err.message : String(err)
    yield { type: EventType.RUN_ERROR, message, timestamp: Date.now(), error: { message } } as unknown as StreamChunk
  } finally {
    clearTimeout(timer)
  }
}

export const agentTimeoutMs = () => env().AGENT_TIMEOUT_MS

export async function cancelAgentRun(orgId: string, runId: string) {
  await requestRunCancel(orgId, runId)
}

/** A one-event stream that reports a setup or construction error to the chat UI. */
async function* errorStream(message: string): AsyncIterable<StreamChunk> {
  yield { type: EventType.RUN_ERROR, message, timestamp: Date.now(), error: { message } } as unknown as StreamChunk
}
