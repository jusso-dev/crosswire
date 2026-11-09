import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { authed } from './middleware'
import { decisionActors, searchDecisions } from '../server/agents/decisions'
import { listRecentRuns, readRunReplay } from '../server/agents/runs'
import { listOrgMembers } from '../server/orgs'
import { budgetSnapshot } from '../server/agents/budgets'
import { approveDirective, createDirective, listDirectives, retireDirective } from '../server/agents/directives'
import { compactMemory, describeMemory, exportHistoryMarkdown, findMemory, getMemory, listMemoryEntries, promoteMemory, promptMembership, rememberOperator, replaceMemory } from '../server/agents/memory'
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
    const [page, actors, members, recent] = await Promise.all([
      searchDecisions(orgId, { q: data?.q, actor: data?.actor, actions: data?.actions, before: data?.before ? new Date(data.before) : undefined, limit: 100 }),
      decisionActors(orgId),
      listOrgMembers(orgId),
      listRecentRuns(orgId),
    ])
    // Human actors are user ids; show their email (members of this org only).
    const emails = Object.fromEntries(members.map((m) => [m.userId, m.email]))
    return {
      rows: page.rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString(), actorLabel: r.actorType === 'user' ? (emails[r.actorKey] ?? 'a former member') : null })),
      hasMore: page.hasMore,
      actors: actors.map((a) => ({ key: a.actorKey, type: a.actorType, label: a.actorType === 'user' ? (emails[a.actorKey] ?? 'a former member') : a.actorKey })),
      recentRuns: recent.map((run) => ({ id: run.id, agentKey: run.agentKey, status: run.status, startedAt: run.startedAt.toISOString() })),
    }
  })

/** Full redacted replay for one run in the signed-in organisation. Another organisation gets null. */
export const fetchRunReplay = createServerFn({ method: 'GET' })
  .middleware([authed])
  .validator(z.object({ runId: z.uuid() }))
  .handler(async ({ context, data }) => readRunReplay(context.session.org.id, data.runId))

const iso = (d: Date | null) => d?.toISOString() ?? null

async function presentEntries(orgId: string, rows: Awaited<ReturnType<typeof listMemoryEntries>>) {
  const [injected, members] = await Promise.all([promptMembership(orgId, rows.map((row) => row.agentKey)), listOrgMembers(orgId)])
  const emails = Object.fromEntries(members.map((member) => [member.userId, member.email]))
  return rows.map((row) => {
    const place = describeMemory(row, injected)
    return {
      id: row.id,
      agentKey: row.agentKey,
      kind: row.kind,
      body: row.body,
      redacted: row.redacted,
      trust: row.trust,
      sdkClass: row.sdkClass,
      sourceType: row.sourceType,
      authorId: row.authorId,
      authorLabel: row.authorId ? (emails[row.authorId] ?? 'a former member') : null,
      tombstonedAt: iso(row.tombstonedAt),
      createdAt: row.createdAt.toISOString(),
      inPrompt: place.inPrompt,
      reason: place.reason,
    }
  })
}

export const fetchMemory = createServerFn({ method: 'GET' })
  .middleware([authed])
  .validator(z.object({ agentKey: z.enum(AGENT_KEYS) }))
  .handler(async ({ context, data }) => {
    const orgId = context.session.org.id
    const [mem, entries] = await Promise.all([getMemory(orgId, data.agentKey), listMemoryEntries(orgId, data.agentKey, { limit: 100 })])
    return {
      body: mem?.body ?? '',
      version: mem?.version ?? 0,
      entries: await presentEntries(orgId, entries),
      markdown: await exportHistoryMarkdown(orgId, data.agentKey),
    }
  })

/** Directives, today's Postgres usage, and an org-wide memory search. Another organisation's rows are not included. */
export const fetchAgentDesk = createServerFn({ method: 'GET' })
  .middleware([authed])
  .validator(z.object({ q: z.string().max(200).optional() }).optional())
  .handler(async ({ context, data }) => {
    const orgId = context.session.org.id
    const [directives, budget, hits] = await Promise.all([listDirectives(orgId), budgetSnapshot(orgId), findMemory(orgId, data?.q ?? '', 50)])
    return {
      directives: directives.map((row) => ({
        id: row.id,
        title: row.title,
        body: row.body,
        status: row.status,
        source: row.source,
        createdBy: row.createdBy,
        createdAt: row.createdAt.toISOString(),
      })),
      budget: {
        inputTokens: budget.inputTokens,
        outputTokens: budget.outputTokens,
        costMicros: budget.costMicros,
        unpriced: budget.unpriced,
        unmeasured: budget.unmeasured,
        dailyInputCap: budget.dailyInputCap,
        spendCapMicros: budget.spendCapMicros,
        rateSet: budget.rateSet,
        context: budget.context ? { ...budget.context, at: budget.context.at.toISOString() } : null,
      },
      hits: await presentEntries(orgId, hits),
    }
  })

export const rememberFn = createServerFn({ method: 'POST' })
  .middleware([authed])
  .validator(z.object({ agentKey: z.enum(AGENT_KEYS), body: z.string().min(1).max(2000), kind: z.enum(['fact', 'safety']).optional() }))
  .handler(async ({ context, data }) => {
    const row = await rememberOperator(context.session.org.id, context.session.user.id, data.agentKey, data.body, data.kind)
    return { id: row.id, trust: row.trust }
  })

export const promoteMemoryFn = createServerFn({ method: 'POST' })
  .middleware([authed])
  .validator(z.object({ entryId: z.uuid() }))
  .handler(async ({ context, data }) => {
    if (!canApprove(context.session.org.role)) throw new Error('Only owners and approvers can promote memory.')
    await promoteMemory(context.session.org.id, data.entryId, context.session.user.id)
    return { ok: true as const }
  })

export const replaceMemoryFn = createServerFn({ method: 'POST' })
  .middleware([authed])
  .validator(z.object({ entryId: z.uuid(), body: z.string().min(1).max(2000) }))
  .handler(async ({ context, data }) => {
    if (!canApprove(context.session.org.role)) throw new Error('Only owners and approvers can replace memory.')
    const row = await replaceMemory(context.session.org.id, context.session.user.id, data.entryId, data.body)
    return { id: row.id }
  })

export const createDirectiveFn = createServerFn({ method: 'POST' })
  .middleware([authed])
  .validator(z.object({ title: z.string().min(1).max(120), body: z.string().min(1).max(2000) }))
  .handler(async ({ context, data }) => {
    const row = await createDirective({ orgId: context.session.org.id, title: data.title, body: data.body, createdBy: context.session.user.id, source: 'operator' })
    return { id: row.id }
  })

export const approveDirectiveFn = createServerFn({ method: 'POST' })
  .middleware([authed])
  .validator(z.object({ directiveId: z.uuid() }))
  .handler(async ({ context, data }) => {
    if (!canApprove(context.session.org.role)) throw new Error('Only owners and approvers can approve a directive.')
    await approveDirective(context.session.org.id, data.directiveId, context.session.user.id)
    return { ok: true as const }
  })

export const retireDirectiveFn = createServerFn({ method: 'POST' })
  .middleware([authed])
  .validator(z.object({ directiveId: z.uuid() }))
  .handler(async ({ context, data }) => {
    if (!canApprove(context.session.org.role)) throw new Error('Only owners and approvers can retire a directive.')
    await retireDirective(context.session.org.id, data.directiveId, context.session.user.id)
    return { ok: true as const }
  })

/** Admin action for compaction (owner/approver only); the CLI is `pnpm compact-memory`. */
export const runCompaction = createServerFn({ method: 'POST' })
  .middleware([authed])
  .validator(z.object({ agentKey: z.enum(AGENT_KEYS) }))
  .handler(async ({ context, data }) => {
    if (!canApprove(context.session.org.role)) throw new Error('Only owners and approvers can compact memory.')
    return compactMemory(context.session.org.id, data.agentKey)
  })
