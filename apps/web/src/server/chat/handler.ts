import { EventType, chatParamsFromRequestBody, toServerSentEventsResponse, type StreamChunk } from '@tanstack/ai'
import { toAgentSelection, selectionAgent, type AgentSelection } from '../../shared/agents'
import { requireApiSession, HttpError } from '../auth/session'
import { agentRuntime, agentTimeoutMs, cancelAgentRun, withTimeout, type AgentRunHandle } from '../agents/runtime'
import { finishRun, recordRunOutput } from '../agents/runs'
import { appendMessage, deleteMessage, listMessages, requireThread, threadMessagesForModel, touchThread, ThreadNotFoundError } from './threads'
import { createRelay, customEvent, isTerminal, RUN_EVENT, SAVED_EVENT } from './relay'
import { asJson } from '../../shared/json'
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
 * The run is detached from the request: a client disconnect never stops it (#128).
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

  await recordUserTurn(org.id, user.id, threadId, text, selection)
  const history = await threadMessagesForModel(org.id, user.id, threadId)

  // The run has its own abort controller. It is never tied to the request (#128): leaving the page,
  // switching thread or following "Watch the steps" ends the stream to that browser only. The run
  // finishes on the server and saves its reply. Stop (cancelRunFn, then cancel_requested_at) is the
  // only way a person ends a run early; the timeout and budget guards still bound it.
  const abortController = new AbortController()
  const relay = createRelay()
  const active = await agentRuntime().run({ orgId: org.id, userId: user.id, selection, threadId, messages: history, abortController })
  const onDisconnect = () => {
    relay.detach()
    // Without a run row (RUN_LEDGER=legacy) nothing else can stop the run, so a disconnect still does.
    if (!active.runId) abortController.abort()
  }
  if (request.signal.aborted) onDisconnect()
  else request.signal.addEventListener('abort', onDisconnect, { once: true })

  void driveRun({ orgId: org.id, threadId, selection, active, abortController, relay }).catch((err) => {
    logger.error('agent run task failed', { threadId, error: err instanceof Error ? err.message : String(err) })
  })

  // The response only reads the relay. Cancelling it (client gone) detaches; it never aborts the run.
  return toServerSentEventsResponse(relay.iterable)
}

/**
 * Save the analyst's message. A resend of a question whose last attempt failed ("Try again", or the
 * same words typed again) replaces the failed attempt, so the thread never holds the question twice
 * and the model history still ends with the question.
 */
async function recordUserTurn(orgId: string, userId: string, threadId: string, text: string, selection: AgentSelection) {
  const recent = await listMessages(orgId, userId, threadId, 2)
  const last = recent.at(-1)
  const before = recent.at(-2)
  const lastFailed = last?.role === 'assistant' && Boolean(asJson(last.metadata).error)
  if (lastFailed && before?.role === 'user' && before.content === text) {
    await deleteMessage(orgId, threadId, last!.id)
    await touchThread(threadId, { agentKey: selection })
    return
  }
  if (last?.role === 'user' && last.content === text) {
    await touchThread(threadId, { agentKey: selection })
    return
  }
  await appendMessage(orgId, threadId, { role: 'user', content: text, agentKey: selection })
  await touchThread(threadId, { agentKey: selection, firstUserMessage: recent.length === 0 ? text : undefined })
}

/**
 * Drain the agent stream to its end on the server, whether or not anyone is watching. Chunks go to
 * the relay while the client is connected. Terminal events are held back until the reply is saved,
 * so the browser receives the stored message id before the stream ends (#169).
 * The run is finished, its slot released and its reply saved exactly once, in the finally block.
 */
export async function driveRun(input: { orgId: string; threadId: string; selection: AgentSelection; active: AgentRunHandle; abortController: AbortController; relay: ReturnType<typeof createRelay> }) {
  const { orgId, threadId, selection, active, abortController, relay } = input
  const agentKey = selectionAgent(selection)
  let reply = ''
  let error: string | null = null
  // First event: the run id, so the page can offer Stop and "Watch the steps" straight away.
  // Null without a run row (RUN_LEDGER=legacy); the page then stops by closing the stream.
  relay.push(customEvent(RUN_EVENT, { runId: active.runId ?? null, agentKey }))
  const held: StreamChunk[] = []
  try {
    for await (const chunk of withTimeout(active.stream, agentTimeoutMs(), abortController)) {
      if (chunk.type === EventType.TEXT_MESSAGE_CONTENT && 'delta' in chunk && typeof chunk.delta === 'string') reply += chunk.delta
      if (chunk.type === EventType.RUN_ERROR) error = (chunk as { message?: string }).message ?? 'Agent error'
      if (isTerminal(chunk)) {
        held.push(chunk)
        continue
      }
      for (const h of held.splice(0)) relay.push(h)
      relay.push(chunk)
    }
  } catch (err) {
    error ??= err instanceof Error ? err.message : String(err)
  } finally {
    const interrupted = abortController.signal.aborted
    if (active.runId) {
      try {
        if (interrupted) await cancelAgentRun(orgId, active.runId)
        if (reply) await recordRunOutput(active.runId, orgId, 'assistant', reply)
        const status = interrupted ? 'interrupted' : error ? 'failed' : 'completed'
        await finishRun(orgId, active.runId, status, error)
      } catch (err) {
        logger.error('failed to finish agent run', { threadId, error: err instanceof Error ? err.message : String(err) })
      }
    }
    try {
      await active.release?.()
    } catch (err) {
      logger.error('failed to release agent run slot', { threadId, error: err instanceof Error ? err.message : String(err) })
    }
    const content = reply || (error ? `⚠️ ${error}` : '(no response)')
    const tools = active.traces.map((t) => ({ tool: t.tool, error: t.error ?? null }))
    try {
      const saved = await appendMessage(orgId, threadId, {
        role: 'assistant',
        content,
        agentKey: selection,
        metadata: { agent: agentKey, selection, runId: active.runId ?? null, tools, error },
      })
      relay.push(customEvent(SAVED_EVENT, { messageId: saved.id, runId: active.runId ?? null, tools, error }))
    } catch (err) {
      logger.error('failed to persist assistant message', { threadId, error: err instanceof Error ? err.message : String(err) })
    }
    for (const h of held.splice(0)) relay.push(h)
    relay.end()
  }
}
