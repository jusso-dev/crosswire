/** Canonical agent keys (#27). Shared by client and server. Do not add agents without a charter. */
export const AGENT_KEYS = ['lead', 'hunter', 'intel', 'responder', 'scribe'] as const
export type AgentKey = (typeof AGENT_KEYS)[number]

/** Selector value for "Lead (orchestrate squad)": Lead runs with the `delegate` tool. */
export const ORCHESTRATE_KEY = 'lead-orchestrate' as const
export type AgentSelection = AgentKey | typeof ORCHESTRATE_KEY

export const AGENT_LABELS: Record<AgentKey, { name: string; role: string }> = {
  lead: { name: 'Lead', role: 'Scopes hunts, routes work, signs off recommendations' },
  hunter: { name: 'Hunter', role: 'Defender XDR Advanced Hunting and Sentinel queries (read-only)' },
  intel: { name: 'Intel', role: 'Watchlists, pwn.watch and CVE sources, cross-source compare' },
  responder: { name: 'Responder', role: 'Drafts gated response proposals; never executes' },
  scribe: { name: 'Scribe', role: 'Compresses outcomes and feedback into org memory' },
}

export function isAgentKey(value: unknown): value is AgentKey {
  return typeof value === 'string' && (AGENT_KEYS as readonly string[]).includes(value)
}

export function toAgentSelection(value: unknown): AgentSelection {
  if (value === ORCHESTRATE_KEY) return ORCHESTRATE_KEY
  return isAgentKey(value) ? value : 'lead'
}

export function selectionAgent(selection: AgentSelection): AgentKey {
  return selection === ORCHESTRATE_KEY ? 'lead' : selection
}
