import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { authed } from './middleware'
import { createThread, deleteThread, feedbackForThread, getThread, listMessages, listThreads, submitFeedback } from '../server/chat/threads'
import { toAgentSelection } from '../shared/agents'
import { asJson } from '../shared/json'

export const fetchThreads = createServerFn({ method: 'GET' })
  .middleware([authed])
  .handler(async ({ context }) => {
    const rows = await listThreads(context.session.org.id, context.session.user.id)
    return rows.map((r) => ({ ...r, updatedAt: r.updatedAt.toISOString() }))
  })

export const newThread = createServerFn({ method: 'POST' })
  .middleware([authed])
  .validator(z.object({ agentKey: z.string().optional() }))
  .handler(async ({ context, data }) => {
    const t = await createThread(context.session.org.id, context.session.user.id, toAgentSelection(data.agentKey))
    return { id: t.id }
  })

export const fetchThread = createServerFn({ method: 'GET' })
  .middleware([authed])
  .validator(z.object({ threadId: z.string().min(1) }))
  .handler(async ({ context, data }) => {
    const { org, user } = context.session
    const thread = await getThread(org.id, user.id, data.threadId)
    if (!thread) return null
    const [messages, feedback] = await Promise.all([listMessages(org.id, user.id, data.threadId, 200), feedbackForThread(org.id, user.id, data.threadId)])
    return {
      thread: { id: thread.id, title: thread.title, agentKey: thread.agentKey },
      messages: messages.map((m) => ({ id: m.id, role: m.role, content: m.content, agentKey: m.agentKey, metadata: asJson(m.metadata), createdAt: m.createdAt.toISOString() })),
      feedback: Object.fromEntries(feedback.map((f) => [f.messageId, f.rating])),
    }
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
