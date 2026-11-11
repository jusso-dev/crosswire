import { and, desc, eq, sql } from 'drizzle-orm'
import { getDb } from '../db/client'
import { agentRuns, agentUsage } from '../db/schema'
import { env } from '../env'
import { assessContextWindow, recordSquadUsage } from './squad-sdk'

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
const PG_INT_MAX = 2_147_483_647

function fitsPgInt(value: number) {
  return Number.isInteger(value) && value >= 0 && value <= PG_INT_MAX
}

export function costMicros(inputTokens: number, outputTokens: number): number | null {
  const rate = env().BUDGET_USD_PER_MILLION_TOKENS
  if (!rate) return null
  const product = rate * (inputTokens + outputTokens)
  if (!Number.isFinite(product)) return null
  const micros = Math.round(product)
  if (!fitsPgInt(micros)) return null
  return micros
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
    snapshot = assessContextWindow({
      sessionId: input.sessionId,
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
  const refused = refuseFromSpent(spent, estimatedInputTokens)
  if (refused) return refused
  return { ok: true, estimatedInputTokens, utilization: snapshot.utilization, warning: snapshot.warning }
}

function refuseFromSpent(spent: { inputTokens: number; costMicros: number; unpriced: number; unmeasured: number }, estimatedInputTokens: number): BudgetDecision | null {
  const e = env()
  if (spent.unmeasured > 0) {
    return { ok: false, reason: 'Daily usage includes a call with no token count. The daily cap cannot be checked, so the model call is refused.', estimatedInputTokens }
  }
  if (spent.inputTokens + estimatedInputTokens > e.BUDGET_DAILY_INPUT_TOKENS) {
    return { ok: false, reason: 'Daily input token budget is exhausted.', estimatedInputTokens }
  }
  if (e.BUDGET_MAX_SPEND_MICROS !== undefined && spent.unpriced > 0) {
    return { ok: false, reason: 'Daily usage includes unpriced calls. A spend cap cannot be checked, so the model call is refused.', estimatedInputTokens }
  }
  if (e.BUDGET_MAX_SPEND_MICROS !== undefined && spent.costMicros + (costMicros(estimatedInputTokens, 0) ?? 0) > e.BUDGET_MAX_SPEND_MICROS) {
    return { ok: false, reason: 'Daily spend budget is exhausted.', estimatedInputTokens }
  }
  return null
}

/**
 * Re-check the daily sums under a per-org row lock and store this run's input estimate.
 * Parallel calls then see the reservation. The row is replaced when the provider reports usage.
 */
export async function claimDailyBudget(orgId: string, runId: string, input: { sessionId: string; model: string; text: string; agentKey: string; provider: string }): Promise<BudgetDecision> {
  const preview = await checkBudget(orgId, input)
  if (!preview.ok) return preview
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`insert into agent_capacity (org_id, inflight) values (${orgId}, 0) on conflict (org_id) do nothing`)
    await tx.execute(sql`select inflight from agent_capacity where org_id = ${orgId} for update`)
    const spent = await observedToday(orgId, tx)
    const refused = refuseFromSpent(spent, preview.estimatedInputTokens)
    if (refused) return refused
    await tx.delete(agentUsage).where(and(eq(agentUsage.orgId, orgId), eq(agentUsage.runId, runId), eq(agentUsage.observed, false)))
    await tx.insert(agentUsage).values({
      orgId,
      runId,
      agentKey: input.agentKey,
      provider: input.provider,
      model: input.model,
      inputTokens: preview.estimatedInputTokens,
      outputTokens: 0,
      estimatedCostMicros: costMicros(preview.estimatedInputTokens, 0),
      observed: false,
    })
    return preview
  })
}

/**
 * Read-only desk figures from Postgres. This does not read the in-process CostTracker.
 * Daily sums include unsettled reservations, matching the gate. Context is the last observed call
 * that reported token counts, compared with BUDGET_CONTEXT_WINDOW_TOKENS at the 0.8 refusal line.
 */
export async function budgetSnapshot(orgId: string) {
  const e = env()
  const spent = await observedToday(orgId)
  const [latest] = await getDb()
    .select({
      inputTokens: agentUsage.inputTokens,
      outputTokens: agentUsage.outputTokens,
      agentKey: agentUsage.agentKey,
      createdAt: agentUsage.createdAt,
    })
    .from(agentUsage)
    .where(and(eq(agentUsage.orgId, orgId), eq(agentUsage.observed, true), sql`${agentUsage.inputTokens} is not null`, sql`${agentUsage.outputTokens} is not null`))
    .orderBy(desc(agentUsage.createdAt))
    .limit(1)
  const context = latest
    ? assessContextWindow({
        sessionId: 'desk',
        inputTokens: latest.inputTokens ?? 0,
        outputTokens: latest.outputTokens ?? 0,
        contextWindowTokens: e.BUDGET_CONTEXT_WINDOW_TOKENS,
      })
    : null
  return {
    inputTokens: spent.inputTokens,
    outputTokens: spent.outputTokens,
    costMicros: spent.costMicros,
    unpriced: spent.unpriced,
    unmeasured: spent.unmeasured,
    dailyInputCap: e.BUDGET_DAILY_INPUT_TOKENS,
    spendCapMicros: e.BUDGET_MAX_SPEND_MICROS ?? null,
    rateSet: e.BUDGET_USD_PER_MILLION_TOKENS !== undefined,
    context: context
      ? {
          agentKey: latest!.agentKey,
          at: latest!.createdAt,
          occupiedTokens: context.occupiedTokens,
          contextWindowTokens: context.contextWindowTokens,
          utilization: context.utilization,
          warning: context.warning,
        }
      : null,
  }
}

/** Drop a reservation when the model call does not start. */
export async function releaseDailyClaim(orgId: string, runId: string) {
  await getDb().delete(agentUsage).where(and(eq(agentUsage.orgId, orgId), eq(agentUsage.runId, runId), eq(agentUsage.observed, false)))
}

async function observedToday(orgId: string, exec: { execute: ReturnType<typeof getDb>['execute'] } = getDb()) {
  const res = (await exec.execute(sql`
    select coalesce(sum(input_tokens), 0)::int as input_tokens,
           coalesce(sum(output_tokens), 0)::int as output_tokens,
           coalesce(sum(estimated_cost_micros), 0)::int as cost_micros,
           coalesce(sum(case when estimated_cost_micros is null then 1 else 0 end), 0)::int as unpriced,
           coalesce(sum(case when input_tokens is null then 1 else 0 end), 0)::int as unmeasured
    from agent_usage
    where org_id = ${orgId}
      and created_at >= (date_trunc('day', now() at time zone 'utc') at time zone 'utc')
  `)) as unknown as Array<{ input_tokens: number; output_tokens: number; cost_micros: number; unpriced: number; unmeasured: number }> | { rows: Array<{ input_tokens: number; output_tokens: number; cost_micros: number; unpriced: number; unmeasured: number }> }
  const row = Array.isArray(res) ? res[0] : res.rows[0]
  return {
    inputTokens: Number(row?.input_tokens ?? 0),
    outputTokens: Number(row?.output_tokens ?? 0),
    costMicros: Number(row?.cost_micros ?? 0),
    unpriced: Number(row?.unpriced ?? 0),
    unmeasured: Number(row?.unmeasured ?? 0),
  }
}

type Exec = Pick<ReturnType<typeof getDb>, 'execute'>

function firstRow<T>(res: unknown): T | undefined {
  const r = res as T[] | { rows: T[] }
  return Array.isArray(r) ? r[0] : r.rows[0]
}

async function incrementSlot(exec: Exec, orgId: string, max: number) {
  return firstRow<{ inflight: number }>(
    await exec.execute(sql`
      insert into agent_capacity as c (org_id, inflight) values (${orgId}, 1)
      on conflict (org_id) do update set inflight = c.inflight + 1
      where c.inflight < ${max}
      returning inflight
    `),
  )
}

async function decrementSlot(exec: Exec, orgId: string) {
  await exec.execute(sql`update agent_capacity set inflight = greatest(inflight - 1, 0) where org_id = ${orgId}`)
}

/** Atomic shared slot. A database error refuses the call. */
export async function acquireSlot(orgId: string) {
  const max = env().BUDGET_MAX_INFLIGHT
  try {
    const row = await incrementSlot(getDb(), orgId, max)
    if (!row) throw new BudgetError(`Org is at the shared inflight limit (${max}).`)
    return { orgId, inflight: Number(row.inflight) }
  } catch (err) {
    if (err instanceof BudgetError) throw err
    throw new BudgetError(`Capacity check failed closed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

export async function releaseSlot(orgId: string) {
  await decrementSlot(getDb(), orgId)
}

/**
 * Return this run's slot at most once, including when another process already returned it.
 * A run that never held a slot does not decrement. The row claim and the decrement are one
 * transaction (#191), so a failure leaves both as they were and a retry can return the slot.
 * Locks go capacity row first, then run row, the same order as acquireRunSlot.
 */
export async function releaseRunSlot(orgId: string, runId: string) {
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`select inflight from agent_capacity where org_id = ${orgId} for update`)
    const [row] = await tx
      .update(agentRuns)
      .set({ slotReleased: true })
      .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.id, runId), eq(agentRuns.slotHeld, true), eq(agentRuns.slotReleased, false)))
      .returning({ id: agentRuns.id })
    if (row) await decrementSlot(tx, orgId)
    return Boolean(row)
  })
}

/**
 * Take a capacity slot. When a run id is known, the increment and the row's `slot_held` claim are
 * one transaction (#191): if either fails, neither is kept.
 */
export async function acquireRunSlot(orgId: string, runId?: string | null) {
  if (!runId) return acquireSlot(orgId)
  const max = env().BUDGET_MAX_INFLIGHT
  try {
    return await getDb().transaction(async (tx) => {
      const row = await incrementSlot(tx, orgId, max)
      if (!row) throw new BudgetError(`Org is at the shared inflight limit (${max}).`)
      const [marked] = await tx
        .update(agentRuns)
        .set({ slotHeld: true })
        .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.id, runId), eq(agentRuns.slotHeld, false), eq(agentRuns.slotReleased, false)))
        .returning({ id: agentRuns.id })
      if (!marked) throw new BudgetError('Run slot could not be claimed.')
      return { orgId, inflight: Number(row.inflight) }
    })
  } catch (err) {
    if (err instanceof BudgetError) throw err
    throw new BudgetError(`Run slot could not be claimed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * One acquisition, one decrement. A second call, including one already in flight, waits on the same release.
 * With a run id, the decrement is the row claim, so another process cannot decrement it again.
 * A failed release is not cached: the next call tries again (#191).
 * Without a run id (legacy ledger, no row), only this closure decrements. A crash can leave that slot taken.
 */
export function releaseOnce(orgId: string, runId?: string | null) {
  let pending: Promise<void> | undefined
  return () => {
    if (pending) return pending
    pending = (runId ? releaseRunSlot(orgId, runId) : releaseSlot(orgId)).then(
      () => undefined,
      (err: unknown) => {
        pending = undefined
        throw err
      },
    )
    return pending
  }
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

/**
 * Persist provider-reported tokens only. One observed row per run: a later cumulative report replaces the earlier one.
 * A missing rate stores null. It does not store 0, and it does not tell CostTracker the call was free.
 * Counts that do not fit in a Postgres integer become the unmeasured marker when a run id is known.
 */
export async function recordObservedUsage(usage: ObservedUsage) {
  if (!fitsPgInt(usage.inputTokens) || !fitsPgInt(usage.outputTokens)) {
    if (!usage.runId) return null
    return recordUnmeasuredUsage({ orgId: usage.orgId, runId: usage.runId, agentKey: usage.agentKey, provider: usage.provider, model: usage.model })
  }
  const micros = costMicros(usage.inputTokens, usage.outputTokens)
  const db = getDb()
  if (usage.runId) await db.delete(agentUsage).where(and(eq(agentUsage.orgId, usage.orgId), eq(agentUsage.runId, usage.runId), eq(agentUsage.observed, false)))
  const [existing] = usage.runId
    ? await db
        .select()
        .from(agentUsage)
        .where(and(eq(agentUsage.orgId, usage.orgId), eq(agentUsage.runId, usage.runId), eq(agentUsage.observed, true)))
        .limit(1)
    : []
  const [row] = existing
    ? await db
        .update(agentUsage)
        .set({ agentKey: usage.agentKey, provider: usage.provider, model: usage.model, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, estimatedCostMicros: micros })
        .where(eq(agentUsage.id, existing.id))
        .returning()
    : await db
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
  const previousIn = existing?.inputTokens ?? 0
  const previousOut = existing?.outputTokens ?? 0
  const deltaIn = usage.inputTokens - previousIn
  const deltaOut = usage.outputTokens - previousOut
  const deltaMicros = deltaIn >= 0 && deltaOut >= 0 ? costMicros(deltaIn, deltaOut) : null
  if (deltaMicros !== null && (deltaIn > 0 || deltaOut > 0)) {
    recordSquadUsage({
      orgId: usage.orgId,
      sessionId: usage.runId ?? usage.orgId,
      agentName: usage.agentKey,
      model: usage.model,
      inputTokens: deltaIn,
      outputTokens: deltaOut,
      estimatedCost: deltaMicros / 1_000_000,
    })
  }
  return row!
}

/**
 * A model call started and the provider reported no usable token counts. Nulls keep the daily cap
 * fail-closed. This is not written for a refusal that happened before the call. Explicit 0 from
 * recordObservedUsage is a real count. A 0/0 report on a turn that already has assistant text is this marker.
 * A reservation for the same run is removed so the estimate is not counted as well.
 */
export async function recordUnmeasuredUsage(usage: { orgId: string; runId: string; agentKey: string; provider: string; model: string }) {
  const db = getDb()
  await db.delete(agentUsage).where(and(eq(agentUsage.orgId, usage.orgId), eq(agentUsage.runId, usage.runId), eq(agentUsage.observed, false)))
  const existing = (await db.execute(sql`
    select 1 as ok from agent_usage where run_id = ${usage.runId} and org_id = ${usage.orgId} and observed = true limit 1
  `)) as unknown as Array<{ ok: number }> | { rows: Array<{ ok: number }> }
  const found = Array.isArray(existing) ? existing[0] : existing.rows[0]
  if (found) return null
  const [row] = await getDb()
    .insert(agentUsage)
    .values({
      orgId: usage.orgId,
      runId: usage.runId,
      agentKey: usage.agentKey,
      provider: usage.provider,
      model: usage.model,
      inputTokens: null,
      outputTokens: null,
      estimatedCostMicros: null,
      observed: true,
    })
    .returning()
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

/**
 * Add up the counts from every RUN_FINISHED in a finished turn (#185). Each one carries a single model
 * call's usage, so a turn with tool calls has several. Null when none of them has a count.
 */
export function usageFromChunks(chunks: Iterable<unknown>): { inputTokens: number; outputTokens: number } | null {
  let total: { inputTokens: number; outputTokens: number } | null = null
  for (const chunk of chunks) {
    if (!chunk || typeof chunk !== 'object' || (chunk as { type?: unknown }).type !== 'RUN_FINISHED') continue
    const usage = usageFromChunk(chunk)
    if (!usage) continue
    total = { inputTokens: (total?.inputTokens ?? 0) + usage.inputTokens, outputTokens: (total?.outputTokens ?? 0) + usage.outputTokens }
  }
  return total
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
