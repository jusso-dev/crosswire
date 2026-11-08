import { env } from '../env'
import { modelDescription } from './model'
import { loadPolicy } from './policy'
import { installedSquadSdkVersion, squadSdkPackageHasBackendExport, SQUAD_SDK_PIN, SDK_USAGE_LEDGER_DEFAULT, SDK_USAGE_LEDGER_PATH } from './squad-sdk'

export interface ConfigDiagnostic {
  ok: boolean
  sdk: { required: string; resolved: string; backendExport: boolean; harnessAdapter: 'absent-from-1.1.0'; copilotSeatRequired: false }
  provider: { provider: string; model: string | null; auth: string | null }
  flags: { memory: string; runs: string; egress: string; approvalBinding: string }
  budgets: { maxInputTokens: number; maxOutputTokens: number; maxInflight: number; contextWindowTokens: number; spendCapConfigured: boolean; priceConfigured: boolean }
  policy: { sha256?: string; error?: string }
  limits: string[]
}

/**
 * Startup picture of the controls that are actually wired. No secrets.
 * Output cap: TanStack AI 1.2.0 chat() has no output-cap field. Crosswire sends modelOptions.max_tokens
 * (a key the library lists in MAX_TOKENS_KEYS) and also stops the stream at BUDGET_MAX_OUTPUT_TOKENS * 4 characters.
 */
export function configurationDiagnostic(): ConfigDiagnostic {
  const e = env()
  const model = modelDescription(e)
  let policy: ConfigDiagnostic['policy'] = {}
  let ok = true
  try {
    policy = { sha256: loadPolicy().sha256 }
  } catch (err) {
    ok = false
    policy = { error: err instanceof Error ? err.message : String(err) }
  }
  let resolved = 'unresolved'
  try {
    resolved = installedSquadSdkVersion()
    if (resolved !== SQUAD_SDK_PIN) ok = false
  } catch (err) {
    ok = false
    policy = { error: policy.error ?? (err instanceof Error ? err.message : String(err)) }
  }
  if (e.BUDGET_MAX_SPEND_MICROS !== undefined && e.BUDGET_USD_PER_MILLION_TOKENS === undefined) ok = false
  return {
    ok,
    sdk: { required: SQUAD_SDK_PIN, resolved, backendExport: squadSdkPackageHasBackendExport(), harnessAdapter: 'absent-from-1.1.0', copilotSeatRequired: false },
    provider: { provider: model.provider, model: model.model, auth: model.auth },
    flags: { memory: e.MEMORY_GOVERNANCE, runs: e.RUN_LEDGER, egress: e.EGRESS_FILTER, approvalBinding: e.APPROVAL_BINDING },
    budgets: {
      maxInputTokens: e.BUDGET_MAX_INPUT_TOKENS,
      maxOutputTokens: e.BUDGET_MAX_OUTPUT_TOKENS,
      maxInflight: e.BUDGET_MAX_INFLIGHT,
      contextWindowTokens: e.BUDGET_CONTEXT_WINDOW_TOKENS,
      spendCapConfigured: e.BUDGET_MAX_SPEND_MICROS !== undefined,
      priceConfigured: e.BUDGET_USD_PER_MILLION_TOKENS !== undefined,
    },
    policy,
    limits: [
      `UsageLedger is loaded from the installed ${SQUAD_SDK_PIN} dist file because the exports map omits it. Ledger path is ${SDK_USAGE_LEDGER_PATH}, not ${SDK_USAGE_LEDGER_DEFAULT}.`,
      'ContextUtilizationTracker warns at 0.8 and does not block. Crosswire refuses the call at that threshold.',
      'SOC turns use Azure or an OpenAI-compatible endpoint. They do not use SquadClient or a Copilot seat.',
      'HarnessAdapter and preview 2.0.0-preview.3 are not imported.',
      'Token estimates from text length are a pre-call gate. The usage ledger stores provider counts only.',
      'TanStack AI 1.2.0 chat() has no output-cap field. Crosswire sends modelOptions.max_tokens and stops the stream at BUDGET_MAX_OUTPUT_TOKENS * 4 characters.',
      'pnpm may warn that @opentelemetry/api@1.10.0 does not satisfy the SDK peer range <1.10.0. The SOC import graph does not use those paths. The pin stays 1.1.0.',
    ],
  }
}
