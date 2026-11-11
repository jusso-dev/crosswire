import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { authed } from './middleware'
import { changeMemberRole, listOrgMembers, MemberChangeError, removeMember } from '../server/orgs'
import { listAudit } from '../server/audit'
import { clearDigestEmail, confirmDigestEmail, DigestEmailError, getDigestEmailView, previewDigestEmail, requestDigestEmail } from '../server/notify/digest-contact'

export const fetchMembers = createServerFn({ method: 'GET' })
  .middleware([authed])
  .handler(async ({ context }) => ({ members: await listOrgMembers(context.session.org.id), canManage: context.session.org.role === 'owner', me: context.session.user.id }))

/** Refusals from membership changes become `{ ok: false }` with a plain message. */
async function memberResult(fn: () => Promise<unknown>) {
  try {
    await fn()
    return { ok: true as const }
  } catch (err) {
    if (err instanceof MemberChangeError) return { ok: false as const, error: err.message }
    throw err
  }
}

/**
 * Owners grant/revoke roles (#55). The owner check, the self check and the last-owner guard run in
 * one transaction on fresh rows (#202), not on the session's role.
 */
export const setRoleFn = createServerFn({ method: 'POST' })
  .middleware([authed])
  .validator(z.object({ userId: z.string().min(1), role: z.enum(['owner', 'approver', 'analyst']) }))
  .handler(async ({ context, data }) =>
    memberResult(() => changeMemberRole({ orgId: context.session.org.id, userId: data.userId, role: data.role, actorId: context.session.user.id, audit: { action: 'role_changed' } })),
  )

/** Owners remove a member (#195). Audited; refuses the last owner and yourself. */
export const removeMemberFn = createServerFn({ method: 'POST' })
  .middleware([authed])
  .validator(z.object({ userId: z.string().min(1) }))
  .handler(async ({ context, data }) => memberResult(() => removeMember(context.session.org.id, data.userId, context.session.user.id)))

export const fetchAuthAudit = createServerFn({ method: 'GET' })
  .middleware([authed])
  .handler(async ({ context }) => {
    if (context.session.org.role !== 'owner') return { allowed: false as const, events: [] }
    const rows = await listAudit(context.session.org.id, undefined, 200)
    return {
      allowed: true as const,
      events: rows.map((r) => ({ id: r.id, category: r.category, action: r.action, result: r.result, actorType: r.actorType, actorId: r.actorId, ipAddress: r.ipAddress, createdAt: r.createdAt.toISOString() })),
    }
  })

export const bindSamlProviderFn = createServerFn({ method: 'POST' })
  .middleware([authed])
  .validator(z.object({ providerId: z.string().min(1).max(100) }))
  .handler(async ({ context, data }) => {
    const { bindOwnProvider } = await import('../server/auth/saml')
    await bindOwnProvider(data.providerId, context.session.org.id, context.session.user.id, context.session.org.role)
    return { ok: true }
  })

// ---------- Digest email address (#102) ----------
async function digestResult<T>(fn: () => Promise<T>) {
  try {
    return { ok: true as const, result: await fn() }
  } catch (err) {
    if (err instanceof DigestEmailError) return { ok: false as const, error: err.message }
    throw err
  }
}

export const fetchDigestEmail = createServerFn({ method: 'GET' })
  .middleware([authed])
  .handler(async ({ context }) => {
    if (context.session.org.role !== 'owner') return { allowed: false as const }
    const view = await getDigestEmailView(context.session.org.id, context.session.user.id)
    return view ? { allowed: true as const, ...view } : { allowed: false as const }
  })

export const requestDigestEmailFn = createServerFn({ method: 'POST' })
  .middleware([authed])
  .validator(z.object({ email: z.string().max(320) }))
  .handler(async ({ context, data }) => {
    return digestResult(async () => {
      const r = await requestDigestEmail(context.session.org.id, context.session.user.id, data.email)
      return { pending: r.pending, expiresAt: r.expiresAt.toISOString() }
    })
  })

export const clearDigestEmailFn = createServerFn({ method: 'POST' })
  .middleware([authed])
  .handler(async ({ context }) => {
    return digestResult(() => clearDigestEmail(context.session.org.id, context.session.user.id))
  })

/** Read-only preview for the confirmation page. POST keeps the token out of server-function URLs and logs. */
export const previewDigestEmailFn = createServerFn({ method: 'POST' })
  .middleware([authed])
  .validator(z.object({ token: z.string().max(200) }))
  .handler(async ({ context, data }) => {
    return previewDigestEmail(context.session.user.id, data.token)
  })

export const confirmDigestEmailFn = createServerFn({ method: 'POST' })
  .middleware([authed])
  .validator(z.object({ token: z.string().max(200) }))
  .handler(async ({ context, data }) => {
    return digestResult(() => confirmDigestEmail(context.session.user.id, data.token))
  })
