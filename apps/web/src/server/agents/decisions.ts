import { and, desc, eq } from 'drizzle-orm'
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

export async function listDecisions(orgId: string, opts: { limit?: number; threadId?: string } = {}) {
  const where = opts.threadId ? and(eq(agentDecisions.orgId, orgId), eq(agentDecisions.threadId, opts.threadId)) : eq(agentDecisions.orgId, orgId)
  return getDb()
    .select()
    .from(agentDecisions)
    .where(where)
    .orderBy(desc(agentDecisions.createdAt))
    .limit(Math.min(opts.limit ?? 50, 200))
}
