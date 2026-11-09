import { and, desc, eq, inArray, lt, or, sql } from 'drizzle-orm'
import { getDb } from '../db/client'
import { agentRunEvents, agentRunOutputs, agentRuns, agentUsage, chatThreads } from '../db/schema'
import { env } from '../env'
import { redactValue } from '../lib/redact'
import { canonicalJson, sha256 } from './canonical'
import { releaseRunSlot } from './budgets'
import { SQUAD_SDK_PIN } from './squad-sdk'
import { asJson } from '../../shared/json'

export type RunStatus = 'running' | 'completed' | 'failed' | 'interrupted'

export interface StartRunInput {
  orgId: string
  agentKey: string
  threadId?: string | null
  parentRunId?: string | null
  modelProvider?: string | null
  modelName?: string | null
  charterSha256?: string | null
  policySha256?: string | null
  toolsetSha256?: string | null
  memorySha256?: string | null
}

function ledgerEnforced() {
  return env().RUN_LEDGER !== 'legacy'
}

export async function startRun(input: StartRunInput) {
  if (!ledgerEnforced()) return null
  const [row] = await getDb()
    .insert(agentRuns)
    .values({
      orgId: input.orgId,
      agentKey: input.agentKey,
      threadId: input.threadId ?? null,
      parentRunId: input.parentRunId ?? null,
      modelProvider: input.modelProvider ?? null,
      modelName: input.modelName ?? null,
      charterSha256: input.charterSha256 ?? null,
      policySha256: input.policySha256 ?? null,
      toolsetSha256: input.toolsetSha256 ?? null,
      memorySha256: input.memorySha256 ?? null,
      sdkVersion: SQUAD_SDK_PIN,
    })
    .returning()
  await appendRunEvent(row!.id, input.orgId, 'started', { agentKey: input.agentKey, parentRunId: input.parentRunId ?? null })
  return row!
}

export async function appendRunEvent(runId: string, orgId: string, kind: string, payload: Record<string, unknown> = {}) {
  if (!ledgerEnforced()) return
  const db = getDb()
  await db.transaction(async (tx) => {
    const [max] = await tx
      .select({ n: sql<number>`coalesce(max(${agentRunEvents.seq}), 0)` })
      .from(agentRunEvents)
      .where(eq(agentRunEvents.runId, runId))
    const seq = Number(max?.n ?? 0) + 1
    await tx.insert(agentRunEvents).values({ orgId, runId, seq, kind, payload })
  })
}

/**
 * Full protected result. This is the replay record. It is not cut to 1000 characters.
 * Secrets are redacted. Samples stay until the sample retention job clears them.
 * RUN_LEDGER=legacy skips this write, so that mode has no replay row.
 */
export async function recordRunOutput(runId: string, orgId: string, kind: string, value: unknown) {
  if (!ledgerEnforced()) return null
  const redacted = redactValue(value)
  const body = typeof redacted === 'string' ? redacted : canonicalJson(redacted)
  const [row] = await getDb()
    .insert(agentRunOutputs)
    .values({ orgId, runId, kind, body, contentSha256: sha256(body) })
    .returning()
  return row!
}

export async function getRun(orgId: string, runId: string) {
  const [row] = await getDb().select().from(agentRuns).where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.id, runId))).limit(1)
  return row ?? null
}

export async function listRunEvents(orgId: string, runId: string) {
  return getDb().select().from(agentRunEvents).where(and(eq(agentRunEvents.orgId, orgId), eq(agentRunEvents.runId, runId))).orderBy(agentRunEvents.seq)
}

export async function listRunOutputs(orgId: string, runId: string) {
  return getDb().select().from(agentRunOutputs).where(and(eq(agentRunOutputs.orgId, orgId), eq(agentRunOutputs.runId, runId)))
}

export async function listRecentRuns(orgId: string, limit = 20) {
  return getDb()
    .select({ id: agentRuns.id, agentKey: agentRuns.agentKey, status: agentRuns.status, startedAt: agentRuns.startedAt })
    .from(agentRuns)
    .where(eq(agentRuns.orgId, orgId))
    .orderBy(desc(agentRuns.startedAt))
    .limit(Math.min(Math.max(limit, 1), 50))
}

export const RUN_STATUSES = ['running', 'completed', 'failed', 'interrupted'] as const

type RunRow = typeof agentRuns.$inferSelect

/** Observed tokens and cost per run. A reservation (observed=false) is only an estimate. */
async function usageFor(orgId: string, runIds: string[]) {
  if (runIds.length === 0) return new Map<string, { inputTokens: number | null; outputTokens: number | null; costMicros: number | null; observed: boolean }>()
  const rows = await getDb()
    .select({ runId: agentUsage.runId, inputTokens: agentUsage.inputTokens, outputTokens: agentUsage.outputTokens, costMicros: agentUsage.estimatedCostMicros, observed: agentUsage.observed })
    .from(agentUsage)
    .where(and(eq(agentUsage.orgId, orgId), inArray(agentUsage.runId, runIds)))
  const out = new Map<string, { inputTokens: number | null; outputTokens: number | null; costMicros: number | null; observed: boolean }>()
  for (const row of rows) {
    if (!row.runId) continue
    const prev = out.get(row.runId)
    // An observed row wins over a reservation for the same run.
    if (prev?.observed && !row.observed) continue
    out.set(row.runId, { inputTokens: row.inputTokens, outputTokens: row.outputTokens, costMicros: row.costMicros, observed: row.observed })
  }
  return out
}

function summarise(row: RunRow, usage: Awaited<ReturnType<typeof usageFor>>) {
  const u = usage.get(row.id)
  return {
    id: row.id,
    parentRunId: row.parentRunId,
    threadId: row.threadId,
    agentKey: row.agentKey,
    status: row.status,
    modelProvider: row.modelProvider,
    modelName: row.modelName,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    durationMs: row.finishedAt ? row.finishedAt.getTime() - row.startedAt.getTime() : null,
    cancelRequested: Boolean(row.cancelRequestedAt),
    error: row.error,
    inputTokens: u?.inputTokens ?? null,
    outputTokens: u?.outputTokens ?? null,
    costMicros: u?.costMicros ?? null,
    usageObserved: u?.observed ?? false,
  }
}

export type RunSummary = ReturnType<typeof summarise>

/** Runs for the run view, newest first. Filters are optional. Only this organisation's rows. */
export async function listRuns(orgId: string, filter: { status?: RunStatus; agentKey?: string; threadId?: string; limit?: number } = {}) {
  const conds = [eq(agentRuns.orgId, orgId)]
  if (filter.status) conds.push(eq(agentRuns.status, filter.status))
  if (filter.agentKey) conds.push(eq(agentRuns.agentKey, filter.agentKey))
  if (filter.threadId) conds.push(eq(agentRuns.threadId, filter.threadId))
  const rows = await getDb()
    .select()
    .from(agentRuns)
    .where(and(...conds))
    .orderBy(desc(agentRuns.startedAt))
    .limit(Math.min(Math.max(filter.limit ?? 50, 1), 200))
  const usage = await usageFor(orgId, rows.map((row) => row.id))
  return rows.map((row) => summarise(row, usage))
}

export async function countRunning(orgId: string) {
  const [row] = await getDb()
    .select({ n: sql<number>`count(*)::int` })
    .from(agentRuns)
    .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.status, 'running')))
  return Number(row?.n ?? 0)
}

/**
 * One run with its ordered events, redacted outputs, parent and children (delegation).
 * Outputs are the stored redacted bodies. Nothing is re-read from the model. Null outside this org.
 */
export async function readRunDetail(orgId: string, runId: string) {
  const run = await getRun(orgId, runId)
  if (!run) return null
  const [events, outputs, children, parent] = await Promise.all([
    listRunEvents(orgId, runId),
    listRunOutputs(orgId, runId),
    getDb().select().from(agentRuns).where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.parentRunId, runId))).orderBy(agentRuns.startedAt),
    run.parentRunId ? getRun(orgId, run.parentRunId) : Promise.resolve(null),
  ])
  const usage = await usageFor(orgId, [run.id, ...children.map((c) => c.id), ...(parent ? [parent.id] : [])])
  return {
    run: { ...summarise(run, usage), policySha256: run.policySha256, charterSha256: run.charterSha256, toolsetSha256: run.toolsetSha256, memorySha256: run.memorySha256, sdkVersion: run.sdkVersion },
    parent: parent ? summarise(parent, usage) : null,
    children: children.map((c) => summarise(c, usage)),
    events: events.map((e) => ({ id: e.id, seq: e.seq, kind: e.kind, payload: asJson(e.payload), createdAt: e.createdAt.toISOString() })),
    outputs: outputs
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((o) => ({ id: o.id, kind: o.kind, body: o.body, createdAt: o.createdAt.toISOString() })),
  }
}

export class RunCancelForbiddenError extends Error {}

/**
 * Stop a running run. Allowed for the person whose conversation started it, or an owner or approver.
 * The live process sees cancel_requested_at within a poll and aborts with reason `cancelled`, and the
 * row ends `interrupted`. Returns the status after the request.
 */
export async function cancelRunAs(orgId: string, actor: { userId: string; canApprove: boolean }, runId: string) {
  const run = await getRun(orgId, runId)
  if (!run) throw new Error('Run not found.')
  if (!actor.canApprove) {
    // Walk up to the root run: a specialist row carries the same thread id as its parent.
    const threadId = run.threadId
    const [thread] = threadId
      ? await getDb().select({ userId: chatThreads.userId }).from(chatThreads).where(and(eq(chatThreads.orgId, orgId), eq(chatThreads.id, threadId))).limit(1)
      : []
    if (!thread || thread.userId !== actor.userId) throw new RunCancelForbiddenError('Only the person who started this run, or an owner or approver, can stop it.')
  }
  if (run.status !== 'running') return { status: run.status, requested: false }
  await requestRunCancel(orgId, runId)
  return { status: 'running' as const, requested: true }
}

/** Full redacted replay for one run. Null when the run is not in this organisation. */
export async function readRunReplay(orgId: string, runId: string) {
  const run = await getRun(orgId, runId)
  if (!run) return null
  const outputs = await listRunOutputs(orgId, runId)
  return {
    id: run.id,
    agentKey: run.agentKey,
    status: run.status,
    startedAt: run.startedAt.toISOString(),
    outputs: outputs.map((row) => ({ id: row.id, kind: row.kind, body: row.body })),
  }
}

/** Terminal transition only from running, so a second finish is a no-op. */
export async function finishRun(orgId: string, runId: string, status: Exclude<RunStatus, 'running'>, error?: string | null) {
  if (!ledgerEnforced()) return null
  const [row] = await getDb()
    .update(agentRuns)
    .set({ status, finishedAt: new Date(), error: error ?? null })
    .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.id, runId), eq(agentRuns.status, 'running')))
    .returning()
  if (row) await appendRunEvent(runId, orgId, status, { error: error ?? null })
  return row ?? null
}

export async function requestRunCancel(orgId: string, runId: string) {
  if (!ledgerEnforced()) return
  const [row] = await getDb()
    .update(agentRuns)
    .set({ cancelRequestedAt: new Date() })
    .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.id, runId), or(eq(agentRuns.status, 'running'), and(eq(agentRuns.status, 'interrupted'), sql`${agentRuns.cancelRequestedAt} is null`))))
    .returning({ id: agentRuns.id })
  if (row) await appendRunEvent(runId, orgId, 'cancel_requested', {})
}

/**
 * Mark timed-out or cancelled running rows interrupted, then return the slot each of those
 * rows actually held. This does not rewrite any org's inflight count from the rows still running.
 * A run that never acquired a slot does not decrement. A second reconcile finds the claim already taken.
 */
export async function reconcileStaleRuns(now = new Date()) {
  if (!ledgerEnforced()) return { interrupted: 0 }
  const cutoff = new Date(now.getTime() - env().AGENT_TIMEOUT_MS)
  const stale = await getDb()
    .update(agentRuns)
    .set({ status: 'interrupted', finishedAt: now, error: 'reconciled after timeout or cancellation' })
    .where(and(eq(agentRuns.status, 'running'), lt(agentRuns.startedAt, cutoff)))
    .returning({ id: agentRuns.id, orgId: agentRuns.orgId })
  const cancelled = await getDb()
    .update(agentRuns)
    .set({ status: 'interrupted', finishedAt: now, error: 'reconciled after cancellation' })
    .where(and(eq(agentRuns.status, 'running'), sql`${agentRuns.cancelRequestedAt} is not null`))
    .returning({ id: agentRuns.id, orgId: agentRuns.orgId })
  for (const row of [...stale, ...cancelled]) {
    await appendRunEvent(row.id, row.orgId, 'interrupted', { reason: 'reconcile' })
    await releaseRunSlot(row.orgId, row.id)
  }
  return { interrupted: stale.length + cancelled.length }
}
