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
import { acquireRunSlot, checkBudget, claimDailyBudget, createUsageTally, outputCharCap, providerFallback, recordEstimatedUsage, recordObservedUsage, recordUnmeasuredUsage, releaseDailyClaim, releaseOnce, type UsageTally } from './budgets'
import { sha256 } from './canonical'
import { SQUAD_SDK_PIN } from './squad-sdk'
import { logger } from '../lib/logger'

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
    const described = modelDescription()
    const model = described.model ?? described.provider
    const provider = env().MODEL_PROVIDER
    let run: Awaited<ReturnType<typeof startRun>> = null
    let claimed = false
    let release: (() => Promise<void>) | undefined
    // One clean-up for every setup step (#201): a throw after the row exists finishes it as failed,
    // drops the daily claim and returns the slot, and the browser gets an error event, not a raw 500.
    try {
      const messages = prepareModelMessages(input.messages)
      const memory = await memoryContext(input.orgId, agentKey)
      run = await startRun({
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
        throw new SetupError(err instanceof ModelNotConfiguredError ? err.message : `Chat model error: ${errorText(err)}`)
      }
      const systemPrompt = await systemPromptFor(input.orgId, agentKey, orchestrate)
      // The estimate counts the system prompt as well as the messages (#201).
      const budgetText = budgetTextFor(systemPrompt, messages)
      const budget = run
        ? await claimDailyBudget(input.orgId, run.id, { sessionId: run.id, model, text: budgetText, agentKey, provider })
        : await checkBudget(input.orgId, { sessionId: input.threadId ?? input.orgId, model, text: budgetText })
      claimed = Boolean(run && budget.ok)
      if (run) await appendRunEvent(run.id, input.orgId, 'budget_estimate', { estimatedInputTokens: budget.estimatedInputTokens, utilization: budget.utilization ?? null, warning: budget.warning ?? false, ok: budget.ok, observed: false })
      if (!budget.ok) throw new SetupError(budget.reason ?? 'Budget refused the model call.')
      const slot = await acquireRunSlot(input.orgId, run?.id)
      release = releaseOnce(slot.orgId, run?.id)
      const fallback = providerFallback(provider)
      if (run) await recordRunOutput(run.id, input.orgId, 'routing', { provider: fallback.provider, switched: fallback.switched, reason: fallback.reason, sdk: SQUAD_SDK_PIN })
      const stream = chat({
        adapter,
        messages,
        threadId: input.threadId ?? `ephemeral-${crypto.randomUUID()}`,
        systemPrompts: [systemPrompt],
        tools,
        agentLoopStrategy: maxIterations(6),
        abortController: input.abortController,
        stream: true,
        // TanStack AI 1.2.0 has no chat() output-cap field. max_tokens is a provider key the library recognises.
        modelOptions: { max_tokens: env().BUDGET_MAX_OUTPUT_TOKENS } as { max_tokens: number },
      })
      return { stream: this.boundStream(stream, input, run?.id, release, budget.estimatedInputTokens), traces, runId: run?.id, release }
    } catch (err) {
      const message = errorText(err)
      if (run) {
        const runId = run.id
        await bestEffort('setup clean-up', runId, async () => {
          // No model call started, so there is nothing to measure. The reservation goes (#186).
          if (claimed) await releaseDailyClaim(input.orgId, runId)
          await recordRunOutput(runId, input.orgId, 'error', message)
          await finishRun(input.orgId, runId, 'failed', message)
        })
      }
      if (release) await bestEffort('setup slot release', run?.id ?? null, release)
      return { stream: errorStream(message), traces, runId: run?.id }
    }
  }

  private async *boundStream(stream: AsyncIterable<StreamChunk>, input: AgentRunInput, runId: string | undefined, release: () => Promise<void>, reservedInputTokens: number): AsyncIterable<StreamChunk> {
    const cap = outputCharCap()
    let chars = 0
    let assistantText = ''
    let finished = false
    const tally = createUsageTally()
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
        if (next.done) {
          finished = true
          break
        }
        const chunk = next.value
        tally.add(chunk)
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
          await settleTurnUsage({
            orgId: input.orgId,
            runId,
            agentKey: selectionAgent(input.selection),
            provider: env().MODEL_PROVIDER,
            model: described.model ?? described.provider,
            tally,
            finished,
            assistantText,
            reservedInputTokens,
          })
        }
      } finally {
        await release()
      }
    }
  }

  /**
   * Run one specialist with its own charter and tool allowlist; records a decision. The answer is
   * collected from the stream, so the usage tally keeps every count even when the call is stopped.
   */
  private async runSpecialist(input: AgentRunInput, traces: ToolContext['traces'], agent: Exclude<AgentKey, 'lead'>, task: string, via: 'delegate' | 'delegate_parallel', parentRunId: string | null) {
    const sub: ToolContext = { orgId: input.orgId, userId: input.userId, agentKey: agent, threadId: input.threadId, traces }
    const policy = loadPolicy()
    const described = modelDescription()
    const model = described.model ?? described.provider
    const provider = env().MODEL_PROVIDER
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
    const tally = createUsageTally()
    const progress = { finished: false, text: '' }
    let claimed = false
    let started = false
    let reservedInputTokens = 0
    let release: (() => Promise<void>) | undefined
    let stopCancelWatch = () => {}
    try {
      const filtered = prepareModelMessages([{ role: 'user', content: task }])
      const systemPrompt = await systemPromptFor(input.orgId, agent, false)
      const budgetText = budgetTextFor(systemPrompt, filtered)
      const budget = run
        ? await claimDailyBudget(input.orgId, run.id, { sessionId: run.id, model, text: budgetText, agentKey: agent, provider })
        : await checkBudget(input.orgId, { sessionId: `${input.threadId ?? input.orgId}:${agent}`, model, text: budgetText })
      claimed = Boolean(run && budget.ok)
      reservedInputTokens = budget.estimatedInputTokens
      if (run) await appendRunEvent(run.id, input.orgId, 'budget_estimate', { estimatedInputTokens: budget.estimatedInputTokens, utilization: budget.utilization ?? null, warning: budget.warning ?? false, ok: budget.ok, observed: false })
      if (!budget.ok) throw new SetupError(budget.reason ?? 'Budget refused the specialist call.')
      const slot = await acquireRunSlot(input.orgId, run?.id)
      release = releaseOnce(slot.orgId, run?.id)
      if (run) stopCancelWatch = watchExternalCancel(input.orgId, run.id, input.abortController)
      const stream = chat({
        adapter: createModelAdapter(agent),
        messages: filtered,
        threadId: `${input.threadId ?? 'ephemeral'}:delegate:${agent}:${crypto.randomUUID()}`,
        systemPrompts: [systemPrompt],
        tools: toolsFor(agent, sub),
        agentLoopStrategy: maxIterations(4),
        stream: true,
        abortController: input.abortController,
        modelOptions: { max_tokens: env().BUDGET_MAX_OUTPUT_TOKENS } as { max_tokens: number },
      })
      started = true
      const answer = await promiseUntilAbort(collectText(stream, tally, progress), input.abortController.signal)
      if (run) await recordRunOutput(run.id, input.orgId, 'assistant', answer)
      const capped = answer.length > outputCharCap() ? `${answer.slice(0, outputCharCap())}\n[output budget]` : answer
      const forParent = typeof prepareToolResult(capped) === 'string' ? (prepareToolResult(capped) as string) : capped
      await recordDecision({ orgId: input.orgId, actorType: 'agent', actorKey: 'lead', action: `delegate:${agent}`, input: task, output: forParent, threadId: input.threadId })
      traces.push({ tool: via, input: { agent, task }, output: forParent.slice(0, 500) })
      if (run) await finishRun(input.orgId, run.id, 'completed')
      return { agent: AGENT_LABELS[agent].name, answer: forParent }
    } catch (err) {
      if (run) {
        const runId = run.id
        await bestEffort('specialist finish', runId, () => finishRun(input.orgId, runId, input.abortController.signal.aborted ? 'interrupted' : 'failed', errorText(err)))
      }
      throw err
    } finally {
      stopCancelWatch()
      if (run) {
        const runId = run.id
        await bestEffort('specialist usage', runId, async () => {
          if (started) await settleTurnUsage({ orgId: input.orgId, runId, agentKey: agent, provider, model, tally, finished: progress.finished, assistantText: progress.text, reservedInputTokens })
          // No model call started, so the reservation goes (#186).
          else if (claimed) await releaseDailyClaim(input.orgId, runId)
        })
      }
      if (release) await release()
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

/**
 * Store one turn's usage (#186). A turn that ran to its end stores the sum of every model call's
 * counts. A turn cut off by Stop, the timeout, the output cap or a provider error stores an estimate:
 * the counts that did arrive, plus the reserved input and about ceil(chars / 4) output for the call
 * that was cut off. A provider that finished a call without any count still gets the unmeasured
 * marker, so the daily cap stays fail-closed for it.
 */
async function settleTurnUsage(input: { orgId: string; runId: string; agentKey: string; provider: string; model: string; tally: UsageTally; finished: boolean; assistantText: string; reservedInputTokens: number }) {
  const { tally } = input
  const ids = { orgId: input.orgId, runId: input.runId, agentKey: input.agentKey, provider: input.provider, model: input.model }
  // A call that finished with no count means this provider does not report usage: fail closed.
  // A turn that ran to its end, with a count for every call, stores the provider's sum.
  if (tally.missing || (input.finished && (!tally.errored || tally.errorCounted))) {
    await settleUsage({ ...ids, usage: tally.total(), assistantText: input.assistantText })
    return
  }
  const estimate = tally.stoppedEstimate(input.reservedInputTokens)
  await recordEstimatedUsage({ ...ids, inputTokens: estimate.inputTokens, outputTokens: estimate.outputTokens })
}

/** Text the input estimate is taken from: the system prompt and every message the model receives (#201). */
export function budgetTextFor(systemPrompt: string, messages: Array<{ content: string }>) {
  return [systemPrompt, ...messages.map((m) => m.content)].join('\n')
}

/** A setup step refused the turn with a message for the analyst. */
class SetupError extends Error {}

function errorText(err: unknown) {
  return err instanceof Error ? err.message : String(err)
}

/** Clean-up after a failure must not hide the first error. */
async function bestEffort(what: string, runId: string | null, fn: () => Promise<unknown>) {
  try {
    await fn()
  } catch (err) {
    logger.error(`agent ${what} failed`, { runId, error: errorText(err) })
  }
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

/**
 * Read a specialist's stream to its end, like TanStack's streamToText, while the tally sees every
 * chunk. A RUN_ERROR ends the read and is thrown.
 */
async function collectText(stream: AsyncIterable<StreamChunk>, tally: UsageTally, progress: { finished: boolean; text: string }) {
  let error: string | null = null
  for await (const chunk of stream) {
    tally.add(chunk)
    if (chunk.type === EventType.RUN_ERROR) {
      error = (chunk as { message?: string }).message || 'An error occurred'
      break
    }
    if (chunk.type === EventType.TEXT_MESSAGE_CONTENT && 'delta' in chunk && typeof chunk.delta === 'string') progress.text += chunk.delta
  }
  progress.finished = true
  if (error !== null) throw new Error(error)
  return progress.text
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
