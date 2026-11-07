import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { authed } from './middleware'
import { decisionActors, searchDecisions } from '../server/agents/decisions'
import { listOrgMembers } from '../server/orgs'
import { compactMemory, exportHistoryMarkdown, getMemory, listMemoryEntries } from '../server/agents/memory'
import { AGENT_KEYS } from '../shared/agents'
import { canApprove } from '../server/response/rbac'

export const fetchActivity = createServerFn({ method: 'GET' })
  .middleware([authed])
  .validator(
    z
      .object({ q: z.string().max(200).optional(), actor: z.string().max(200).optional(), actions: z.array(z.string().max(100)).max(50).optional(), before: z.iso.datetime().optional() })
      .optional(),
  )
  .handler(async ({ context, data }) => {
    const orgId = context.session.org.id
    const [page, actors, members] = await Promise.all([
      searchDecisions(orgId, { q: data?.q, actor: data?.actor, actions: data?.actions, before: data?.before ? new Date(data.before) : undefined, limit: 100 }),
      decisionActors(orgId),
      listOrgMembers(orgId),
    ])
    // Human actors are user ids; show their email (members of this org only).
    const emails = Object.fromEntries(members.map((m) => [m.userId, m.email]))
    return {
      rows: page.rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString(), actorLabel: r.actorType === 'user' ? (emails[r.actorKey] ?? 'a former member') : null })),
      hasMore: page.hasMore,
      actors: actors.map((a) => ({ key: a.actorKey, type: a.actorType, label: a.actorType === 'user' ? (emails[a.actorKey] ?? 'a former member') : a.actorKey })),
    }
  })

export const fetchMemory = createServerFn({ method: 'GET' })
  .middleware([authed])
  .validator(z.object({ agentKey: z.enum(AGENT_KEYS) }))
  .handler(async ({ context, data }) => {
    const orgId = context.session.org.id
    const [mem, entries] = await Promise.all([getMemory(orgId, data.agentKey), listMemoryEntries(orgId, data.agentKey, { limit: 100 })])
    return {
      body: mem?.body ?? '',
      version: mem?.version ?? 0,
      entries: entries.map((e) => ({ id: e.id, kind: e.kind, body: e.body, redacted: e.redacted, createdAt: e.createdAt.toISOString() })),
      markdown: await exportHistoryMarkdown(orgId, data.agentKey),
    }
  })

/** Admin action for compaction (owner/approver only); the CLI is `pnpm compact-memory`. */
export const runCompaction = createServerFn({ method: 'POST' })
  .middleware([authed])
  .validator(z.object({ agentKey: z.enum(AGENT_KEYS) }))
  .handler(async ({ context, data }) => {
    if (!canApprove(context.session.org.role)) throw new Error('Only owners and approvers can compact memory.')
    return compactMemory(context.session.org.id, data.agentKey)
  })
