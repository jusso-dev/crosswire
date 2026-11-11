import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { authed } from './middleware'
import { createThread, deleteThread, feedbackForThread, getThread, listMessagesPage, listThreads, submitFeedback } from '../server/chat/threads'
import { toAgentSelection } from '../shared/agents'
import { asJson } from '../shared/json'

export const fetchThreads = createServerFn({ method: 'GET' })
  .middleware([authed])
  .handler(async ({ context }) => {
    const rows = await listThreads(context.session.org.id, context.session.user.id)
    const { modelConfigured, modelDescription } = await import('../server/agents/model')
    return {
      threads: rows.map((r) => ({ ...r, updatedAt: r.updatedAt.toISOString() })),
      // Non-secret status for the UI: whether chat can run, and which model it uses.
      runtime: { configured: modelConfigured(), ...modelDescription(), isOwner: context.session.org.role === 'owner' },
    }
  })

export const newThread = createServerFn({ method: 'POST' })
  .middleware([authed])
  .validator(z.object({ agentKey: z.string().optional() }))
  .handler(async ({ context, data }) => {
    const t = await createThread(context.session.org.id, context.session.user.id, toAgentSelection(data.agentKey))
    return { id: t.id }
  })

/** Messages shown per page of a thread. Older ones load on request ("Load older"). */
export const THREAD_PAGE = 200

type MessageRow = Awaited<ReturnType<typeof listMessagesPage>>['messages'][number]
const presentMessage = (m: MessageRow) => ({ id: m.id, role: m.role, content: m.content, agentKey: m.agentKey, metadata: asJson(m.metadata), createdAt: m.createdAt.toISOString() })

export const fetchThread = createServerFn({ method: 'GET' })
  .middleware([authed])
  .validator(z.object({ threadId: z.string().min(1) }))
  .handler(async ({ context, data }) => {
    const { org, user } = context.session
    const thread = await getThread(org.id, user.id, data.threadId)
    if (!thread) return null
    const [page, feedback] = await Promise.all([listMessagesPage(org.id, user.id, data.threadId, { limit: THREAD_PAGE }), feedbackForThread(org.id, user.id, data.threadId)])
    return {
      thread: { id: thread.id, title: thread.title, agentKey: thread.agentKey },
      messages: page.messages.map(presentMessage),
      hasMore: page.hasMore,
      feedback: Object.fromEntries(feedback.map((f) => [f.messageId, f.rating])),
    }
  })

/** The page of messages before `before` (the oldest one shown), for "Load older" (#171). */
export const fetchOlderMessages = createServerFn({ method: 'GET' })
  .middleware([authed])
  .validator(z.object({ threadId: z.string().min(1), before: z.iso.datetime() }))
  .handler(async ({ context, data }) => {
    const { org, user } = context.session
    const page = await listMessagesPage(org.id, user.id, data.threadId, { limit: THREAD_PAGE, before: new Date(data.before) })
    return { messages: page.messages.map(presentMessage), hasMore: page.hasMore }
  })

export const removeThread = createServerFn({ method: 'POST' })
  .middleware([authed])
  .validator(z.object({ threadId: z.string().min(1) }))
  .handler(async ({ context, data }) => {
    await deleteThread(context.session.org.id, context.session.user.id, data.threadId)
    return { ok: true }
  })

export const sendFeedback = createServerFn({ method: 'POST' })
  .middleware([authed])
  .validator(z.object({ messageId: z.string().min(1), rating: z.enum(['useful', 'wrong', 'escalate']), rationale: z.string().max(500).optional() }))
  .handler(async ({ context, data }) => submitFeedback(context.session.org.id, context.session.user.id, data.messageId, data.rating, data.rationale))
