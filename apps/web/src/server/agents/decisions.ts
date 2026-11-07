import { and, desc, eq, ilike, inArray, lt, or, type SQL } from 'drizzle-orm'
import { getDb } from '../db/client'
import { agentDecisions } from '../db/schema'
import { redactString, truncate } from '../lib/redact'

export interface DecisionInput {
  orgId: string
  actorType: 'agent' | 'user' | 'system'
  actorKey: string
  action: string
  input?: unknown
  output?: unknown
  threadId?: string | null
  huntId?: string | null
}

const summarise = (value: unknown) =>
  value === undefined ? '' : truncate(redactString(typeof value === 'string' ? value : JSON.stringify(value)), 1000)

/** Append a decision row (#33). Inputs and outputs are redacted and truncated. */
export async function recordDecision(d: DecisionInput) {
  await getDb()
    .insert(agentDecisions)
    .values({
      orgId: d.orgId,
      actorType: d.actorType,
      actorKey: d.actorKey,
      action: d.action,
      inputSummary: summarise(d.input),
      outputSummary: summarise(d.output),
      threadId: d.threadId ?? null,
      huntId: d.huntId ?? null,
    })
}

/**
 * Searchable, paged decision log for the whole history (org-scoped). `before` is a cursor: the
 * createdAt of the last row on the previous page. `actions` lets a caller match display labels too.
 */
export async function searchDecisions(orgId: string, opts: { q?: string; actor?: string; actions?: string[]; before?: Date; limit?: number }) {
  const conds: SQL[] = [eq(agentDecisions.orgId, orgId)]
  if (opts.actor) conds.push(eq(agentDecisions.actorKey, opts.actor))
  if (opts.before) conds.push(lt(agentDecisions.createdAt, opts.before))
  const q = opts.q?.trim()
  if (q) {
    const like = `%${q.replace(/[%_\\]/g, '\\$&')}%`
    const text = or(ilike(agentDecisions.action, like), ilike(agentDecisions.inputSummary, like), ilike(agentDecisions.outputSummary, like), ...(opts.actions?.length ? [inArray(agentDecisions.action, opts.actions)] : []))
    if (text) conds.push(text)
  }
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 200)
  const rows = await getDb().select().from(agentDecisions).where(and(...conds)).orderBy(desc(agentDecisions.createdAt)).limit(limit + 1)
  return { rows: rows.slice(0, limit), hasMore: rows.length > limit }
}

/** Distinct actors in this org's log, for the actor filter (not limited to the current page). */
export async function decisionActors(orgId: string) {
  const rows = await getDb().selectDistinct({ actorKey: agentDecisions.actorKey, actorType: agentDecisions.actorType }).from(agentDecisions).where(eq(agentDecisions.orgId, orgId)).limit(500)
  return rows
}

export async function listDecisions(orgId: string, opts: { limit?: number; threadId?: string } = {}) {
  const where = opts.threadId ? and(eq(agentDecisions.orgId, orgId), eq(agentDecisions.threadId, opts.threadId)) : eq(agentDecisions.orgId, orgId)
  return getDb()
    .select()
    .from(agentDecisions)
    .where(where)
    .orderBy(desc(agentDecisions.createdAt))
    .limit(Math.min(opts.limit ?? 50, 200))
}
