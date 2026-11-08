import { and, eq, lt, sql } from 'drizzle-orm'
import { getDb } from '../db/client'
import { agentRunEvents, agentRunOutputs, agentRuns } from '../db/schema'
import { env } from '../env'
import { canonicalJson, sha256 } from './canonical'
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

/** Full protected result. This is the replay record. It is not cut to 1000 characters. */
export async function recordRunOutput(runId: string, orgId: string, kind: string, value: unknown) {
  if (!ledgerEnforced()) return null
  const body = typeof value === 'string' ? value : canonicalJson(value)
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
  await getDb()
    .update(agentRuns)
    .set({ cancelRequestedAt: new Date() })
    .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.id, runId), eq(agentRuns.status, 'running')))
  await appendRunEvent(runId, orgId, 'cancel_requested', {})
}

/**
 * Mark timed-out or cancelled running rows interrupted, then set each org's inflight count
 * from the runs that are still running. A crashed process does not leave a slot taken forever.
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
  for (const row of [...stale, ...cancelled]) await appendRunEvent(row.id, row.orgId, 'interrupted', { reason: 'reconcile' })
  await getDb().execute(sql`
    update agent_capacity c
    set inflight = (
      select count(*)::int from agent_runs r where r.org_id = c.org_id and r.status = 'running'
    )
  `)
  return { interrupted: stale.length + cancelled.length }
}
