import { env } from '../env'
import { redactValue } from '../lib/redact'
import type { ResponseActionType, ResponseTargets } from '../../shared/response'
import type { Json } from '../../shared/json'

export type ExecutorMode = 'off' | 'dry-run' | 'on'

export interface PlannedCall {
  method: string
  url: string
  body: Json
}

export interface ExecutionOutcome {
  mode: 'dry-run' | 'live'
  executor: ResponseActionType
  calls: PlannedCall[]
  status: 'planned' | 'succeeded' | 'failed' | 'stub'
  response?: { status: number; body: Json }
  error?: string
  rollbackNotes: string
  at: string
}

export interface ProposalForExecution {
  id: string
  orgId: string
  actionType: ResponseActionType
  targets: ResponseTargets
  payload: Record<string, unknown>
}

export interface Executor {
  readonly type: ResponseActionType
  plan(p: ProposalForExecution): PlannedCall[]
  rollbackNotes(p: ProposalForExecution): string
  /** Perform the side effect. Only called by executeProposal for an approved proposal in `on` mode. */
  live?(p: ProposalForExecution, calls: PlannedCall[], fetchImpl: typeof fetch): Promise<{ status: number; body: Json }>
}

/** Executor flags (#52). Default off; `.env.example` documents each. */
export function executorMode(type: ResponseActionType): ExecutorMode {
  const e = env()
  switch (type) {
    case 'sentinel_playbook':
      return e.RESPONSE_EXECUTOR_SENTINEL
    case 'logic_app':
      return e.RESPONSE_EXECUTOR_LOGICAPP
    case 'graph_containment':
      return e.RESPONSE_EXECUTOR_GRAPH
    case 'other':
      return 'off'
  }
}

/**
 * Logic App HTTP trigger: the live-capable executor. The URL comes only from server config
 * (RESPONSE_LOGICAPP_URL), never from the proposal, so an agent cannot redirect the call.
 */
export const logicAppExecutor: Executor = {
  type: 'logic_app',
  plan(p) {
    const url = env().RESPONSE_LOGICAPP_URL
    return [
      {
        method: 'POST',
        url: url ? redactUrl(url) : '(RESPONSE_LOGICAPP_URL not set)',
        body: { proposalId: p.id, orgId: p.orgId, action: String(p.payload.action ?? 'contain'), targets: p.targets as Json },
      },
    ]
  },
  rollbackNotes(p) {
    return [
      `Logic App run for proposal ${p.id}.`,
      '- Open the Logic App run history in the Azure portal and find the run by proposalId.',
      '- Reverse each step the workflow performed (for example re-enable accounts or release devices from isolation).',
      '- Crosswire does not undo actions automatically; record what you reverted on the hunt case.',
    ].join('\n')
  },
  async live(p, _calls, fetchImpl) {
    const url = env().RESPONSE_LOGICAPP_URL
    if (!url) throw new Error('RESPONSE_LOGICAPP_URL is not configured.')
    const body = { proposalId: p.id, orgId: p.orgId, action: p.payload.action ?? 'contain', targets: p.targets }
    const res = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) })
    const text = await res.text()
    let parsed: unknown = text
    try {
      parsed = JSON.parse(text)
    } catch {
      /* keep text */
    }
    if (!res.ok) throw new Error(`Logic App returned HTTP ${res.status}`)
    return { status: res.status, body: redactValue(parsed) as Json }
  },
}

/** Sentinel playbook: documented stub. Records the ARM call it would make. */
export const sentinelPlaybookExecutor: Executor = {
  type: 'sentinel_playbook',
  plan(p) {
    const incident = p.targets.incidents?.[0] ?? '{incidentId}'
    return [
      {
        method: 'POST',
        url: `https://management.azure.com/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.OperationalInsights/workspaces/{ws}/providers/Microsoft.SecurityInsights/incidents/${incident}/runPlaybook?api-version=2024-03-01`,
        body: { logicAppsResourceId: String(p.payload.playbookResourceId ?? '{playbookResourceId}'), tenantId: '{tenantId}' },
      },
    ]
  },
  rollbackNotes(p) {
    return `Sentinel playbook stub for proposal ${p.id}. When implemented: review the playbook run in Sentinel > Automation > Runs and reverse its actions manually.`
  },
}

/** Graph containment: documented stub; exact paths are allowlisted for when it is implemented. */
export const GRAPH_CONTAINMENT_ALLOWLIST = [/^\/api\/machines\/[A-Za-z0-9]+\/isolate$/, /^\/api\/machines\/[A-Za-z0-9]+\/unisolate$/]
export const graphContainmentExecutor: Executor = {
  type: 'graph_containment',
  plan(p) {
    return (p.targets.devices ?? []).map((d) => ({
      method: 'POST',
      url: `https://api.securitycenter.microsoft.com/api/machines/${encodeURIComponent(d)}/isolate`,
      body: { Comment: `Crosswire proposal ${p.id}`, IsolationType: 'Selective' },
    }))
  },
  rollbackNotes(p) {
    return [
      `Device isolation for proposal ${p.id}.`,
      ...(p.targets.devices ?? []).map((d) => `- Release ${d}: Defender portal > device > "Release from isolation", or POST /api/machines/{id}/unisolate.`),
    ].join('\n')
  },
}

export const otherExecutor: Executor = {
  type: 'other',
  plan: () => [],
  rollbackNotes: (p) => `Manual action for proposal ${p.id}. No executor; follow the proposal payload by hand and record what you did.`,
}

export const EXECUTORS: Record<ResponseActionType, Executor> = {
  logic_app: logicAppExecutor,
  sentinel_playbook: sentinelPlaybookExecutor,
  graph_containment: graphContainmentExecutor,
  other: otherExecutor,
}

function redactUrl(url: string) {
  return url.replace(/([?&](sig|code|sv|sp)=)[^&]+/gi, '$1[REDACTED]')
}

/** Dry run (#53): compute the intended calls; never performs a request. */
export function dryRun(p: ProposalForExecution): ExecutionOutcome {
  const ex = EXECUTORS[p.actionType]
  return {
    mode: 'dry-run',
    executor: p.actionType,
    calls: ex.plan(p).map((c) => ({ ...c, body: redactValue(c.body) as Json })),
    status: 'planned',
    rollbackNotes: ex.rollbackNotes(p),
    at: new Date().toISOString(),
  }
}

/** Live execution (#52). Caller must have verified approval. Respects the executor flag. */
export async function executeLive(p: ProposalForExecution, fetchImpl: typeof fetch = fetch): Promise<ExecutionOutcome> {
  const ex = EXECUTORS[p.actionType]
  const mode = executorMode(p.actionType)
  const calls = ex.plan(p).map((c) => ({ ...c, body: redactValue(c.body) as Json }))
  const base = { executor: p.actionType, calls, rollbackNotes: ex.rollbackNotes(p), at: new Date().toISOString() }
  if (mode !== 'on') throw new Error(`Executor ${p.actionType} is ${mode}; set RESPONSE_EXECUTOR_* to "on" to execute.`)
  if (!ex.live) return { ...base, mode: 'live', status: 'stub', error: `${p.actionType} executor is a documented stub in v1; no call was made.` }
  try {
    const response = await ex.live(p, calls, fetchImpl)
    return { ...base, mode: 'live', status: 'succeeded', response }
  } catch (err) {
    return { ...base, mode: 'live', status: 'failed', error: err instanceof Error ? err.message : String(err) }
  }
}
