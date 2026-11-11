import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { authed } from './middleware'
import {
  approvalContentHash,
  auditBundle,
  countInbox,
  createProposal,
  decideProposal,
  dryRunProposal,
  executeProposal,
  findRollback,
  getProposal,
  listEvents,
  listProposalHistory,
  listWaitingProposals,
  ProposalNotFoundError,
  ProposalStateError,
  proposeRollback,
  toView,
} from '../server/response/proposals'
import { executorMode } from '../server/response/executors'
import { canApprove, ForbiddenError } from '../server/response/rbac'
import { RESPONSE_ACTION_TYPES } from '../shared/response'
import { asJson } from '../shared/json'
import { plainMessage } from '../shared/messages'
import { listOrgMembers } from '../server/orgs'
import { env } from '../server/env'
import { logger } from '../server/lib/logger'

/** Refusals the approval rules raise on purpose. Their text is written for people. */
const EXPECTED = [ProposalStateError, ProposalNotFoundError, ForbiddenError]

const run = async <T>(fn: () => Promise<T>) => {
  try {
    return { ok: true as const, result: await fn() }
  } catch (err) {
    if (EXPECTED.some((E) => err instanceof E)) return { ok: false as const, error: (err as Error).message }
    // Anything else (database, network, validation) is logged in full and shown in plain words.
    logger.error('approval step failed', { error: err instanceof Error ? err.message : String(err) })
    return { ok: false as const, error: plainMessage(err) }
  }
}

export const HISTORY_PAGE = 50

/**
 * Approvals inbox. Waiting items come from their own uncapped query, so a pending action is never cut
 * off by history. Decided and All are paged newest first ("Load older"); counts are count(*).
 */
export const fetchInbox = createServerFn({ method: 'GET' })
  .middleware([authed])
  .validator(z.object({ view: z.enum(['waiting', 'decided', 'all']).default('waiting'), before: z.string().min(1).max(100).optional() }))
  .handler(async ({ context, data }) => {
    const orgId = context.session.org.id
    const [counts, items] = await Promise.all([
      countInbox(orgId),
      data.view === 'waiting'
        ? listWaitingProposals(orgId).then((rows) => ({ items: rows, hasMore: false }))
        : listProposalHistory(orgId, { view: data.view, before: data.before, limit: HISTORY_PAGE }),
    ])
    return { counts, items: items.items.map(toView), hasMore: items.hasMore }
  })

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
      // Self-approval stays a server rule. This only lets the screen say so before anyone clicks.
      selfApprovalAllowed: env().RESPONSE_ALLOW_SELF_APPROVAL,
      onBehalfOf: p.requestedByUserId ? (people[p.requestedByUserId] ?? 'a former member') : null,
      // What the decision is bound to. Read-only; execution re-checks the hash before its atomic claim.
      binding: {
        sha256: p.payloadSha256,
        schemaVersion: p.payloadSchemaVersion,
        matches: p.payloadSha256 ? approvalContentHash(p) === p.payloadSha256 : false,
        enforced: env().APPROVAL_BINDING !== 'legacy',
      },
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
