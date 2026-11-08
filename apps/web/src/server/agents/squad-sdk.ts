import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
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
 * 1.1.0 publishes UsageLedger and ContextUtilizationTracker under dist/runtime, but the package
 * exports map does not list those subpaths (verified against the installed 1.1.0 package.json).
 * They are loaded by file URL next to the public `runtime/cost-tracker` module. That is still
 * 1.1.0. It is not the 2.0.0-preview.3 HarnessAdapter surface, which this package does not ship.
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
/** Default path inside UsageLedger. Crosswire never passes this path. */
export const SDK_USAGE_LEDGER_DEFAULT = 'log/usage.jsonl'
export const SDK_USAGE_LEDGER_PATH = 'memory/usage.jsonl'

export interface SquadUsageEvent {
  type: 'usage'
  sessionId: string
  turnId?: string
  agentName?: string
  model: string
  inputTokens: number
  outputTokens: number
  estimatedCost: number
  timestamp: Date
}

export interface SquadContextSnapshot {
  sessionId: string
  occupiedTokens: number
  contextWindowTokens: number
  utilization: number
  warningThreshold: number
  warning: boolean
  source: 'runtime' | 'estimated'
}

interface UsageLedgerLike {
  append(event: SquadUsageEvent): Promise<void>
  read(): Promise<{ records: Array<{ inputTokens: number; outputTokens: number; estimatedCost: number }> }>
}

interface ContextTrackerLike {
  recordEstimated(sample: { sessionId: string; agentName?: string; model: string; inputTokens: number; outputTokens: number }): SquadContextSnapshot | undefined
  getLatest(sessionId: string): SquadContextSnapshot | undefined
}

interface UnexportedRuntime {
  UsageLedger: new (storage: InMemoryStorageProvider, ledgerPath?: string) => UsageLedgerLike
  ContextUtilizationTracker: new (options?: { warningThreshold?: number; resolveContextWindow?: (model: string) => number | undefined }) => ContextTrackerLike
  USAGE_LEDGER_PATH: string
}

let unexported: Promise<UnexportedRuntime> | undefined

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

export async function loadUnexportedSquadRuntime(): Promise<UnexportedRuntime> {
  installedSquadSdkVersion()
  unexported ??= (async () => {
    const costTrackerUrl = import.meta.resolve('@bradygaster/squad-sdk/runtime/cost-tracker')
    const runtimeDir = new URL('./', costTrackerUrl)
    const usage = (await import(new URL('usage-ledger.js', runtimeDir).href)) as {
      UsageLedger: UnexportedRuntime['UsageLedger']
      USAGE_LEDGER_PATH: string
    }
    const context = (await import(new URL('context-utilization.js', runtimeDir).href)) as {
      ContextUtilizationTracker: UnexportedRuntime['ContextUtilizationTracker']
    }
    if (usage.USAGE_LEDGER_PATH !== SDK_USAGE_LEDGER_DEFAULT) {
      throw new Error(`UsageLedger default path is ${usage.USAGE_LEDGER_PATH}, not ${SDK_USAGE_LEDGER_DEFAULT}.`)
    }
    return { UsageLedger: usage.UsageLedger, ContextUtilizationTracker: context.ContextUtilizationTracker, USAGE_LEDGER_PATH: usage.USAGE_LEDGER_PATH }
  })()
  return unexported
}

const sdkStorage = new InMemoryStorageProvider()
let ledger: UsageLedgerLike | undefined
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

export async function squadUsageLedger(): Promise<UsageLedgerLike> {
  if (!ledger) {
    const runtime = await loadUnexportedSquadRuntime()
    ledger = new runtime.UsageLedger(sdkStorage, SDK_USAGE_LEDGER_PATH)
  }
  return ledger
}

export async function squadContextTracker(resolveContextWindow: (model: string) => number | undefined): Promise<ContextTrackerLike> {
  const runtime = await loadUnexportedSquadRuntime()
  return new runtime.ContextUtilizationTracker({ resolveContextWindow })
}

export function squadSdkStorageSnapshot(): Map<string, string> {
  return sdkStorage.snapshot()
}

export function newCostTracker(): CostTracker {
  installedSquadSdkVersion()
  return new CostTracker()
}

let costTracker: CostTracker | undefined
export function sharedCostTracker(): CostTracker {
  costTracker ??= newCostTracker()
  return costTracker
}

export async function recordSquadUsage(event: SquadUsageEvent): Promise<void> {
  sharedCostTracker().recordUsage({
    sessionId: event.sessionId,
    agentName: event.agentName,
    model: event.model,
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    estimatedCost: event.estimatedCost,
  })
  await (await squadUsageLedger()).append(event)
}

export async function assessSquadContext(input: { sessionId: string; model: string; inputTokens: number; outputTokens: number; contextWindowTokens: number }): Promise<SquadContextSnapshot> {
  const active = await squadContextTracker(() => input.contextWindowTokens)
  const snapshot = active.recordEstimated({
    sessionId: input.sessionId,
    model: input.model,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
  })
  if (!snapshot) throw new Error('Context utilization tracker returned no snapshot.')
  return snapshot
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
