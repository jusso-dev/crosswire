import { and, desc, eq, lt, or, sql } from 'drizzle-orm'
import { getDb } from '../db/client'
import { agentRunEvents, agentRunOutputs, agentRuns } from '../db/schema'
import { env } from '../env'
import { redactValue } from '../lib/redact'
import { canonicalJson, sha256 } from './canonical'
import { releaseRunSlot } from './budgets'
import { SQUAD_SDK_PIN } from './squad-sdk'

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
