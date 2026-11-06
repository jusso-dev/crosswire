import { createServerFn } from '@tanstack/react-start'
import { authed } from './middleware'
import { dismissSetup, setupChecklist } from '../server/ops/setup'
import { loadDemoFixtures } from '../server/ops/fixtures'
import { env } from '../server/env'

export const fetchSetup = createServerFn({ method: 'GET' })
  .middleware([authed])
  .handler(async ({ context }) => {
    const r = await setupChecklist(context.session.org.id)
    return {
      items: r.items,
      complete: r.complete,
      dismissed: r.dismissed,
      dryRun: r.safety.dryRun,
      executors: r.safety.executors,
      warnings: r.safety.warnings,
      isOwner: context.session.org.role === 'owner',
      canLoadDemo: context.session.org.role === 'owner' && env().HUNTING_DEMO_MODE && (env().NODE_ENV !== 'production' || process.env.ALLOW_DEMO_FIXTURES === 'true'),
    }
  })

export const dismissSetupFn = createServerFn({ method: 'POST' })
  .middleware([authed])
  .handler(async ({ context }) => {
    if (context.session.org.role !== 'owner') throw new Error('Only owners can dismiss the setup checklist.')
    await dismissSetup(context.session.org.id)
    return { ok: true }
  })

export const loadDemoFn = createServerFn({ method: 'POST' })
  .middleware([authed])
  .handler(async ({ context }) => {
    if (context.session.org.role !== 'owner') throw new Error('Only owners can load demo data.')
    if (env().NODE_ENV === 'production' && process.env.ALLOW_DEMO_FIXTURES !== 'true') throw new Error('Demo data is disabled in production.')
    return loadDemoFixtures(context.session.org.id, context.session.user.id)
  })
