import { chat, maxIterations, toolDefinition, type AnyTool, type StreamChunk } from '@tanstack/ai'
import { EventType } from '@tanstack/ai'
import { z } from 'zod'
import { AGENT_LABELS, type AgentKey, type AgentSelection, ORCHESTRATE_KEY, selectionAgent } from '../../shared/agents'
import { env } from '../env'
import { charter } from './charters'
import { memoryContext } from './memory'
import { recordDecision } from './decisions'
import { toolsFor, type ToolContext } from './tools'
import { createModelAdapter } from './model'

export interface AgentRunInput {
  orgId: string
  userId: string
  selection: AgentSelection
  threadId: string | null
  /** Conversation so far, oldest first; last item is the analyst's new message. */
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
  abortController: AbortController
}

export interface AgentRunHandle {
  stream: AsyncIterable<StreamChunk>
  traces: ToolContext['traces']
}

/**
 * AgentRuntime (#32). ADR 0002 picked the hybrid path: the control plane runs agents in-process
 * with charters + tools via TanStack AI (any configured model, or the stub), and the same charters
 * ship as GitHub Copilot custom agents for use inside GitHub. Phase 5/6 tools register in tools.ts.
 */
export interface AgentRuntime {
  run(input: AgentRunInput): Promise<AgentRunHandle>
}

export async function systemPromptFor(orgId: string, agentKey: AgentKey, orchestrate: boolean) {
  const mem = await memoryContext(orgId, agentKey)
  return [
    charter(agentKey),
    orchestrate
      ? 'Orchestrate mode: plan briefly, call `delegate` for each specialist you need (sequentially), then give a combined, signed-off answer.'
      : '',
    mem ? `## Org memory\n${mem}` : '',
    'Global rule: never execute containment without an approved proposal. You have no execute tools.',
  ]
    .filter(Boolean)
    .join('\n\n')
}

/** Model-backed runtime (Anthropic/OpenAI via TanStack AI adapters, or the stub adapter). */
export class LlmAgentRuntime implements AgentRuntime {
  async run(input: AgentRunInput): Promise<AgentRunHandle> {
    const agentKey = selectionAgent(input.selection)
    const orchestrate = input.selection === ORCHESTRATE_KEY
    const traces: ToolContext['traces'] = []
    const ctx: ToolContext = { orgId: input.orgId, userId: input.userId, agentKey, threadId: input.threadId, traces }
    const tools: AnyTool[] = toolsFor(agentKey, ctx)
    if (orchestrate) tools.push(this.delegateTool(input, traces))

    await recordDecision({
      orgId: input.orgId,
      actorType: 'agent',
      actorKey: agentKey,
      action: orchestrate ? 'orchestrate_turn' : 'turn',
      input: input.messages.at(-1)?.content ?? '',
      threadId: input.threadId,
    })

    const stream = chat({
      adapter: createModelAdapter(agentKey),
      messages: input.messages,
      threadId: input.threadId ?? `ephemeral-${crypto.randomUUID()}`,
      systemPrompts: [await systemPromptFor(input.orgId, agentKey, orchestrate)],
      tools,
      agentLoopStrategy: maxIterations(6),
      abortController: input.abortController,
    })
    return { stream, traces }
  }

  /** Lead's `delegate` tool: run a specialist non-streaming and return its answer (sequential fan-out). */
  private delegateTool(input: AgentRunInput, traces: ToolContext['traces']): AnyTool {
    return toolDefinition({
      name: 'delegate',
      description: 'Ask one specialist (hunter, intel, responder, scribe) a focused question and get its answer.',
      inputSchema: z.object({ agent: z.enum(['hunter', 'intel', 'responder', 'scribe']), task: z.string().min(5).max(2000) }),
    }).server(async ({ agent, task }) => {
      const sub: ToolContext = { orgId: input.orgId, userId: input.userId, agentKey: agent, threadId: input.threadId, traces }
      const text = await chat({
        adapter: createModelAdapter(agent),
        messages: [{ role: 'user', content: task }],
        threadId: `${input.threadId ?? 'ephemeral'}:delegate:${agent}:${crypto.randomUUID()}`,
        systemPrompts: [await systemPromptFor(input.orgId, agent, false)],
        tools: toolsFor(agent, sub),
        agentLoopStrategy: maxIterations(4),
        stream: false,
        abortController: input.abortController,
      })
      const answer = typeof text === 'string' ? text : (text as { text?: string }).text ?? ''
      await recordDecision({ orgId: input.orgId, actorType: 'agent', actorKey: 'lead', action: `delegate:${agent}`, input: task, output: answer, threadId: input.threadId })
      traces.push({ tool: 'delegate', input: { agent, task }, output: answer.slice(0, 500) })
      return { agent: AGENT_LABELS[agent].name, answer }
    })
  }
}

let runtime: AgentRuntime | undefined
export function agentRuntime(): AgentRuntime {
  runtime ??= new LlmAgentRuntime()
  return runtime
}
export function setAgentRuntime(r: AgentRuntime) {
  runtime = r
}

/** Enforce a wall-clock timeout on a stream; on timeout abort and emit RUN_ERROR instead of hanging. */
export async function* withTimeout(stream: AsyncIterable<StreamChunk>, ms: number, abort: AbortController): AsyncIterable<StreamChunk> {
  const timer = setTimeout(() => abort.abort(new Error('agent timeout')), ms)
  let errored = false
  try {
    for await (const chunk of stream) {
      if (chunk.type === EventType.RUN_ERROR) errored = true
      yield chunk
    }
    if (abort.signal.aborted && !errored) {
      const message = `Agent timed out after ${Math.round(ms / 1000)}s.`
      yield { type: EventType.RUN_ERROR, message, timestamp: Date.now(), error: { message } } as unknown as StreamChunk
    }
  } catch (err) {
    const message = abort.signal.aborted ? `Agent timed out after ${Math.round(ms / 1000)}s.` : err instanceof Error ? err.message : String(err)
    yield { type: EventType.RUN_ERROR, message, timestamp: Date.now(), error: { message } } as unknown as StreamChunk
  } finally {
    clearTimeout(timer)
  }
}

export const agentTimeoutMs = () => env().AGENT_TIMEOUT_MS
