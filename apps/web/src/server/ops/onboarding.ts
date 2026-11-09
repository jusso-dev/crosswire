import { and, count, eq, inArray, isNotNull } from 'drizzle-orm'
import { getDb } from '../db/client'
import { agentRuns, kqlProposals, orgConnectors, responseEvents, watchEntries } from '../db/schema'

export type OnboardingKey = 'tenant' | 'watch' | 'hunt' | 'agent' | 'approval'

/**
 * First-run checklist for analysts. Each step is derived from a real record, so it ticks itself
 * off. "Review an approval" counts a person's dry run, approval or rejection on a response action in this org.
 */
export async function onboardingSteps(orgId: string) {
  const db = getDb()
  const [[conn], [watch], [ran], [run], [reviewed]] = await Promise.all([
    db.select({ n: count() }).from(orgConnectors).where(eq(orgConnectors.orgId, orgId)),
    db.select({ n: count() }).from(watchEntries).where(eq(watchEntries.orgId, orgId)),
    db.select({ n: count() }).from(kqlProposals).where(and(eq(kqlProposals.orgId, orgId), isNotNull(kqlProposals.ranAt))),
    db.select({ n: count() }).from(agentRuns).where(eq(agentRuns.orgId, orgId)),
    db.select({ n: count() }).from(responseEvents).where(and(eq(responseEvents.orgId, orgId), inArray(responseEvents.event, ['dry_run', 'approved', 'rejected']))),
  ])
  const done: Record<OnboardingKey, boolean> = {
    tenant: (conn?.n ?? 0) > 0,
    watch: (watch?.n ?? 0) > 0,
    hunt: (ran?.n ?? 0) > 0,
    agent: (run?.n ?? 0) > 0,
    approval: (reviewed?.n ?? 0) > 0,
  }
  return done
}
