import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { authed } from './middleware'
import { listOrgMembers, setMemberRole } from '../server/orgs'
import { listAudit } from '../server/audit'
import { writeAudit } from '../server/audit'

export const fetchMembers = createServerFn({ method: 'GET' })
  .middleware([authed])
  .handler(async ({ context }) => ({ members: await listOrgMembers(context.session.org.id), canManage: context.session.org.role === 'owner', me: context.session.user.id }))

/** Owners grant/revoke the approver role (#55). Owners cannot demote themselves here. */
export const setRoleFn = createServerFn({ method: 'POST' })
  .middleware([authed])
  .validator(z.object({ userId: z.string().min(1), role: z.enum(['owner', 'approver', 'analyst']) }))
  .handler(async ({ context, data }) => {
    if (context.session.org.role !== 'owner') throw new Error('Only owners can change roles.')
    if (data.userId === context.session.user.id) throw new Error('You cannot change your own role.')
    await setMemberRole(context.session.org.id, data.userId, data.role)
    await writeAudit({ category: 'auth', action: 'role_changed', actorType: 'user', actorId: context.session.user.id, orgId: context.session.org.id, targetType: 'user', targetId: data.userId, data: { role: data.role } })
    return { ok: true }
  })

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
