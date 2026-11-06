import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { authed } from './middleware'
import { listDecisions } from '../server/agents/decisions'
import { compactMemory, exportHistoryMarkdown, getMemory, listMemoryEntries } from '../server/agents/memory'
import { AGENT_KEYS } from '../shared/agents'
import { canApprove } from '../server/response/rbac'

export const fetchActivity = createServerFn({ method: 'GET' })
  .middleware([authed])
  .handler(async ({ context }) => {
    const rows = await listDecisions(context.session.org.id, { limit: 100 })
    return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }))
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
