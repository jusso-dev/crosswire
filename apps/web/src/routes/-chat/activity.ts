import type { UIMessage } from '@tanstack/ai-react'
import { agentName, textOf } from './messages'

/** Plain words for a finished tool step. */
export const TOOL_LABEL: Record<string, string> = {
  memory_search: 'Searched memory',
  remember: 'Saved to memory',
  search_intel: 'Searched threat intel',
  compare_cve: 'Compared sources',
  list_watch_hits: 'Read watch hits',
  get_hunt: 'Read a hunt',
  propose_kql: 'Proposed a search',
  list_sentinel_incidents: 'Read Sentinel incidents',
  propose_response: 'Proposed an action',
  delegate: 'Asked a specialist',
  delegate_parallel: 'Asked specialists',
}

/** Plain words for a tool step still running. */
export const PENDING_LABEL: Record<string, string> = {
  memory_search: 'Searching memory',
  remember: 'Saving to memory',
  search_intel: 'Searching threat intel',
  compare_cve: 'Comparing sources',
  list_watch_hits: 'Reading watch hits',
  get_hunt: 'Reading a hunt',
  propose_kql: 'Proposing a search',
  list_sentinel_incidents: 'Reading Sentinel incidents',
  propose_response: 'Proposing an action',
  delegate: 'Asking a specialist',
  delegate_parallel: 'Asking specialists',
}

/** Specialists named in a delegate or delegate_parallel call, for "Asked Hunter and Intel". */
export function delegatesOf(name: string, args: unknown): string[] {
  try {
    const v = (typeof args === 'string' ? JSON.parse(args) : args) as { agent?: string; tasks?: Array<{ agent?: string }> } | undefined
    if (name === 'delegate' && v?.agent) return [agentName(v.agent)]
    if (name === 'delegate_parallel' && Array.isArray(v?.tasks)) return v.tasks.map((t) => agentName(t.agent))
  } catch {
    // Arguments still streaming.
  }
  return []
}

export function joinNames(names: string[]) {
  if (names.length <= 1) return names.join('')
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
}

/** Plain words for what the streaming reply is doing now (newest tool call, or writing). */
export function currentActivity(m: UIMessage | undefined): string | null {
  if (!m || m.role !== 'assistant') return null
  const calls = m.parts.filter((p) => p.type === 'tool-call') as Array<{ id: string; name: string; state: string; output?: unknown; arguments?: string; input?: unknown }>
  const results = new Set((m.parts.filter((p) => p.type === 'tool-result') as Array<{ toolCallId: string }>).map((r) => r.toolCallId))
  const open = [...calls].reverse().find((c) => !results.has(c.id) && c.output === undefined && c.state !== 'complete' && c.state !== 'error')
  if (open) {
    const asked = delegatesOf(open.name, open.input ?? open.arguments)
    const base = PENDING_LABEL[open.name] ?? `Running ${open.name}`
    return asked.length ? `${base}: ${joinNames(asked)}` : base
  }
  return textOf(m) ? 'Writing the answer' : calls.length ? 'Reading the results' : null
}
