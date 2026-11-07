import { env, responseSafety } from '../env'
import { redactValue } from '../lib/redact'
import { getConnector } from '../hunting/broker'
import type { ResponseActionType, ResponseTargets } from '../../shared/response'
import type { Json } from '../../shared/json'
import { getResponseConnector, LOGIC_APP_RESOURCE_ID, normalisePlaybookId, responseTokenBroker } from './connector'

export type ExecutorMode = 'off' | 'dry-run' | 'on'

export interface PlannedCall {
  method: 'POST'
  url: string
  body: Json
  /** Token audience for the response connector; absent for the Logic App trigger (SAS URL). */
  scope?: string
  /** The single target this call acts on, so partial failures map back to targets (#89). */
  target?: { kind: 'device' | 'incident'; id: string }
}

export interface CallResult {
  url: string
  target?: PlannedCall['target']
  ok: boolean
  status: number | null
  body?: Json
  error?: string
}

export interface ExecutionOutcome {
  mode: 'dry-run' | 'live'
  executor: ResponseActionType
  calls: PlannedCall[]
  /** Why execution would be refused (allowlist, caps, missing config). Empty = executable. */
  blocked: string[]
  status: 'planned' | 'blocked' | 'succeeded' | 'partial' | 'failed'
  results?: CallResult[]
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

/** Non-secret context executors plan against: workspace coordinates, tenant and playbook allowlist. */
export interface ExecContext {
  responseTenantId: string | null
  playbookAllowlist: string[]
  workspace: { subscriptionId: string; resourceGroup: string; workspaceName: string } | null
}

export async function loadExecContext(orgId: string): Promise<ExecContext> {
  const [resp, hunt] = await Promise.all([getResponseConnector(orgId), getConnector(orgId)])
  return {
    responseTenantId: resp?.tenantId ?? null,
    playbookAllowlist: (resp?.playbookAllowlist ?? []).map(normalisePlaybookId),
    workspace:
      hunt?.sentinelSubscriptionId && hunt.sentinelResourceGroup && hunt.sentinelWorkspaceName
        ? { subscriptionId: hunt.sentinelSubscriptionId, resourceGroup: hunt.sentinelResourceGroup, workspaceName: hunt.sentinelWorkspaceName }
        : null,
  }
}

interface Plan {
  calls: PlannedCall[]
  blocked: string[]
}

export interface Executor {
  readonly type: ResponseActionType
  plan(p: ProposalForExecution, ctx: ExecContext): Plan
  rollbackNotes(p: ProposalForExecution): string
  /** True when `executeLive` may perform the planned calls. */
  readonly live: boolean
}

/** Executor flags (#52). Default off; `.env.example` documents each. */
export function executorMode(type: ResponseActionType): ExecutorMode {
  // Effective mode after the global dry-run guard (#83): fails closed to dry-run when ambiguous.
  const { executors } = responseSafety()
  switch (type) {
    case 'sentinel_playbook':
      return executors.sentinel
    case 'logic_app':
      return executors.logicapp
    case 'graph_containment':
      return executors.graph
    case 'other':
      return 'off'
  }
}

// ---------- Response HTTP allowlist (#89) ----------
/** Defender machine ids are 40 lowercase hex characters (SHA-1 of the device). */
export const DEFENDER_MACHINE_ID = /^[0-9a-f]{40}$/
export const DEFENDER_API = 'https://api.security.microsoft.com'
export const DEFENDER_SCOPE = 'https://api.securitycenter.microsoft.com/.default'
export const ARM_SCOPE = 'https://management.azure.com/.default'
export const SENTINEL_API_VERSION = '2025-09-01'

export const RESPONSE_ALLOWLIST: Array<{ host: string; path: RegExp; purpose: string }> = [
  { host: 'api.security.microsoft.com', path: /^\/api\/machines\/[0-9a-f]{40}\/(isolate|unisolate)$/, purpose: 'Defender device isolate / release' },
  {
    host: 'management.azure.com',
    path: /^\/subscriptions\/[0-9a-f-]{36}\/resourceGroups\/[^/]+\/providers\/Microsoft\.OperationalInsights\/workspaces\/[^/]+\/providers\/Microsoft\.SecurityInsights\/incidents\/[^/]+\/runPlaybook$/i,
    purpose: 'Sentinel run playbook on an incident',
  },
]

export class BlockedResponseRequestError extends Error {}

/** Only POSTs to the exact response endpoints above. No generic request escape hatch. */
export function assertAllowedResponseRequest(method: string, url: string) {
  const u = new URL(url)
  if (u.protocol !== 'https:') throw new BlockedResponseRequestError('Response client only allows https.')
  if (method.toUpperCase() !== 'POST' || !RESPONSE_ALLOWLIST.some((r) => r.host === u.hostname && r.path.test(u.pathname))) {
    throw new BlockedResponseRequestError(`Response client blocked ${method.toUpperCase()} ${u.hostname}${u.pathname}: not on the response allowlist.`)
  }
}

function liveTargetCap(kind: string, n: number, blocked: string[]) {
  const max = env().RESPONSE_MAX_LIVE_TARGETS
  if (n > max) blocked.push(`${n} ${kind} exceeds RESPONSE_MAX_LIVE_TARGETS=${max}; split the proposal.`)
}

// ---------- Executors ----------
/**
 * Logic App HTTP trigger. The URL comes only from server config (RESPONSE_LOGICAPP_URL), never from
 * the proposal, so an agent cannot redirect the call.
 */
export const logicAppExecutor: Executor = {
  type: 'logic_app',
  live: true,
  plan(p) {
    const url = env().RESPONSE_LOGICAPP_URL
    const blocked = url ? [] : ['RESPONSE_LOGICAPP_URL is not configured.']
    return {
      calls: [{ method: 'POST', url: url ? redactUrl(url) : '(RESPONSE_LOGICAPP_URL not set)', body: { proposalId: p.id, orgId: p.orgId, action: String(p.payload.action ?? 'contain'), targets: p.targets as Json } }],
      blocked,
    }
  },
  rollbackNotes(p) {
    return [
      `Logic App run for proposal ${p.id}.`,
      '- Open the Logic App run history in the Azure portal and find the run by proposalId.',
      '- Reverse each step the workflow performed (for example re-enable accounts or release devices from isolation).',
      '- Crosswire cannot undo a Logic App run automatically; "Propose rollback" records the manual reversal as an approved action.',
    ].join('\n')
  },
}

/** Sentinel playbook (#89): runPlaybook on each incident with an allowlisted Logic App. */
export const sentinelPlaybookExecutor: Executor = {
  type: 'sentinel_playbook',
  live: true,
  plan(p, ctx) {
    const blocked: string[] = []
    const incidents = p.targets.incidents ?? []
    const playbook = String(p.payload.playbookResourceId ?? '')
    if (incidents.length === 0) blocked.push('Sentinel playbook proposals need at least one incident target.')
    if (!LOGIC_APP_RESOURCE_ID.test(playbook)) blocked.push('payload.playbookResourceId must be a Logic App resource id.')
    else if (!ctx.playbookAllowlist.includes(normalisePlaybookId(playbook))) blocked.push('Playbook is not on this org\'s playbook allowlist (Settings → Response connector).')
    if (!ctx.workspace) blocked.push('Sentinel workspace (subscription, resource group, workspace name) is not set on the hunting connector.')
    if (!ctx.responseTenantId) blocked.push('Response connector is not configured.')
    liveTargetCap('incidents', incidents.length, blocked)
    const w = ctx.workspace ?? { subscriptionId: '{subscriptionId}', resourceGroup: '{resourceGroup}', workspaceName: '{workspace}' }
    const calls: PlannedCall[] = incidents.map((inc) => ({
      method: 'POST',
      url:
        `https://management.azure.com/subscriptions/${encodeURIComponent(w.subscriptionId)}/resourceGroups/${encodeURIComponent(w.resourceGroup)}` +
        `/providers/Microsoft.OperationalInsights/workspaces/${encodeURIComponent(w.workspaceName)}/providers/Microsoft.SecurityInsights/incidents/${encodeURIComponent(inc)}` +
        `/runPlaybook?api-version=${SENTINEL_API_VERSION}`,
      body: { logicAppsResourceId: playbook, tenantId: ctx.responseTenantId ?? '{tenantId}' },
      scope: ARM_SCOPE,
      target: { kind: 'incident', id: inc },
    }))
    return { calls, blocked }
  },
  rollbackNotes(p) {
    return [
      `Sentinel playbook run for proposal ${p.id} (${String(p.payload.playbookResourceId ?? '')}).`,
      '- Review each run in Sentinel → Automation → Runs (or the Logic App run history) for the incidents listed.',
      '- Reverse each step the playbook performed. Crosswire cannot undo a playbook generically; "Propose rollback" records the reversal as an approved action.',
    ].join('\n')
  },
}

function containmentAction(p: ProposalForExecution): 'isolate' | 'unisolate' {
  return p.payload.action === 'unisolate' ? 'unisolate' : 'isolate'
}

/** Defender for Endpoint containment (#89): isolate or release each machine, one call per device. */
export const graphContainmentExecutor: Executor = {
  type: 'graph_containment',
  live: true,
  plan(p, ctx) {
    const blocked: string[] = []
    const devices = p.targets.devices ?? []
    const action = containmentAction(p)
    const isolationType = p.payload.isolationType === 'Full' ? 'Full' : 'Selective'
    if (devices.length === 0) blocked.push('Containment proposals need at least one device target.')
    const bad = devices.filter((d) => !DEFENDER_MACHINE_ID.test(d))
    if (bad.length) blocked.push(`Not Defender machine ids (40 hex characters): ${bad.slice(0, 5).join(', ')}`)
    if (!ctx.responseTenantId) blocked.push('Response connector is not configured.')
    liveTargetCap('devices', devices.length, blocked)
    const calls: PlannedCall[] = devices.map((d) => ({
      method: 'POST',
      url: `${DEFENDER_API}/api/machines/${encodeURIComponent(d)}/${action}`,
      body: (action === 'isolate' ? { Comment: `Crosswire proposal ${p.id}`, IsolationType: isolationType } : { Comment: `Crosswire proposal ${p.id} (rollback)` }) as Json,
      scope: DEFENDER_SCOPE,
      target: { kind: 'device', id: d },
    }))
    return { calls, blocked }
  },
  rollbackNotes(p) {
    const devices = p.targets.devices ?? []
    if (containmentAction(p) === 'unisolate') {
      return [`Release from isolation for proposal ${p.id}.`, ...devices.map((d) => `- Re-isolate ${d} with a new proposal if the release was premature.`)].join('\n')
    }
    return [
      `Device isolation for proposal ${p.id}.`,
      '- "Propose rollback" creates a release (unisolate) proposal for exactly the devices that were isolated.',
      ...devices.map((d) => `- Manual fallback for ${d}: Defender portal → device → "Release from isolation".`),
    ].join('\n')
  },
}

export const otherExecutor: Executor = {
  type: 'other',
  live: false,
  plan: () => ({ calls: [], blocked: ['Manual action: there is no executor. Perform it by hand and record what you did on the hunt case.'] }),
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

/** Dry run (#53): compute the intended calls and any blockers; never performs a request. */
export function dryRun(p: ProposalForExecution, ctx: ExecContext): ExecutionOutcome {
  const ex = EXECUTORS[p.actionType]
  const plan = ex.plan(p, ctx)
  return {
    mode: 'dry-run',
    executor: p.actionType,
    calls: plan.calls.map((c) => ({ ...c, body: redactValue(c.body) as Json })),
    blocked: plan.blocked,
    status: plan.blocked.length ? 'blocked' : 'planned',
    rollbackNotes: ex.rollbackNotes(p),
    at: new Date().toISOString(),
  }
}

/** Throws when a proposal could never execute; used before the atomic execution claim. */
export function assertExecutable(p: ProposalForExecution, ctx: ExecContext) {
  const ex = EXECUTORS[p.actionType]
  if (!ex.live) throw new Error(`${p.actionType} has no executor; perform it by hand.`)
  const { blocked } = ex.plan(p, ctx)
  if (blocked.length) throw new Error(`Refused before any call: ${blocked.join(' ')}`)
}

async function readBody(res: Response): Promise<Json> {
  const text = await res.text()
  if (!text) return null
  try {
    return redactValue(JSON.parse(text)) as Json
  } catch {
    return redactValue(text.slice(0, 2000)) as Json
  }
}

/**
 * Live execution (#52, #89). Caller must have verified approval and claimed the proposal. Each call
 * is checked against the response allowlist (or is the server-configured Logic App URL), uses a
 * token from the response connector only, and is recorded individually so partial failures are exact.
 */
export async function executeLive(p: ProposalForExecution, ctx: ExecContext, fetchImpl: typeof fetch = fetch): Promise<ExecutionOutcome> {
  const ex = EXECUTORS[p.actionType]
  const mode = executorMode(p.actionType)
  if (mode !== 'on') throw new Error(`Executor ${p.actionType} is ${mode}; set RESPONSE_EXECUTOR_* to "on" to execute.`)
  const plan = ex.plan(p, ctx)
  const base = {
    mode: 'live' as const,
    executor: p.actionType,
    calls: plan.calls.map((c) => ({ ...c, body: redactValue(c.body) as Json })),
    blocked: plan.blocked,
    rollbackNotes: ex.rollbackNotes(p),
    at: new Date().toISOString(),
  }
  if (!ex.live || plan.blocked.length) return { ...base, status: 'failed', error: `Refused before any call: ${plan.blocked.join(' ')}`, results: [] }

  const results: CallResult[] = []
  for (const call of plan.calls) {
    const shownUrl = redactUrl(call.url)
    try {
      let realUrl = call.url
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (p.actionType === 'logic_app') {
        realUrl = env().RESPONSE_LOGICAPP_URL!
      } else {
        assertAllowedResponseRequest(call.method, call.url)
        headers.Authorization = `Bearer ${await responseTokenBroker().acquire({ orgId: p.orgId, scope: call.scope! })}`
      }
      const res = await fetchImpl(realUrl, { method: call.method, headers, body: JSON.stringify(call.body), redirect: 'error', signal: AbortSignal.timeout(30_000) })
      const body = await readBody(res)
      results.push({ url: shownUrl, target: call.target, ok: res.ok, status: res.status, body, error: res.ok ? undefined : `HTTP ${res.status}` })
    } catch (err) {
      results.push({ url: shownUrl, target: call.target, ok: false, status: null, error: err instanceof Error ? err.message.slice(0, 500) : String(err) })
    }
  }
  const okCount = results.filter((r) => r.ok).length
  const status = okCount === results.length ? 'succeeded' : okCount === 0 ? 'failed' : 'partial'
  const error = status === 'succeeded' ? undefined : results.filter((r) => !r.ok).map((r) => `${r.target?.id ?? r.url}: ${r.error}`).join('; ')
  return { ...base, status, results, error }
}
