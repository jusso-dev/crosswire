import type { AgentKey } from '../../shared/agents'
import { defineSkill, type SkillDefinition } from '@bradygaster/squad-sdk/builders'

export interface ReviewedSkill {
  agent: AgentKey
  version: number
  tools: readonly string[]
  definition: SkillDefinition
}

const NEVER = 'Never execute containment without an approved proposal. Agents propose. People approve.'

/** Reviewed SOC runbooks. Versions live here. Org copies are directives, not this list. */
export const REVIEWED_SKILLS: readonly ReviewedSkill[] = [
  {
    agent: 'hunter',
    version: 1,
    tools: ['memory_search', 'get_hunt', 'propose_kql', 'list_sentinel_incidents'],
    definition: {
      name: 'hunt-read-only',
      description: 'Read-only hunt and a KQL proposal for a human to approve.',
      domain: 'hunting',
      confidence: 'high',
      source: 'manual',
      content: `## Hunt\nSearch prior memory, read the hunt, and propose KQL. Do not claim a query ran.\n${NEVER}`,
      tools: [
        { name: 'memory_search', description: 'Prior notes for this org', when: 'Before proposing a query' },
        { name: 'get_hunt', description: 'Read one hunt', when: 'The analyst named a hunt' },
        { name: 'propose_kql', description: 'Queue a query for approval', when: 'A new query is needed' },
        { name: 'list_sentinel_incidents', description: 'List incidents', when: 'The question is about Sentinel incidents' },
      ],
    },
  },
  {
    agent: 'intel',
    version: 1,
    tools: ['memory_search', 'search_intel', 'compare_cve', 'list_watch_hits'],
    definition: {
      name: 'intel-compare',
      description: 'Compare watch hits and CVE sources. Cite the source.',
      domain: 'intel',
      confidence: 'high',
      source: 'manual',
      content: `## Intel\nCompare ingested sources. Cite each claim. Do not invent a sighting.\n${NEVER}`,
      tools: [
        { name: 'search_intel', description: 'Search ingested intel', when: 'A CVE, vendor, or product is named' },
        { name: 'compare_cve', description: 'Compare one CVE across sources', when: 'A CVE id is present' },
        { name: 'list_watch_hits', description: 'Recent watch hits', when: 'The question is about our watches' },
      ],
    },
  },
  {
    agent: 'responder',
    version: 1,
    tools: ['memory_search', 'get_hunt', 'propose_response'],
    definition: {
      name: 'response-propose',
      description: 'Draft a response proposal. Do not execute it.',
      domain: 'response',
      confidence: 'high',
      source: 'manual',
      content: `## Response\nDraft one proposal with a blast radius. Stop. Execution is a separate credential and a second person.\n${NEVER}`,
      tools: [
        { name: 'propose_response', description: 'Create a pending proposal', when: 'The analyst asked for containment' },
        { name: 'get_hunt', description: 'Read the hunt the proposal cites', when: 'A hunt id is in scope' },
      ],
    },
  },
  {
    agent: 'scribe',
    version: 1,
    tools: ['memory_search', 'remember'],
    definition: {
      name: 'memory-note',
      description: 'Write a short memory note. Notes from chat stay quarantined until a person promotes them.',
      domain: 'memory',
      confidence: 'high',
      source: 'manual',
      content: `## Notes\nRecord one sourced fact. Secrets and raw result tables stay out.\n${NEVER}`,
      tools: [
        { name: 'remember', description: 'Append one fact', when: 'The analyst asked to remember a note' },
        { name: 'memory_search', description: 'Find an existing note', when: 'Before writing a duplicate' },
      ],
    },
  },
]

export function reviewedSkillDefinitions() {
  return REVIEWED_SKILLS.map((skill) => ({ ...skill, skill: defineSkill(skill.definition) }))
}
