import { createServerFn } from '@tanstack/react-start'
import { authed } from './middleware'
import { listDecisions } from '../server/agents/decisions'
import { controlPanel } from '../server/ops/overview'
import { onboardingSteps } from '../server/ops/onboarding'

/** Home control panel (#24): threat feeds, emerging threats, watch hits, hunts and decisions waiting. */
export const fetchDashboard = createServerFn({ method: 'GET' })
  .middleware([authed])
  .handler(async ({ context }) => {
    const orgId = context.session.org.id
    const [panel, decisions, onboarding] = await Promise.all([controlPanel(orgId), listDecisions(orgId, { limit: 6 }), onboardingSteps(orgId)])
    return {
      ...panel,
      onboarding,
      agentActivity: decisions.map((d) => ({ id: d.id, actor: d.actorKey, actorType: d.actorType, action: d.action, createdAt: d.createdAt.toISOString() })),
    }
  })
