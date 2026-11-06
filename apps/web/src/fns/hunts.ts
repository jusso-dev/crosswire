import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { authed } from './middleware'
import { addEvidence, approveAndRunKql, createHunt, getHunt, listHunts, proposeKql, rejectKql, setHuntStatus } from '../server/hunting/hunts'
import { getConnectorView, upsertConnector } from '../server/hunting/broker'
import { env } from '../server/env'
import { asJson } from '../shared/json'

const iso = (d: Date | null) => d?.toISOString() ?? null

export const fetchHunts = createServerFn({ method: 'GET' })
  .middleware([authed])
  .handler(async ({ context }) => {
    const rows = await listHunts(context.session.org.id)
    return rows.map((h) => ({ id: h.id, title: h.title, status: h.status, hypothesis: h.hypothesis, updatedAt: h.updatedAt.toISOString() }))
  })

export const createHuntFn = createServerFn({ method: 'POST' })
  .middleware([authed])
  .validator(z.object({ title: z.string().min(1).max(200), hypothesis: z.string().max(4000).optional(), watchHitId: z.string().optional(), threadId: z.string().optional() }))
  .handler(async ({ context, data }) => {
    const h = await createHunt(context.session.org.id, context.session.user.id, data)
    return { id: h.id }
  })

export const fetchHunt = createServerFn({ method: 'GET' })
  .middleware([authed])
  .validator(z.object({ huntId: z.string().min(1) }))
  .handler(async ({ context, data }) => {
    const h = await getHunt(context.session.org.id, data.huntId)
    if (!h) return null
    return {
      hunt: { ...h.hunt, createdAt: h.hunt.createdAt.toISOString(), updatedAt: h.hunt.updatedAt.toISOString() },
      evidence: h.evidence.map((e) => ({ id: e.id, type: e.type, payload: asJson(e.payload), actorType: e.actorType, actorId: e.actorId, createdAt: e.createdAt.toISOString() })),
      proposals: h.proposals.map((p) => ({
        id: p.id,
        target: p.target,
        kql: p.kql,
        originalKql: p.originalKql,
        rationale: p.rationale,
        status: p.status,
        proposedByType: p.proposedByType,
        proposedById: p.proposedById,
        decidedBy: p.decidedBy,
        expiresAt: p.expiresAt.toISOString(),
        ranAt: iso(p.ranAt),
        resultSummary: p.resultSummary ? asJson(p.resultSummary) : null,
        error: p.error,
        createdAt: p.createdAt.toISOString(),
      })),
      demoMode: env().HUNTING_DEMO_MODE && !(await getConnectorView(context.session.org.id)),
    }
  })

export const addNote = createServerFn({ method: 'POST' })
  .middleware([authed])
  .validator(z.object({ huntId: z.string().min(1), note: z.string().min(1).max(4000) }))
  .handler(async ({ context, data }) => {
    const h = await getHunt(context.session.org.id, data.huntId)
    if (!h) throw new Error('Hunt not found.')
    await addEvidence(context.session.org.id, data.huntId, 'note', { note: data.note }, { type: 'user', id: context.session.user.id })
    return { ok: true }
  })

export const setHuntStatusFn = createServerFn({ method: 'POST' })
  .middleware([authed])
  .validator(z.object({ huntId: z.string().min(1), status: z.enum(['open', 'closed']) }))
  .handler(async ({ context, data }) => {
    await setHuntStatus(context.session.org.id, data.huntId, data.status)
    return { ok: true }
  })

export const proposeKqlFn = createServerFn({ method: 'POST' })
  .middleware([authed])
  .validator(z.object({ huntId: z.string().min(1), target: z.enum(['defender', 'sentinel']), kql: z.string().min(1).max(10_000), rationale: z.string().max(1000).optional() }))
  .handler(async ({ context, data }) => {
    try {
      const p = await proposeKql(context.session.org.id, { type: 'user', id: context.session.user.id }, data)
      return { ok: true as const, id: p.id }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

export const approveKqlFn = createServerFn({ method: 'POST' })
  .middleware([authed])
  .validator(z.object({ proposalId: z.string().min(1), kql: z.string().min(1).max(10_000).optional() }))
  .handler(async ({ context, data }) => {
    try {
      const r = await approveAndRunKql(context.session.org.id, context.session.user.id, data.proposalId, data.kql)
      return r.status === 'run' ? { ok: true as const, status: 'run' as const, summary: asJson(r.summary) } : { ok: true as const, status: 'failed' as const, error: r.error }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

export const rejectKqlFn = createServerFn({ method: 'POST' })
  .middleware([authed])
  .validator(z.object({ proposalId: z.string().min(1), reason: z.string().max(1000).optional() }))
  .handler(async ({ context, data }) => {
    try {
      await rejectKql(context.session.org.id, context.session.user.id, data.proposalId, data.reason)
      return { ok: true as const }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

export const fetchConnector = createServerFn({ method: 'GET' })
  .middleware([authed])
  .handler(async ({ context }) => ({ connector: await getConnectorView(context.session.org.id), demoMode: env().HUNTING_DEMO_MODE, canEdit: context.session.org.role === 'owner' }))

export const saveConnector = createServerFn({ method: 'POST' })
  .middleware([authed])
  .validator(
    z.object({
      tenantId: z.uuid(),
      clientId: z.uuid(),
      clientSecret: z.string().min(1).max(500).optional(),
      clientSecretRef: z.string().regex(/^env:[A-Z0-9_]+$/).optional(),
      sentinelSubscriptionId: z.string().max(100).optional(),
      sentinelResourceGroup: z.string().max(100).optional(),
      sentinelWorkspaceName: z.string().max(100).optional(),
      sentinelWorkspaceId: z.string().max(100).optional(),
    }),
  )
  .handler(async ({ context, data }) => {
    if (context.session.org.role !== 'owner') throw new Error('Only org owners can configure hunting connectors.')
    await upsertConnector(context.session.org.id, data)
    return { ok: true }
  })

