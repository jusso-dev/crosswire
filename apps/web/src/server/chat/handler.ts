import { EventType, chatParamsFromRequestBody, toServerSentEventsResponse, type StreamChunk } from '@tanstack/ai'
import { toAgentSelection, selectionAgent, type AgentSelection } from '../../shared/agents'
import { requireApiSession, HttpError } from '../auth/session'
import { agentRuntime, agentTimeoutMs, cancelAgentRun, withTimeout, type AgentRunHandle } from '../agents/runtime'
import { finishRun, recordRunOutput } from '../agents/runs'
import { appendMessage, listMessages, requireThread, threadMessagesForModel, touchThread, ThreadNotFoundError } from './threads'
import { logger } from '../lib/logger'

/** Extract plain text from the last user UIMessage in an AG-UI RunAgentInput. */
export function lastUserText(messages: Array<Record<string, unknown>>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role !== 'user') continue
    if (Array.isArray(m.parts)) {
      const text = (m.parts as Array<{ type?: string; content?: string }>)
        .filter((p) => p.type === 'text')
        .map((p) => p.content ?? '')
        .join('')
      if (text) return text
    }
    if (typeof m.content === 'string') return m.content
  }
  return ''
}

/**
 * POST /api/chat (#25, #26, #27, #32). Follows the TanStack AI basic-chat recipe: AG-UI RunAgentInput in,
 * SSE out. The server is authoritative for history: it loads the thread from Postgres (org + user scoped),
 * appends the new user message, streams the agent, and persists the assistant reply on completion.
 * Only `agentKey` is read from forwardedProps (allowlisted); model, adapter and tools are server-chosen.
 */
export async function handleChat(request: Request): Promise<Response> {
  let session
  try {
    session = await requireApiSession(request)
  } catch (err) {
    if (err instanceof HttpError) return Response.json({ error: err.message }, { status: err.status })
    throw err
  }
  let params
  try {
    params = await chatParamsFromRequestBody(await request.json())
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : 'Bad request' }, { status: 400 })
  }
  const threadId = params.threadId
  const forwarded = (params.forwardedProps ?? {}) as Record<string, unknown>
  const selection: AgentSelection = toAgentSelection(forwarded.agentKey)
  const text = lastUserText(params.messages as unknown as Array<Record<string, unknown>>).trim()
  if (!text) return Response.json({ error: 'Empty message' }, { status: 400 })
  if (text.length > 20_000) return Response.json({ error: 'Message too long (20k characters max)' }, { status: 413 })

  const { org, user } = session
  try {
    await requireThread(org.id, user.id, threadId)
  } catch (err) {
    if (err instanceof ThreadNotFoundError) return Response.json({ error: 'Thread not found' }, { status: 404 })
    throw err
  }

  const prior = await listMessages(org.id, user.id, threadId, 1)
  await appendMessage(org.id, threadId, { role: 'user', content: text, agentKey: selection })
  await touchThread(threadId, { agentKey: selection, firstUserMessage: prior.length === 0 ? text : undefined })
  const history = await threadMessagesForModel(org.id, user.id, threadId)

  const abortController = new AbortController()
  let handle: AgentRunHandle | undefined
  request.signal.addEventListener('abort', () => {
    abortController.abort()
    if (handle?.runId) void cancelAgentRun(org.id, handle.runId)
    void handle?.release?.()
  })
  handle = await agentRuntime().run({ orgId: org.id, userId: user.id, selection, threadId, messages: history, abortController })
  if (request.signal.aborted) {
    abortController.abort()
    if (handle.runId) await cancelAgentRun(org.id, handle.runId)
    await handle.release?.()
  }
  const active = handle
  const agentKey = selectionAgent(selection)

  async function* persisted(): AsyncIterable<StreamChunk> {
    let reply = ''
    let error: string | null = null
    let interrupted = false
    try {
      for await (const chunk of withTimeout(active.stream, agentTimeoutMs(), abortController)) {
        if (chunk.type === EventType.TEXT_MESSAGE_CONTENT && 'delta' in chunk && typeof chunk.delta === 'string') reply += chunk.delta
        if (chunk.type === EventType.RUN_ERROR) error = (chunk as { message?: string }).message ?? 'Agent error'
        yield chunk
      }
    } finally {
      interrupted = abortController.signal.aborted
      if (active.runId) {
        try {
          if (interrupted) await cancelAgentRun(org.id, active.runId)
          if (reply) await recordRunOutput(active.runId, org.id, 'assistant', reply)
          const status = interrupted ? 'interrupted' : error ? 'failed' : 'completed'
          await finishRun(org.id, active.runId, status, error)
        } catch (err) {
          logger.error('failed to finish agent run', { threadId, error: err instanceof Error ? err.message : String(err) })
        }
      }
      await active.release?.()
    }
    const content = reply || (error ? `⚠️ ${error}` : '(no response)')
    try {
      await appendMessage(org.id, threadId, {
        role: 'assistant',
        content,
        agentKey: selection,
        metadata: { agent: agentKey, selection, runId: active.runId ?? null, tools: active.traces.map((t) => ({ tool: t.tool, error: t.error ?? null })), error },
      })
    } catch (err) {
      logger.error('failed to persist assistant message', { threadId, error: err instanceof Error ? err.message : String(err) })
    }
  }

  return toServerSentEventsResponse(persisted(), { abortController })
}
