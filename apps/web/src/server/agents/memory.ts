import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm'
import { getDb } from '../db/client'
import { agentMemories, agentMemoryEntries } from '../db/schema'
import { looksSecret, redactString, truncate } from '../lib/redact'
import { writeAudit } from '../audit'
import type { AgentKey } from '../../shared/agents'

export type MemoryKind = (typeof agentMemoryEntries.$inferInsert)['kind']

const SAFETY_RE = /\b(do not|don't|never|must not)\b/i

/** Append a memory entry (#31). Secrets are redacted before storage and the entry is flagged. */
export async function appendMemory(input: {
  orgId: string
  agentKey: AgentKey
  body: string
  kind?: MemoryKind
  sourceType?: string
  sourceId?: string
}) {
  const raw = input.body.trim()
  if (!raw) throw new Error('memory body is empty')
  const redacted = looksSecret(raw)
  const body = truncate(redactString(raw), 2000)
  const kind = input.kind ?? (SAFETY_RE.test(body) ? 'safety' : 'fact')
  const [row] = await getDb()
    .insert(agentMemoryEntries)
    .values({ orgId: input.orgId, agentKey: input.agentKey, kind, body, sourceType: input.sourceType, sourceId: input.sourceId, redacted })
    .returning()
  return row!
}

export async function listMemoryEntries(orgId: string, agentKey?: AgentKey, opts: { includeCompacted?: boolean; limit?: number } = {}) {
  const conds = [eq(agentMemoryEntries.orgId, orgId)]
  if (agentKey) conds.push(eq(agentMemoryEntries.agentKey, agentKey))
  if (!opts.includeCompacted) conds.push(isNull(agentMemoryEntries.compactedAt))
  return getDb()
    .select()
    .from(agentMemoryEntries)
    .where(and(...conds))
    .orderBy(desc(agentMemoryEntries.createdAt))
    .limit(Math.min(opts.limit ?? 50, 500))
}

export async function getMemory(orgId: string, agentKey: AgentKey) {
  const [row] = await getDb()
    .select()
    .from(agentMemories)
    .where(and(eq(agentMemories.orgId, orgId), eq(agentMemories.agentKey, agentKey)))
    .limit(1)
  return row ?? null
}

/** Build the memory block injected into an agent's system prompt. */
export async function memoryContext(orgId: string, agentKey: AgentKey) {
  const [mem, recent] = await Promise.all([getMemory(orgId, agentKey), listMemoryEntries(orgId, agentKey, { limit: 20 })])
  const lines = recent.reverse().map((e) => `- ${e.kind === 'safety' ? '[safety] ' : ''}${e.body}`)
  const parts = []
  if (mem?.body) parts.push(`Compacted org memory (v${mem.version}):\n${mem.body}`)
  if (lines.length) parts.push(`Recent memory entries:\n${lines.join('\n')}`)
  return parts.join('\n\n')
}

export async function searchMemory(orgId: string, query: string, limit = 10) {
  const q = `%${query.replace(/[%_\\]/g, (c) => `\\${c}`)}%`
  return getDb()
    .select({ agentKey: agentMemoryEntries.agentKey, kind: agentMemoryEntries.kind, body: agentMemoryEntries.body, createdAt: agentMemoryEntries.createdAt })
    .from(agentMemoryEntries)
    .where(and(eq(agentMemoryEntries.orgId, orgId), sql`${agentMemoryEntries.body} ilike ${q}`))
    .orderBy(desc(agentMemoryEntries.createdAt))
    .limit(limit)
}

/** Export memory as a Squad-style history.md for git-centric workflows. */
export async function exportHistoryMarkdown(orgId: string, agentKey: AgentKey) {
  const mem = await getMemory(orgId, agentKey)
  const entries = await getDb()
    .select()
    .from(agentMemoryEntries)
    .where(and(eq(agentMemoryEntries.orgId, orgId), eq(agentMemoryEntries.agentKey, agentKey), isNull(agentMemoryEntries.compactedAt)))
    .orderBy(asc(agentMemoryEntries.createdAt))
  const out = [`# ${agentKey} history`, '']
  if (mem?.body) out.push(`## Core context (v${mem.version})`, '', mem.body, '')
  out.push('## Learnings', '')
  for (const e of entries) out.push(`- ${e.createdAt.toISOString().slice(0, 10)} [${e.kind}] ${e.body}`)
  return `${out.join('\n')}\n`
}

/** Import a history.md: every bullet line becomes an entry. Returns entries created. */
export async function importHistoryMarkdown(orgId: string, agentKey: AgentKey, markdown: string) {
  let count = 0
  for (const line of markdown.split('\n')) {
    const m = /^\s*[-*]\s+(?:\d{4}-\d{2}-\d{2}\s+)?(?:\[(fact|feedback|safety|summary)\]\s+)?(.+)$/.exec(line)
    if (!m?.[2]) continue
    await appendMemory({ orgId, agentKey, body: m[2], kind: (m[1] as MemoryKind | undefined) ?? undefined, sourceType: 'import' })
    count++
  }
  return count
}

export interface CompactResult {
  agentKey: AgentKey
  before: number
  after: number
  version: number
  bytesBefore: number
  bytesAfter: number
}

/**
 * Compaction (#35, Squad `nap` analogue). Deterministic: keep the newest `keepLatest` entries
 * live, fold older ones into the compacted memory body as distilled bullets. Safety entries are
 * never folded away: they are always copied verbatim into the body and stay live.
 * Raw entries are append-only: compaction marks them `compacted_at`, it never deletes.
 */
export async function compactMemory(
  orgId: string,
  agentKey: AgentKey,
  opts: { keepLatest?: number; summarise?: (bullets: string[]) => Promise<string[]> } = {},
): Promise<CompactResult> {
  const keep = opts.keepLatest ?? 20
  const db = getDb()
  const live = await db
    .select()
    .from(agentMemoryEntries)
    .where(and(eq(agentMemoryEntries.orgId, orgId), eq(agentMemoryEntries.agentKey, agentKey), isNull(agentMemoryEntries.compactedAt)))
    .orderBy(desc(agentMemoryEntries.createdAt))
  const mem = await getMemory(orgId, agentKey)
  const bytesBefore = (mem?.body.length ?? 0) + live.reduce((n, e) => n + e.body.length, 0)

  const fold = live.slice(keep).filter((e) => e.kind !== 'safety')
  const safety = live.filter((e) => e.kind === 'safety')
  const existing = (mem?.body ?? '').split('\n').filter((l) => l.startsWith('- '))
  const existingSafety = existing.filter((l) => l.startsWith('- [safety]'))
  const existingOther = existing.filter((l) => !l.startsWith('- [safety]'))

  let distilled = [...new Set([...existingOther.map((l) => l.slice(2)), ...fold.map((e) => e.body)])]
  if (opts.summarise && distilled.length > 0) distilled = await opts.summarise(distilled)
  distilled = distilled.slice(-50)

  const safetyLines = [...new Set([...existingSafety.map((l) => l.slice('- [safety] '.length)), ...safety.map((e) => e.body)])]
  const body = [...safetyLines.map((s) => `- [safety] ${s}`), ...distilled.map((s) => `- ${s}`)].join('\n')
  const version = (mem?.version ?? 0) + 1

  await db.transaction(async (tx) => {
    await tx
      .insert(agentMemories)
      .values({ orgId, agentKey, body, version })
      .onConflictDoUpdate({ target: [agentMemories.orgId, agentMemories.agentKey], set: { body, version, updatedAt: new Date() } })
    for (const e of fold) {
      await tx.update(agentMemoryEntries).set({ compactedAt: new Date() }).where(eq(agentMemoryEntries.id, e.id))
    }
  })

  const after = live.length - fold.length
  const bytesAfter = body.length + live.filter((e) => !fold.includes(e)).reduce((n, e) => n + e.body.length, 0)
  await writeAudit({ category: 'memory', action: 'compact', actorType: 'system', orgId, data: { agentKey, before: live.length, after, version } })
  return { agentKey, before: live.length, after, version, bytesBefore, bytesAfter }
}
