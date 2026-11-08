import type { AgentKey } from '../../shared/agents'
import { AGENT_KEYS, AGENT_LABELS } from '../../shared/agents'
import { canonicalJson, sha256 } from './canonical'
import { loadCharters } from './charters'
import { REVIEWED_SKILLS, reviewedSkillDefinitions } from './skills'
import { buildSquadConfig, type SquadSDKConfig } from './squad-sdk'

/**
 * One policy source. team.md and routing.md are generated views of this module.
 * The chat path does not parse those files. The analyst's selection still chooses the agent.
 * These rules are the reviewed map, checked by defineRouting, not a hidden router.
 */
export const AGENT_TOOLS: Record<AgentKey, string[]> = {
  lead: ['memory_search', 'search_intel', 'list_watch_hits', 'get_hunt', 'propose_response'],
  hunter: ['memory_search', 'get_hunt', 'propose_kql', 'list_sentinel_incidents'],
  intel: ['memory_search', 'search_intel', 'compare_cve', 'list_watch_hits'],
  responder: ['memory_search', 'get_hunt', 'propose_response'],
  scribe: ['memory_search', 'remember'],
}

export const ROUTING_RULES = [
  { pattern: 'cve|watch|vendor|intel', agents: ['intel'] as const, description: 'CVE, watch hits, feeds, and source comparison go to Intel.' },
  { pattern: 'kql|hunting|sentinel', agents: ['hunter'] as const, description: 'KQL, Advanced Hunting, and Sentinel incidents go to Hunter.' },
  { pattern: 'contain|isolate|disable|playbook', agents: ['responder'] as const, description: 'Containment asks Responder for a proposal only.' },
  { pattern: 'remember|summarise|feedback', agents: ['scribe'] as const, description: 'Notes, summaries, and feedback go to Scribe.' },
] as const

export class PolicyError extends Error {}

export function assertSkillTools(agent: AgentKey, tools: readonly string[]) {
  const allowed = new Set(AGENT_TOOLS[agent])
  for (const name of tools) {
    if (!allowed.has(name)) throw new PolicyError(`Skill tool ${name} is not in the ${agent} allowlist.`)
  }
}

export interface LoadedPolicy {
  squad: SquadSDKConfig
  sha256: string
  charterSha256: Record<AgentKey, string>
  toolsetSha256: Record<AgentKey, string>
  charters: Record<AgentKey, string>
}

export function loadPolicy(): LoadedPolicy {
  const charters = loadCharters()
  const skills = reviewedSkillDefinitions()
  for (const skill of skills) {
    assertSkillTools(skill.agent, skill.tools)
    for (const tool of skill.definition.tools ?? []) assertSkillTools(skill.agent, [tool.name])
  }
  const squad = buildSquadConfig({
    team: {
      name: 'Crosswire',
      description: 'Security analysts lead. Agents propose. People approve.',
      members: [...AGENT_KEYS],
    },
    agents: AGENT_KEYS.map((key) => ({
      name: key,
      role: AGENT_LABELS[key].role,
      charter: charters[key],
      tools: AGENT_TOOLS[key],
      status: 'active' as const,
    })),
    routing: {
      rules: ROUTING_RULES.map((rule) => ({ pattern: rule.pattern, agents: [...rule.agents], tier: 'standard' as const, description: rule.description })),
      defaultAgent: 'lead',
      fallback: 'ask' as const,
    },
    skills: skills.map((skill) => skill.definition),
    budget: { perAgentSpawn: 28_000, perSession: 200_000, warnAt: 0.8 },
  })
  const charterSha256 = Object.fromEntries(AGENT_KEYS.map((key) => [key, sha256(charters[key])])) as Record<AgentKey, string>
  const toolsetSha256 = Object.fromEntries(AGENT_KEYS.map((key) => [key, sha256(AGENT_TOOLS[key].join('\n'))])) as Record<AgentKey, string>
  return { squad, sha256: sha256(canonicalJson(squad)), charterSha256, toolsetSha256, charters }
}

export function renderTeamMarkdown(): string {
  const policy = loadPolicy()
  const rows = AGENT_KEYS.map((key) => {
    const label = AGENT_LABELS[key].name
    return `| ${label} | \`${key}\` | ${AGENT_LABELS[key].role} | ${AGENT_TOOLS[key].join(', ')} | [agents/${key}/charter.md](agents/${key}/charter.md) |`
  })
  return `# Crosswire security cast

Generated view of the typed squad registry in \`apps/web/src/server/agents/policy.ts\`. The server does not parse this file. Missing or invalid charters fail closed in the charter loader. Policy sha256 \`${policy.sha256}\`.

| Agent | Key | Role | Tools | Charter |
| --- | --- | --- | --- | --- |
${rows.join('\n')}

## Team-wide rules

- Humans lead. Agents propose; people approve.
- Never execute containment or any tenant-changing action without an approved proposal.
- No agent has an execute tool. Execution only happens from the approval inbox, with a separate credential.
- Never write secrets, tokens, or credentials into memory, decisions, or chat.
- Cite sources for every intel claim.
- GitHub Copilot custom-agent files under \`.github/agents/\` may mirror these rules. The product runtime does not require a Copilot seat.
`
}

export function renderRoutingMarkdown(): string {
  const rows = ROUTING_RULES.map((rule) => `| ${rule.description} | ${rule.agents.join(', ')} | \`${rule.pattern}\` |`)
  return `# Routing

Generated view of \`ROUTING_RULES\` in \`apps/web/src/server/agents/policy.ts\`. The server does not parse this file. The analyst's agent selection chooses who answers. \`defineRouting\` validates this map; it does not steer a live turn by itself.

| Request looks like | Route to | Pattern checked by defineRouting |
| --- | --- | --- |
${rows.join('\n')}
| Anything broad, multi-step, or unclear | Lead | default agent |

## Fan-out

When the analyst picks **Lead (orchestrate squad)**, Lead plans the work and calls the specialists, then signs off a combined answer. Independent questions go out together with \`delegate_parallel\` (up to 4 distinct specialists, run concurrently; one failure does not drop the others). Dependent steps use \`delegate\` in sequence. Each specialist call is a child run.

## Talk to one specialist

Picking a specific agent sends the turn straight to that agent with its charter and tools.
`
}

export function skillVersion(name: string) {
  const skill = REVIEWED_SKILLS.find((item) => item.definition.name === name)
  if (!skill) throw new PolicyError(`Unknown skill ${name}.`)
  return skill.version
}
