import { createServerFn } from '@tanstack/react-start'
import { deleteCookie, getCookie } from '@tanstack/react-start/server'
import { authed } from './middleware'
import { dismissSetup, restoreSetup, setupChecklist } from '../server/ops/setup'
import { loadDemoFixtures } from '../server/ops/fixtures'
import { env } from '../server/env'

/**
 * Per-person "Hide checklist" lives in a cookie, not localStorage, so the loader can read it and the
 * first paint is already right (#165). The browser writes it at once (no request to race a reload).
 * It holds the user id, so a shared browser does not hide the checklist for the next person.
 * Not a secret and not used for any access decision.
 */
export const SETUP_HIDDEN_COOKIE = 'cw-setup-hidden'

function hiddenForMe(userId: string) {
  return getCookie(SETUP_HIDDEN_COOKIE) === userId
}

export const fetchSetup = createServerFn({ method: 'GET' })
  .middleware([authed])
  .handler(async ({ context }) => {
    const r = await setupChecklist(context.session.org.id)
    return {
      items: r.items,
      complete: r.complete,
      dismissed: r.dismissed,
      hiddenForMe: hiddenForMe(context.session.user.id),
      dryRun: r.safety.dryRun,
      safety: r.safetyStatus,
      connector: r.connector,
      warnings: [...r.safety.warnings, ...r.approvalWarnings],
      isOwner: context.session.org.role === 'owner',
      canLoadDemo: context.session.org.role === 'owner' && env().HUNTING_DEMO_MODE && (env().NODE_ENV !== 'production' || process.env.ALLOW_DEMO_FIXTURES === 'true'),
      // "Now" for relative times on the page, taken once on the server so the browser renders the same words.
      now: Date.now(),
    }
  })

/** What Settings needs: whether the connector has worked, and whether the setup steps are hidden. */
export const fetchSetupState = createServerFn({ method: 'GET' })
  .middleware([authed])
  .handler(async ({ context }) => {
    const r = await setupChecklist(context.session.org.id)
    return { connector: r.connector, dismissed: r.dismissed, hiddenForMe: hiddenForMe(context.session.user.id), isOwner: context.session.org.role === 'owner', approvalWarnings: r.approvalWarnings, now: Date.now() }
  })

export const dismissSetupFn = createServerFn({ method: 'POST' })
  .middleware([authed])
  .handler(async ({ context }) => {
    if (context.session.org.role !== 'owner') throw new Error('Only owners can dismiss the setup checklist.')
    await dismissSetup(context.session.org.id)
    return { ok: true }
  })

/**
 * "Show setup steps again" (#165). Everyone can bring the steps back for themselves; an owner also
 * clears the organisation-wide dismissal.
 */
export const restoreSetupFn = createServerFn({ method: 'POST' })
  .middleware([authed])
  .handler(async ({ context }) => {
    deleteCookie(SETUP_HIDDEN_COOKIE, { path: '/' })
    const forEveryone = context.session.org.role === 'owner'
    if (forEveryone) await restoreSetup(context.session.org.id)
    return { ok: true, forEveryone }
  })

export const loadDemoFn = createServerFn({ method: 'POST' })
  .middleware([authed])
  .handler(async ({ context }) => {
    if (context.session.org.role !== 'owner') throw new Error('Only owners can load demo data.')
    if (env().NODE_ENV === 'production' && process.env.ALLOW_DEMO_FIXTURES !== 'true') throw new Error('Demo data is disabled in production.')
    return loadDemoFixtures(context.session.org.id, context.session.user.id)
  })
