import { and, asc, desc, eq, lt } from 'drizzle-orm'
import { getDb } from '../db/client'
import { chatMessages, chatThreads, messageFeedback } from '../db/schema'
import { appendMemory } from '../agents/memory'
import { prepareModelMessages } from '../agents/egress'
import { writeAudit } from '../audit'
import { isAgentKey, type AgentSelection } from '../../shared/agents'

export class ThreadNotFoundError extends Error {}

/**
 * Every thread query filters by org AND user (#26): only the person who started a thread can open
 * it here. The organisation can still see each question in the decision log and each reply in the
 * run replay (#213, kept visible by the owner's decision).
 */
export async function listThreads(orgId: string, userId: string) {
  return getDb()
    .select({ id: chatThreads.id, title: chatThreads.title, agentKey: chatThreads.agentKey, updatedAt: chatThreads.updatedAt })
    .from(chatThreads)
    .where(and(eq(chatThreads.orgId, orgId), eq(chatThreads.userId, userId)))
    .orderBy(desc(chatThreads.updatedAt))
    .limit(100)
}

export async function createThread(orgId: string, userId: string, agentKey: AgentSelection = 'lead') {
  const [row] = await getDb().insert(chatThreads).values({ orgId, userId, agentKey }).returning()
  return row!
}

export async function getThread(orgId: string, userId: string, threadId: string) {
  const [row] = await getDb()
    .select()
    .from(chatThreads)
    .where(and(eq(chatThreads.id, threadId), eq(chatThreads.orgId, orgId), eq(chatThreads.userId, userId)))
    .limit(1)
  return row ?? null
}

export async function requireThread(orgId: string, userId: string, threadId: string) {
  const t = await getThread(orgId, userId, threadId)
  if (!t) throw new ThreadNotFoundError('Thread not found.')
  return t
}

/** Last N messages, oldest first. */
export async function listMessages(orgId: string, userId: string, threadId: string, limit = 100) {
  await requireThread(orgId, userId, threadId)
  const rows = await getDb()
    .select()
    .from(chatMessages)
    .where(and(eq(chatMessages.threadId, threadId), eq(chatMessages.orgId, orgId)))
    .orderBy(desc(chatMessages.createdAt))
    .limit(Math.min(limit, 500))
  return rows.reverse()
}

/**
 * One page of a thread, oldest first, with `hasMore` when older messages exist (#171).
 * `before` is the createdAt of the oldest message already shown.
 */
export async function listMessagesPage(orgId: string, userId: string, threadId: string, opts: { limit?: number; before?: Date } = {}) {
  await requireThread(orgId, userId, threadId)
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500)
  const conds = [eq(chatMessages.threadId, threadId), eq(chatMessages.orgId, orgId)]
  if (opts.before) conds.push(lt(chatMessages.createdAt, opts.before))
  const rows = await getDb()
    .select()
    .from(chatMessages)
    .where(and(...conds))
    .orderBy(desc(chatMessages.createdAt))
    .limit(limit + 1)
  const hasMore = rows.length > limit
  return { messages: rows.slice(0, limit).reverse(), hasMore }
}

/** Remove one message from a thread (a failed reply that a retry replaces). Scoped to the org and thread. */
export async function deleteMessage(orgId: string, threadId: string, messageId: string) {
  await getDb()
    .delete(chatMessages)
    .where(and(eq(chatMessages.id, messageId), eq(chatMessages.threadId, threadId), eq(chatMessages.orgId, orgId)))
}

export async function appendMessage(
  orgId: string,
  threadId: string,
  msg: { role: 'user' | 'assistant'; content: string; agentKey?: string | null; metadata?: Record<string, unknown> },
) {
  const [row] = await getDb()
    .insert(chatMessages)
    .values({ orgId, threadId, role: msg.role, content: msg.content, agentKey: msg.agentKey ?? null, metadata: msg.metadata ?? {} })
    .returning()
  return row!
}

/** Persist the selected agent on the thread; auto-title from the first user message. */
export async function touchThread(threadId: string, opts: { agentKey?: AgentSelection; firstUserMessage?: string }) {
  const set: Partial<typeof chatThreads.$inferInsert> = { updatedAt: new Date() }
  if (opts.agentKey) set.agentKey = opts.agentKey
  if (opts.firstUserMessage) set.title = opts.firstUserMessage.replace(/\s+/g, ' ').trim().slice(0, 60) || 'New thread'
  await getDb().update(chatThreads).set(set).where(eq(chatThreads.id, threadId))
}

export async function deleteThread(orgId: string, userId: string, threadId: string) {
  await requireThread(orgId, userId, threadId)
  await getDb().delete(chatThreads).where(and(eq(chatThreads.id, threadId), eq(chatThreads.orgId, orgId), eq(chatThreads.userId, userId)))
}

export async function threadMessagesForModel(orgId: string, userId: string, threadId: string, limit = 40) {
  const msgs = await listMessages(orgId, userId, threadId, limit)
  const raw = msgs.filter((m) => m.role === 'user' || m.role === 'assistant').map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))
  return prepareModelMessages(raw)
}

/** Feedback (#35): store rating, append a structured memory entry for the agent, audit it. */
export async function submitFeedback(orgId: string, userId: string, messageId: string, rating: 'useful' | 'wrong' | 'escalate', rationale?: string) {
  const db = getDb()
  const [msg] = await db
    .select({ id: chatMessages.id, threadId: chatMessages.threadId, agentKey: chatMessages.agentKey, content: chatMessages.content })
    .from(chatMessages)
    .innerJoin(chatThreads, eq(chatThreads.id, chatMessages.threadId))
    .where(and(eq(chatMessages.id, messageId), eq(chatMessages.orgId, orgId), eq(chatThreads.userId, userId), eq(chatMessages.role, 'assistant')))
    .limit(1)
  if (!msg) throw new ThreadNotFoundError('Message not found.')
  await db
    .insert(messageFeedback)
    .values({ orgId, messageId, userId, rating, rationale: rationale?.trim() || null })
    .onConflictDoUpdate({ target: [messageFeedback.messageId, messageFeedback.userId], set: { rating, rationale: rationale?.trim() || null, createdAt: new Date() } })
  const agentKey = isAgentKey(msg.agentKey) ? msg.agentKey : 'lead'
  const excerpt = msg.content.replace(/\s+/g, ' ').slice(0, 160)
  const entry = await appendMemory({
    orgId,
    agentKey,
    kind: 'feedback',
    body: `Analyst marked an answer "${rating}"${rationale ? `: ${rationale.trim().slice(0, 300)}` : ''} (answer: "${excerpt}")`,
    sourceType: 'message',
    sourceId: messageId,
    authorId: userId,
  })
  await writeAudit({ category: 'memory', action: 'feedback', actorType: 'user', actorId: userId, orgId, targetType: 'chat_message', targetId: messageId, data: { rating, memoryEntryId: entry.id } })
  return { rating, memoryEntryId: entry.id }
}

export async function feedbackForThread(orgId: string, userId: string, threadId: string) {
  return getDb()
    .select({ messageId: messageFeedback.messageId, rating: messageFeedback.rating })
    .from(messageFeedback)
    .innerJoin(chatMessages, eq(chatMessages.id, messageFeedback.messageId))
    .where(and(eq(messageFeedback.orgId, orgId), eq(messageFeedback.userId, userId), eq(chatMessages.threadId, threadId)))
    .orderBy(asc(messageFeedback.createdAt))
}
