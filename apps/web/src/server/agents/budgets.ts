import { sql } from 'drizzle-orm'
import { getDb } from '../db/client'
import { agentUsage } from '../db/schema'
import { env } from '../env'
import { assessSquadContext, recordSquadUsage } from './squad-sdk'

export class BudgetError extends Error {}

/** Character estimate used only as a pre-call gate. It is not written as observed provider usage. */
export function estimateTokens(text: string) {
  return Math.ceil(text.length / 4)
}

export function outputCharCap() {
  return env().BUDGET_MAX_OUTPUT_TOKENS * 4
}

/**
 * Dollar cost from a configured rate. Returns null when the operator did not set a rate.
 * Crosswire does not invent a price for a customer Azure deployment.
 */
export function costMicros(inputTokens: number, outputTokens: number): number | null {
  const rate = env().BUDGET_USD_PER_MILLION_TOKENS
  if (!rate) return null
  return Math.round(rate * (inputTokens + outputTokens))
}

export interface BudgetDecision {
  ok: boolean
  reason?: string
  estimatedInputTokens: number
  utilization?: number
  warning?: boolean
}

/**
 * Fail closed when the estimate, the context warning, the daily observed input, or a configured
 * spend cap would be exceeded. The Squad context tracker only warns; this function blocks.
 * Same-provider only: this does not select a fallback provider.
 */
export async function checkBudget(orgId: string, input: { sessionId: string; model: string; text: string }): Promise<BudgetDecision> {
  const e = env()
  if (e.BUDGET_MAX_SPEND_MICROS !== undefined && e.BUDGET_USD_PER_MILLION_TOKENS === undefined) {
    return { ok: false, reason: 'Spend cap is set but BUDGET_USD_PER_MILLION_TOKENS is not. Refusing the model call.', estimatedInputTokens: 0 }
  }
  const estimatedInputTokens = estimateTokens(input.text)
  if (estimatedInputTokens > e.BUDGET_MAX_INPUT_TOKENS) {
    return { ok: false, reason: `Input estimate ${estimatedInputTokens} exceeds BUDGET_MAX_INPUT_TOKENS.`, estimatedInputTokens }
  }
  let snapshot
  try {
    snapshot = await assessSquadContext({
      sessionId: input.sessionId,
      model: input.model,
      inputTokens: estimatedInputTokens,
      outputTokens: 0,
      contextWindowTokens: e.BUDGET_CONTEXT_WINDOW_TOKENS,
    })
  } catch (err) {
    return { ok: false, reason: `Context budget unavailable: ${err instanceof Error ? err.message : String(err)}`, estimatedInputTokens }
  }
  if (snapshot.warning || snapshot.utilization >= snapshot.warningThreshold) {
    return { ok: false, reason: `Context utilization ${snapshot.utilization.toFixed(2)} is at the ${snapshot.warningThreshold} warning. The SDK does not block; Crosswire does.`, estimatedInputTokens, utilization: snapshot.utilization, warning: snapshot.warning }
  }
  const spent = await observedToday(orgId)
  if (spent.inputTokens + estimatedInputTokens > e.BUDGET_DAILY_INPUT_TOKENS) {
    return { ok: false, reason: 'Daily input token budget is exhausted.', estimatedInputTokens }
  }
  if (e.BUDGET_MAX_SPEND_MICROS !== undefined && spent.costMicros + (costMicros(estimatedInputTokens, 0) ?? 0) > e.BUDGET_MAX_SPEND_MICROS) {
    return { ok: false, reason: 'Daily spend budget is exhausted.', estimatedInputTokens }
  }
  return { ok: true, estimatedInputTokens, utilization: snapshot.utilization, warning: snapshot.warning }
}

async function observedToday(orgId: string) {
  const res = (await getDb().execute(sql`
    select coalesce(sum(input_tokens), 0)::int as input_tokens,
           coalesce(sum(output_tokens), 0)::int as output_tokens,
           coalesce(sum(estimated_cost_micros), 0)::int as cost_micros
    from agent_usage
    where org_id = ${orgId} and observed = true
      and created_at >= (date_trunc('day', now() at time zone 'utc') at time zone 'utc')
  `)) as unknown as Array<{ input_tokens: number; output_tokens: number; cost_micros: number }> | { rows: Array<{ input_tokens: number; output_tokens: number; cost_micros: number }> }
  const row = Array.isArray(res) ? res[0] : res.rows[0]
  return { inputTokens: Number(row?.input_tokens ?? 0), outputTokens: Number(row?.output_tokens ?? 0), costMicros: Number(row?.cost_micros ?? 0) }
}

/** Atomic shared slot. A database error refuses the call. */
export async function acquireSlot(orgId: string) {
  const max = env().BUDGET_MAX_INFLIGHT
  try {
    const res = (await getDb().execute(sql`
      insert into agent_capacity as c (org_id, inflight) values (${orgId}, 1)
      on conflict (org_id) do update set inflight = c.inflight + 1
      where c.inflight < ${max}
      returning inflight
    `)) as unknown as Array<{ inflight: number }> | { rows: Array<{ inflight: number }> }
    const row = Array.isArray(res) ? res[0] : res.rows[0]
    if (!row) throw new BudgetError(`Org is at the shared inflight limit (${max}).`)
    return { orgId, inflight: Number(row.inflight) }
  } catch (err) {
    if (err instanceof BudgetError) throw err
    throw new BudgetError(`Capacity check failed closed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

export async function releaseSlot(orgId: string) {
  await getDb().execute(sql`update agent_capacity set inflight = greatest(inflight - 1, 0) where org_id = ${orgId}`)
}

export interface ObservedUsage {
  orgId: string
  runId?: string | null
  agentKey: string
  provider: string
  model: string
  inputTokens: number
  outputTokens: number
}

/** Persist provider-reported tokens only. Missing usage is not filled in. */
export async function recordObservedUsage(usage: ObservedUsage) {
  if (!Number.isInteger(usage.inputTokens) || !Number.isInteger(usage.outputTokens) || usage.inputTokens < 0 || usage.outputTokens < 0) return null
  const micros = costMicros(usage.inputTokens, usage.outputTokens)
  const [row] = await getDb()
    .insert(agentUsage)
    .values({
      orgId: usage.orgId,
      runId: usage.runId ?? null,
      agentKey: usage.agentKey,
      provider: usage.provider,
      model: usage.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      estimatedCostMicros: micros,
      observed: true,
    })
    .returning()
  await recordSquadUsage({
    type: 'usage',
    sessionId: usage.runId ?? usage.orgId,
    agentName: usage.agentKey,
    model: usage.model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    estimatedCost: micros === null ? 0 : micros / 1_000_000,
    timestamp: new Date(),
  })
  return row!
}

/**
 * Read token counts the provider actually returned. TanStack puts them on RUN_FINISHED.usage.
 * Returns null when the chunk has no integer counts.
 */
export function usageFromChunk(chunk: unknown): { inputTokens: number; outputTokens: number } | null {
  if (!chunk || typeof chunk !== 'object' || !('usage' in chunk)) return null
  const usage = (chunk as { usage?: unknown }).usage
  if (!usage) return null
  if (Array.isArray(usage)) {
    let input = 0
    let output = 0
    let seen = false
    for (const item of usage) {
      if (!item || typeof item !== 'object') continue
      const row = item as Record<string, unknown>
      const inTokens = integer(row.inputTokens ?? row.promptTokens)
      const outTokens = integer(row.outputTokens ?? row.completionTokens)
      if (inTokens === null || outTokens === null) continue
      input += inTokens
      output += outTokens
      seen = true
    }
    return seen ? { inputTokens: input, outputTokens: output } : null
  }
  if (typeof usage !== 'object') return null
  const row = usage as Record<string, unknown>
  const inputTokens = integer(row.promptTokens ?? row.inputTokens)
  const outputTokens = integer(row.completionTokens ?? row.outputTokens)
  if (inputTokens === null || outputTokens === null) return null
  return { inputTokens, outputTokens }
}

function integer(value: unknown) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
}

/** Fallback stays on the configured provider. There is no silent switch to another vendor. */
export function providerFallback(provider: string) {
  if (provider === 'azure' || provider === 'openai-compatible' || provider === 'off') {
    return { provider, switched: false, reason: 'Same-provider only. No fallback to a different vendor.' }
  }
  return { provider: 'off', switched: false, reason: `Unknown provider ${provider} is not used.` }
}
