import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { authed } from './middleware'
import { decisionActors, searchDecisions } from '../server/agents/decisions'
import { cancelRunAs, listRecentRuns, listRunsPage, readRunDetail, runStatuses, RUN_STATUSES } from '../server/agents/runs'
import { REVIEWED_SKILLS } from '../server/agents/skills'
import { listOrgMembers } from '../server/orgs'
import { budgetSnapshot } from '../server/agents/budgets'
import { approveDirective, createDirective, listDirectives, retireDirective } from '../server/agents/directives'
import { compactMemory, countReviewQueue, describeMemory, exportHistoryMarkdown, findMemory, getMemory, listMemoryEntries, listReviewQueuePage, promoteBlockReason, promoteMemory, promptMembership, rememberOperator, replaceMemory } from '../server/agents/memory'
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

/** Notes shown per agent. The history.md export has every note. */
export const MEMORY_PAGE = 100

export const fetchMemory = createServerFn({ method: 'GET' })
  .middleware([authed])
  .validator(z.object({ agentKey: z.enum(AGENT_KEYS) }))
  .handler(async ({ context, data }) => {
    const orgId = context.session.org.id
    // One more than shown, so the page can say when older notes exist (#171).
    const [mem, rows] = await Promise.all([getMemory(orgId, data.agentKey), listMemoryEntries(orgId, data.agentKey, { limit: MEMORY_PAGE + 1 })])
    const entries = rows.slice(0, MEMORY_PAGE)
    return {
      body: mem?.body ?? '',
      version: mem?.version ?? 0,
      entries: await presentEntries(orgId, entries),
      hasMore: rows.length > MEMORY_PAGE,
      markdown: await exportHistoryMarkdown(orgId, data.agentKey),
    }
  })

/**
 * Whether the server refuses new model calls today, and why (#161). The same rules as the budget
 * check: any real call needs at least one input token, so reaching the cap means refusal. The
 * screen says "used up" only from this, never from a rounded percentage.
 */
export function refusalState(b: { inputTokens: number; dailyInputCap: number; costMicros: number; spendCapMicros: number | null; unpriced: number; unmeasured: number }): 'unmeasured' | 'tokens' | 'unpriced' | 'spend' | null {
  if (b.unmeasured > 0) return 'unmeasured'
  if (b.inputTokens >= b.dailyInputCap) return 'tokens'
  if (b.spendCapMicros !== null && b.unpriced > 0) return 'unpriced'
  if (b.spendCapMicros !== null && b.costMicros >= b.spendCapMicros) return 'spend'
  return null
}

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
        refusing: refusalState(budget),
      },
      // Deployment setting names are shown to owners only. Everyone else is told to ask an owner (#161).
      isOwner: context.session.org.role === 'owner',
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

/** Runs shown per page in the run view. */
export const RUNS_PAGE = 100

/** Runs for the run view. Optional status, agent and conversation filters, and a `before` cursor. This organisation only. */
export const fetchRuns = createServerFn({ method: 'GET' })
  .middleware([authed])
  .validator(z.object({ status: z.enum(RUN_STATUSES).optional(), agentKey: z.enum(AGENT_KEYS).optional(), threadId: z.string().max(100).optional(), before: z.iso.datetime().optional() }).optional())
  .handler(async ({ context, data }) => {
    const page = await listRunsPage(context.session.org.id, { status: data?.status, agentKey: data?.agentKey, threadId: data?.threadId, before: data?.before ? new Date(data.before) : undefined, limit: RUNS_PAGE })
    return { runs: page.runs, hasMore: page.hasMore, pricing: (await budgetSnapshot(context.session.org.id)).rateSet }
  })

/** Status only, for polling a live run without reloading the page (#170). This organisation only. */
export const fetchRunStatus = createServerFn({ method: 'GET' })
  .middleware([authed])
  .validator(z.object({ runIds: z.array(z.uuid()).max(50) }))
  .handler(async ({ context, data }) => ({ runs: await runStatuses(context.session.org.id, data.runIds) }))

/** One run: summary, ordered events, redacted outputs, parent and children. Null in another organisation. */
export const fetchRunDetail = createServerFn({ method: 'GET' })
  .middleware([authed])
  .validator(z.object({ runId: z.uuid() }))
  .handler(async ({ context, data }) => {
    const detail = await readRunDetail(context.session.org.id, data.runId)
    if (!detail) return null
    // Skills are reviewed per agent. Show the skill this agent runs under, with its version.
    const skill = REVIEWED_SKILLS.find((item) => item.agent === detail.run.agentKey)
    return { ...detail, skill: skill ? { name: skill.definition.name, version: skill.version } : null }
  })

/** Stop a running run. The server checks who may stop it; the UI only asks. */
export const cancelRunFn = createServerFn({ method: 'POST' })
  .middleware([authed])
  .validator(z.object({ runId: z.uuid() }))
  .handler(async ({ context, data }) => {
    try {
      return { ok: true as const, ...(await cancelRunAs(context.session.org.id, { userId: context.session.user.id, canApprove: canApprove(context.session.org.role) }, data.runId)) }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

/** Held notes shown per page in the review queue. */
export const REVIEW_PAGE = 100

/** Quarantined memory across all agents, with the reason this viewer can or cannot promote each one. Paged with `before` (#171). */
export const fetchReviewQueue = createServerFn({ method: 'GET' })
  .middleware([authed])
  .validator(z.object({ before: z.iso.datetime().optional() }).optional())
  .handler(async ({ context, data }) => {
    const orgId = context.session.org.id
    const viewer = { userId: context.session.user.id, canApprove: canApprove(context.session.org.role) }
    const [page, total] = await Promise.all([listReviewQueuePage(orgId, { limit: REVIEW_PAGE, before: data?.before ? new Date(data.before) : undefined }), countReviewQueue(orgId)])
    const presented = await presentEntries(orgId, page.rows)
    return {
      entries: presented.map((entry, i) => ({ ...entry, mine: page.rows[i]!.authorId === viewer.userId, blocked: promoteBlockReason(page.rows[i]!, viewer) })),
      hasMore: page.hasMore,
      total,
    }
  })

/** Read-only view of the reviewed skills (runbooks) in code. */
export const fetchSkills = createServerFn({ method: 'GET' })
  .middleware([authed])
  .handler(async () =>
    REVIEWED_SKILLS.map((skill) => ({
      agent: skill.agent,
      name: skill.definition.name,
      version: skill.version,
      description: skill.definition.description,
      domain: skill.definition.domain ?? null,
      tools: [...skill.tools],
      steps: (skill.definition.tools ?? []).map((tool) => ({ name: tool.name, when: tool.when ?? null })),
      content: skill.definition.content ?? '',
    })),
  )
