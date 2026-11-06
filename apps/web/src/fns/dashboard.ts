import { createServerFn } from '@tanstack/react-start'
import { authed } from './middleware'
import { countHunts } from '../server/hunting/hunts'
import { countWatchHits, countWatches } from '../server/ti/watchlists'
import { countPending } from '../server/response/proposals'
import { listDecisions } from '../server/agents/decisions'

/**
 * Dashboard counts (#24). One query interface so later phases only change these repository functions.
 */
export const fetchDashboard = createServerFn({ method: 'GET' })
  .middleware([authed])
  .handler(async ({ context }) => {
    const orgId = context.session.org.id
    const [hunts, watches, watchHits, approvals, decisions] = await Promise.all([
      countHunts(orgId),
      countWatches(orgId),
      countWatchHits(orgId),
      countPending(orgId),
      listDecisions(orgId, { limit: 5 }),
    ])
    return { hunts, watches, watchHits, approvals, recentAgentActions: decisions.length, lastAgentAction: decisions[0]?.createdAt.toISOString() ?? null }
  })
