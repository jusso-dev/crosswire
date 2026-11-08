import { toolDefinition, type AnyTool } from '@tanstack/ai'
import { z } from 'zod'
import type { AgentKey } from '../../shared/agents'
import { RESPONSE_ACTION_TYPES } from '../../shared/response'
import { env } from '../env'
import { recordDecision } from './decisions'
import { appendMemory, searchMemory } from './memory'
import { compareKey, searchIntel } from '../ti/compare'
import { listWatchHits } from '../ti/watchlists'
import { getHunt, proposeKql } from '../hunting/hunts'
import { huntingClient } from '../hunting/client'
import { createProposal } from '../response/proposals'

export interface ToolContext {
  orgId: string
  userId: string
  agentKey: AgentKey
  threadId: string | null
  /** Collected tool traces, surfaced in message metadata. */
  traces: Array<{ tool: string; input: unknown; output: unknown; error?: string }>
}

/**
 * Tool registry. Hard rule (#48, #56): no tool executes KQL or a response proposal. `propose_*`
 * tools only create records for human review. `EXECUTION_TOOL_NAMES` must stay empty; a test asserts it.
 */
export const EXECUTION_TOOL_NAMES: readonly string[] = []

/**
 * Decision-log copy of a tool output with stored result rows replaced by their count, so query
 * results never outlive RETENTION_SAMPLES_DAYS inside agent_decisions (kept for the longer
 * RETENTION_DECISIONS_DAYS). The model still receives the full output.
 */
export function withoutSamples(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutSamples)
  if (!value || typeof value !== 'object' || value instanceof Date) return value
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) {
    if (k === 'sample' && Array.isArray(v)) out.sampleRows = v.length
    else if (k === 'rows' && Array.isArray(v)) out.rowsOmitted = v.length
    else out[k] = withoutSamples(v)
  }
  return out
}

async function traced<T>(ctx: ToolContext, tool: string, input: unknown, fn: () => Promise<T>, forLog: (output: T) => unknown = (o) => o): Promise<T | { error: string }> {
  try {
    const output = await fn()
    ctx.traces.push({ tool, input, output })
    await recordDecision({ orgId: ctx.orgId, actorType: 'agent', actorKey: ctx.agentKey, action: `tool:${tool}`, input, output: forLog(output), threadId: ctx.threadId })
    return output
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    ctx.traces.push({ tool, input, output: null, error })
    await recordDecision({ orgId: ctx.orgId, actorType: 'agent', actorKey: ctx.agentKey, action: `tool:${tool}:error`, input, output: error, threadId: ctx.threadId })
    return { error }
  }
}

const appUrl = () => env().APP_URL.replace(/\/$/, '')

export function buildTools(ctx: ToolContext): Record<string, AnyTool> {
  const memorySearch = toolDefinition({
    name: 'memory_search',
    description: "Search this org's agent memory for prior facts, feedback and safety notes.",
    inputSchema: z.object({ query: z.string().min(2).max(200) }),
  }).server(async ({ query }) => traced(ctx, 'memory_search', { query }, () => searchMemory(ctx.orgId, query)))

  const remember = toolDefinition({
    name: 'remember',
    description: 'Append one short, sourced fact to org memory. Never include secrets or raw result tables.',
    inputSchema: z.object({ fact: z.string().min(5).max(500), agent: z.enum(['lead', 'hunter', 'intel', 'responder', 'scribe']).optional() }),
  }).server(async ({ fact, agent }) =>
    traced(ctx, 'remember', { fact, agent }, async () => {
      const row = await appendMemory({ orgId: ctx.orgId, agentKey: agent ?? ctx.agentKey, body: fact, sourceType: 'thread', sourceId: ctx.threadId ?? undefined })
      return { id: row.id, kind: row.kind, redacted: row.redacted }
    }),
  )

  const searchIntelTool = toolDefinition({
    name: 'search_intel',
    description: 'Search ingested threat intel (pwn.watch incidents, CISA KEV) by CVE ID, vendor, product or keyword.',
    inputSchema: z.object({ query: z.string().min(2).max(200) }),
  }).server(async ({ query }) => traced(ctx, 'search_intel', { query }, () => searchIntel(query)))

  const compareCve = toolDefinition({
    name: 'compare_cve',
    description: 'Compare one CVE across all ingested sources and report agreement/conflict.',
    inputSchema: z.object({ key: z.string().min(3).max(100) }),
  }).server(async ({ key }) => traced(ctx, 'compare_cve', { key }, () => compareKey(ctx.orgId, key)))

  const listHits = toolDefinition({
    name: 'list_watch_hits',
    description: "List this org's most recent watchlist hits.",
    inputSchema: z.object({ limit: z.number().int().min(1).max(50).optional() }),
  }).server(async ({ limit }) => traced(ctx, 'list_watch_hits', { limit }, () => listWatchHits(ctx.orgId, { limit: limit ?? 20 })))

  const getHuntTool = toolDefinition({
    name: 'get_hunt',
    description: 'Read a hunt case, its evidence trail and KQL proposals (including stored result summaries).',
    inputSchema: z.object({ huntId: z.string().min(1) }),
  }).server(async ({ huntId }) =>
    traced(ctx, 'get_hunt', { huntId }, async () => {
      const h = await getHunt(ctx.orgId, huntId)
      if (!h) throw new Error('Hunt not found in this org.')
      return { hunt: h.hunt, evidence: h.evidence.slice(-20), proposals: h.proposals.map((p) => ({ id: p.id, status: p.status, target: p.target, kql: p.kql, resultSummary: p.resultSummary })) }
    }, withoutSamples),
  )

  const proposeKqlTool = toolDefinition({
    name: 'propose_kql',
    description: 'Propose a KQL query on a hunt case for human review. This does NOT run the query; a human must approve it in the hunt case.',
    inputSchema: z.object({
      huntId: z.string().min(1),
      target: z.enum(['defender', 'sentinel']),
      kql: z.string().min(5).max(10_000),
      rationale: z.string().max(1000).optional(),
    }),
  }).server(async (input) =>
    traced(ctx, 'propose_kql', input, async () => {
      const p = await proposeKql(ctx.orgId, { type: 'agent', id: ctx.agentKey }, { ...input, threadId: ctx.threadId, requestedBy: ctx.userId })
      return { proposalId: p.id, status: p.status, review: `${appUrl()}/app/hunts/${input.huntId}`, note: 'Pending human review. Not executed.' }
    }),
  )

  const listIncidents = toolDefinition({
    name: 'list_sentinel_incidents',
    description: 'List recent Microsoft Sentinel incidents for this org (read-only, bounded).',
    inputSchema: z.object({ top: z.number().int().min(1).max(50).optional() }),
  }).server(async ({ top }) => traced(ctx, 'list_sentinel_incidents', { top }, () => huntingClient().listSentinelIncidents({ orgId: ctx.orgId, top })))

  const proposeResponse = toolDefinition({
    name: 'propose_response',
    description:
      'Create a PENDING response proposal for human approval. Requires explicit targets and a blast radius summary. This never executes anything; an approver decides in the approval inbox.',
    inputSchema: z.object({
      title: z.string().min(3).max(200),
      actionType: z.enum(RESPONSE_ACTION_TYPES),
      targets: z.object({ devices: z.array(z.string()).optional(), users: z.array(z.string()).optional(), incidents: z.array(z.string()).optional() }),
      blastRadius: z.object({ summary: z.string().min(10).max(1000) }),
      payload: z.record(z.string(), z.unknown()).optional(),
      huntId: z.string().optional(),
    }),
  }).server(async (input) =>
    traced(ctx, 'propose_response', input, async () => {
      const p = await createProposal(ctx.orgId, { type: 'agent', agentKey: ctx.agentKey, onBehalfOfUserId: ctx.userId }, { ...input, payload: input.payload ?? {} })
      return { proposalId: p.id, status: p.status, approvalInbox: `${appUrl()}/app/approvals/${p.id}`, note: 'Pending approval. Nothing has been executed.' }
    }),
  )

  return {
    memory_search: memorySearch,
    remember,
    search_intel: searchIntelTool,
    compare_cve: compareCve,
    list_watch_hits: listHits,
    get_hunt: getHuntTool,
    propose_kql: proposeKqlTool,
    list_sentinel_incidents: listIncidents,
    propose_response: proposeResponse,
  }
}

/** Per-agent tool allowlist (#30, #56). Only Responder (and Lead) can propose responses. */
export const AGENT_TOOLS: Record<AgentKey, string[]> = {
  lead: ['memory_search', 'search_intel', 'list_watch_hits', 'get_hunt', 'propose_response'],
  hunter: ['memory_search', 'get_hunt', 'propose_kql', 'list_sentinel_incidents'],
  intel: ['memory_search', 'search_intel', 'compare_cve', 'list_watch_hits'],
  responder: ['memory_search', 'get_hunt', 'propose_response'],
  scribe: ['memory_search', 'remember'],
}

export function toolsFor(agentKey: AgentKey, ctx: ToolContext): AnyTool[] {
  const all = buildTools(ctx)
  return AGENT_TOOLS[agentKey].map((name) => all[name]!).filter(Boolean)
}
