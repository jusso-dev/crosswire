import { readFileSync } from 'node:fs'
import {
  BuilderValidationError,
  defineAgent,
  defineBudget,
  defineDefaults,
  defineRouting,
  defineSkill,
  defineSquad,
  defineTeam,
  type AgentDefinition,
  type BudgetDefinition,
  type RoutingDefinition,
  type SkillDefinition,
  type SquadSDKConfig,
  type TeamDefinition,
} from '@bradygaster/squad-sdk/builders'
import { InMemoryStorageProvider } from '@bradygaster/squad-sdk/storage'
import { LocalMemoryStore, type MemoryClassification, type MemoryWriteRequest, type MemoryWriteResult } from '@bradygaster/squad-sdk/memory'
import { CostTracker } from '@bradygaster/squad-sdk/runtime/cost-tracker'

/**
 * Squad SDK 1.1.0 boundary.
 *
 * SOC turns stay on LlmAgentRuntime. This module calls the stable library. It does not import
 * `@bradygaster/squad-sdk/client`, `@bradygaster/squad-sdk/backend`, or `@github/copilot-sdk`.
 *
 * 1.1.0 has UsageLedger and ContextUtilizationTracker in dist/runtime, and the exports map does
 * not list them. This module does not file-URL import those files. Tenant usage stays in Postgres.
 * Context refusal is Crosswire's, at the same 0.8 threshold the installed tracker documents.
 * CostTracker, which is an export, records a dollar figure only when the operator set a rate.
 * SquadClient is not constructed here. SOC turns stay on LlmAgentRuntime.
 *
 * LocalMemoryStore is backed only by InMemoryStorageProvider. FSStorageProvider and
 * SQLiteStorageProvider are never constructed. Importing `@bradygaster/squad-sdk/storage` does
 * evaluate those modules, because the barrel re-exports them. sql.js loads only if
 * SQLiteStorageProvider.init() runs, and this process never calls it.
 *
 * The SDK store is process-local and not org-isolated. Tenant memory stays in Postgres.
 * Production calls classify(). write() is for the acceptance test and for refuse-path checks.
 */
export const SQUAD_SDK_PIN = '1.1.0'
/** Same default the installed 1.1.0 ContextUtilizationTracker documents. Crosswire blocks at this ratio. */
export const CONTEXT_WARNING_THRESHOLD = 0.8

export interface SquadContextSnapshot {
  sessionId: string
  occupiedTokens: number
  contextWindowTokens: number
  utilization: number
  warningThreshold: number
  warning: boolean
  source: 'estimated'
}

export function installedSquadSdkVersion(): string {
  const costTrackerUrl = import.meta.resolve('@bradygaster/squad-sdk/runtime/cost-tracker')
  const pkgUrl = new URL('../../package.json', costTrackerUrl)
  const pkg = JSON.parse(readFileSync(pkgUrl, 'utf8')) as { version?: string }
  if (pkg.version !== SQUAD_SDK_PIN) {
    throw new Error(`@bradygaster/squad-sdk resolved to ${pkg.version ?? 'unknown'}; Crosswire requires ${SQUAD_SDK_PIN}.`)
  }
  return pkg.version
}

export function squadSdkPackageHasBackendExport(): boolean {
  const costTrackerUrl = import.meta.resolve('@bradygaster/squad-sdk/runtime/cost-tracker')
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', costTrackerUrl), 'utf8')) as { exports?: Record<string, unknown> }
  return Object.keys(pkg.exports ?? {}).some((key) => key === './backend' || key.startsWith('./backend/'))
}

let memoryStore: LocalMemoryStore | undefined

export function squadSdkMemoryStore(): LocalMemoryStore {
  installedSquadSdkVersion()
  memoryStore ??= new LocalMemoryStore(new InMemoryStorageProvider(), 'memory://crosswire')
  return memoryStore
}

export async function classifyWithSquad(content: string, requestedClass?: MemoryWriteRequest['requestedClass']): Promise<MemoryClassification> {
  return squadSdkMemoryStore().classify({ content, requestedClass })
}

export async function writeWithSquad(request: MemoryWriteRequest): Promise<MemoryWriteResult> {
  return squadSdkMemoryStore().write(request)
}

export function newCostTracker(): CostTracker {
  installedSquadSdkVersion()
  return new CostTracker()
}

let costTracker: CostTracker | undefined
/** Process-wide tracker. Production usage does not write here. Org totals use costTrackerForOrg. */
export function sharedCostTracker(): CostTracker {
  costTracker ??= newCostTracker()
  return costTracker
}

const orgCostTrackers = new Map<string, CostTracker>()

/** One tracker per organisation. Recording org B does not change org A's totals. */
export function costTrackerForOrg(orgId: string): CostTracker {
  let tracker = orgCostTrackers.get(orgId)
  if (!tracker) {
    tracker = newCostTracker()
    orgCostTrackers.set(orgId, tracker)
  }
  return tracker
}

export function resetSquadSdkForTests() {
  costTracker = undefined
  orgCostTrackers.clear()
  memoryStore = undefined
}

/**
 * Record a dollar amount the operator's rate produced. Callers pass null's absence by not calling
 * this when the rate is unset. 0 is allowed only as a computed cost, never as "unknown".
 */
export function recordSquadUsage(event: { orgId: string; sessionId: string; agentName?: string; model: string; inputTokens: number; outputTokens: number; estimatedCost: number }): void {
  if (!Number.isFinite(event.estimatedCost) || event.estimatedCost < 0) {
    throw new Error('Usage cost must be a non-negative finite number from BUDGET_USD_PER_MILLION_TOKENS. An unknown price is not recorded as 0.')
  }
  costTrackerForOrg(event.orgId).recordUsage(event)
}

/** Local context ratio. The SDK tracker is not a package export, and it only warns. */
export function assessContextWindow(input: { sessionId: string; inputTokens: number; outputTokens: number; contextWindowTokens: number }): SquadContextSnapshot {
  if (!Number.isInteger(input.contextWindowTokens) || input.contextWindowTokens <= 0) throw new Error('Context window must be a positive integer.')
  if (!Number.isInteger(input.inputTokens) || !Number.isInteger(input.outputTokens) || input.inputTokens < 0 || input.outputTokens < 0) {
    throw new Error('Context token counts must be non-negative integers.')
  }
  const occupiedTokens = input.inputTokens + input.outputTokens
  const utilization = occupiedTokens / input.contextWindowTokens
  return {
    sessionId: input.sessionId,
    occupiedTokens,
    contextWindowTokens: input.contextWindowTokens,
    utilization,
    warningThreshold: CONTEXT_WARNING_THRESHOLD,
    warning: utilization >= CONTEXT_WARNING_THRESHOLD,
    source: 'estimated',
  }
}

export function buildSquadConfig(input: {
  team: TeamDefinition
  agents: readonly AgentDefinition[]
  routing: RoutingDefinition
  skills?: readonly SkillDefinition[]
  budget: BudgetDefinition
}): SquadSDKConfig {
  installedSquadSdkVersion()
  return defineSquad({
    version: '1.0.0',
    team: defineTeam(input.team),
    agents: input.agents.map((agent) => defineAgent(agent)),
    routing: defineRouting(input.routing),
    skills: input.skills?.map((skill) => defineSkill(skill)),
    defaults: defineDefaults({ budget: defineBudget(input.budget) }),
  })
}

export { BuilderValidationError, defineAgent, defineBudget, defineRouting, defineSkill, defineSquad, defineTeam, InMemoryStorageProvider, LocalMemoryStore, CostTracker }
export type { SquadSDKConfig }
