import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { authed } from './middleware'
import { auditBundle, createProposal, decideProposal, dryRunProposal, executeProposal, findRollback, getProposal, listEvents, listProposals, proposeRollback, toView } from '../server/response/proposals'
import { executorMode } from '../server/response/executors'
import { canApprove } from '../server/response/rbac'
import { RESPONSE_ACTION_TYPES } from '../shared/response'
import { asJson } from '../shared/json'
import { listOrgMembers } from '../server/orgs'

const run = async <T>(fn: () => Promise<T>) => {
  try {
    return { ok: true as const, result: await fn() }
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
  }
}

export const fetchProposals = createServerFn({ method: 'GET' })
  .middleware([authed])
  .handler(async ({ context }) => (await listProposals(context.session.org.id)).map(toView))

export const fetchProposal = createServerFn({ method: 'GET' })
  .middleware([authed])
  .validator(z.object({ id: z.string().min(1) }))
  .handler(async ({ context, data }) => {
    const p = await getProposal(context.session.org.id, data.id)
    if (!p) return null
    const [events, members] = await Promise.all([listEvents(context.session.org.id, data.id), listOrgMembers(context.session.org.id)])
    // People are shown by email (members of this org only), so approvers can see who did each step.
    const people = Object.fromEntries(members.map((m) => [m.userId, m.email]))
    return {
      people,
      isOwner: context.session.org.role === 'owner',
      proposal: toView(p),
      events: events.map((e) => ({ id: e.id, event: e.event, actorType: e.actorType, actorId: e.actorId, data: asJson(e.data), createdAt: e.createdAt.toISOString() })),
      executorMode: executorMode(p.actionType),
      canApprove: canApprove(context.session.org.role),
      isRequester: p.requestedByUserId === context.session.user.id,
      rollback: await findRollback(context.session.org.id, data.id),
    }
  })

export const createProposalFn = createServerFn({ method: 'POST' })
  .middleware([authed])
  .validator(
    z.object({
      title: z.string(),
      actionType: z.enum(RESPONSE_ACTION_TYPES),
      devices: z.array(z.string()).optional(),
      users: z.array(z.string()).optional(),
      incidents: z.array(z.string()).optional(),
      blastRadiusSummary: z.string(),
      huntId: z.string().optional(),
    }),
  )
  .handler(async ({ context, data }) =>
    run(async () => {
      const p = await createProposal(
        context.session.org.id,
        { type: 'user', userId: context.session.user.id },
        { title: data.title, actionType: data.actionType, targets: { devices: data.devices, users: data.users, incidents: data.incidents }, blastRadius: { summary: data.blastRadiusSummary }, huntId: data.huntId },
      )
      return { id: p.id }
    }),
  )

const actor = (s: { user: { id: string }; org: { role: 'owner' | 'approver' | 'analyst' } }) => ({ userId: s.user.id, role: s.org.role })

export const decideFn = createServerFn({ method: 'POST' })
  .middleware([authed])
  .validator(z.object({ id: z.string().min(1), decision: z.enum(['approve', 'reject']), comment: z.string().max(1000).optional() }))
  .handler(async ({ context, data }) => run(async () => toView(await decideProposal(context.session.org.id, actor(context.session), data.id, data.decision, data.comment))))

export const dryRunFn = createServerFn({ method: 'POST' })
  .middleware([authed])
  .validator(z.object({ id: z.string().min(1) }))
  .handler(async ({ context, data }) => run(() => dryRunProposal(context.session.org.id, actor(context.session), data.id)))

export const executeFn = createServerFn({ method: 'POST' })
  .middleware([authed])
  .validator(z.object({ id: z.string().min(1) }))
  .handler(async ({ context, data }) => run(() => executeProposal(context.session.org.id, actor(context.session), data.id)))

/** Rollback as a new gated proposal (#90). Any approver may propose; a different approver decides. */
export const proposeRollbackFn = createServerFn({ method: 'POST' })
  .middleware([authed])
  .validator(z.object({ id: z.string().min(1) }))
  .handler(async ({ context, data }) =>
    run(async () => {
      if (!canApprove(context.session.org.role)) throw new Error('Only owners and approvers can propose a rollback.')
      const r = await proposeRollback(context.session.org.id, { userId: context.session.user.id }, data.id)
      return { id: r.id }
    }),
  )

export const exportBundleFn = createServerFn({ method: 'GET' })
  .middleware([authed])
  .validator(z.object({ id: z.string().min(1) }))
  .handler(async ({ context, data }) => {
    if (context.session.org.role !== 'owner') throw new Error('Only owners can export audit bundles.')
    return auditBundle(context.session.org.id, data.id)
  })
