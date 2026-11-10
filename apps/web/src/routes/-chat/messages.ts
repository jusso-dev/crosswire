import type { UIMessage } from '@tanstack/ai-react'
import { AGENT_LABELS, ORCHESTRATE_KEY } from '../../shared/agents'

/**
 * Pure helpers for the conversation page (#169, #171, #176). No React, so tests can call them.
 */

export type StoredMessage = { id: string; role: string; content: string; agentKey: string | null; metadata: unknown; createdAt: string }
export type ToolTrace = { tool: string; error: string | null }
export type Meta = { agentKey?: string | null; persistedId?: string; crosswire?: { tools?: ToolTrace[]; error?: string | null; runId?: string | null } }

/** What the server sends once the reply is stored (the `crosswire:saved` stream event). */
export type SavedReply = { messageId: string; runId: string | null; tools: ToolTrace[]; error: string | null }

/** Custom stream event names. Kept in step with `server/chat/relay.ts`. */
export const RUN_EVENT = 'crosswire:run'
export const SAVED_EVENT = 'crosswire:saved'

export function toUiMessages(messages: StoredMessage[]): UIMessage[] {
  return messages.map((m) => ({
    id: m.id,
    role: m.role === 'user' ? 'user' : 'assistant',
    parts: [{ type: 'text', content: m.content }],
    createdAt: new Date(m.createdAt),
    metadata: { agentKey: m.agentKey, persistedId: m.id, crosswire: m.metadata as Meta['crosswire'] },
  }))
}

export function textOf(m: UIMessage) {
  return m.parts
    .filter((p) => p.type === 'text')
    .map((p) => (p as { content: string }).content)
    .join('')
}

export function agentName(key: string | null | undefined) {
  if (key === ORCHESTRATE_KEY) return 'Lead (team)'
  return key && key in AGENT_LABELS ? AGENT_LABELS[key as keyof typeof AGENT_LABELS].name : 'Lead'
}

export function isSavedReply(v: unknown): v is SavedReply {
  return typeof v === 'object' && v !== null && typeof (v as { messageId?: unknown }).messageId === 'string'
}

/**
 * The reply a `crosswire:saved` event belongs to: the last assistant message after the last
 * question. Null when the stream failed before any reply appeared.
 */
export function savedTargetId(messages: readonly UIMessage[]) {
  const i = messages.findLastIndex((m) => m.role === 'assistant')
  const lastUser = messages.findLastIndex((m) => m.role === 'user')
  return i < 0 || i < lastUser ? null : messages[i]!.id
}

/**
 * A reply's metadata with the stored id (for feedback), run link and tool steps from the server.
 * Merged at render time, so the message keeps its client id and nothing remounts (#169).
 */
export function withSaved(meta: Meta, saved: SavedReply | undefined, agentKey: string): Meta {
  if (!saved) return meta
  return { ...meta, agentKey: meta.agentKey ?? agentKey, persistedId: saved.messageId, crosswire: { tools: saved.tools, error: saved.error, runId: saved.runId } }
}

/** Older messages go in front. A message already shown (same stored id) is not repeated (#171). */
export function prependOlder(older: readonly UIMessage[], current: readonly UIMessage[]): UIMessage[] {
  const shown = new Set(current.map((m) => (m.metadata as Meta | undefined)?.persistedId ?? m.id))
  return [...older.filter((m) => !shown.has((m.metadata as Meta | undefined)?.persistedId ?? m.id)), ...current]
}

/** The oldest stored message's time, the cursor for "Load older". */
export function oldestStoredAt(messages: readonly UIMessage[]) {
  const first = messages.find((m) => (m.metadata as Meta | undefined)?.persistedId && m.createdAt)
  return first?.createdAt ? new Date(first.createdAt).toISOString() : null
}

/** Stored messages that arrived after the ones shown (a reply that finished while away), appended once. */
export function appendNewer(current: readonly UIMessage[], fresh: readonly UIMessage[]): UIMessage[] {
  const shown = new Set(current.map((m) => (m.metadata as Meta | undefined)?.persistedId ?? m.id))
  return [...current, ...fresh.filter((m) => !shown.has((m.metadata as Meta | undefined)?.persistedId ?? m.id))]
}
