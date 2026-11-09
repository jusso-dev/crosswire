import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm'
import { getDb } from '../db/client'
import { agentMemories, agentMemoryEntries } from '../db/schema'
import { looksSecret, redactString, truncate } from '../lib/redact'
import { writeAudit } from '../audit'
import { env } from '../env'
import { isAgentKey, type AgentKey } from '../../shared/agents'
import { sha256 } from './canonical'
import { classifyWithSquad } from './squad-sdk'

export type MemoryKind = (typeof agentMemoryEntries.$inferInsert)['kind']

const SAFETY_RE = /\b(do not|don't|never|must not)\b/i
const INJECTION_RE = /\b(ignore|disregard|forget)\b.{0,80}\b(instruction|instructions|above|prior|previous)\b|\byou are now\b|\b(system prompt|developer message)\b/i
const UNTRUSTED_SOURCES = new Set(['thread', 'message', 'import', 'remember', 'tool', 'feedback', 'scribe'])

export class MemoryRefusedError extends Error {}

export function isPersistentInjection(body: string) {
  return INJECTION_RE.test(body)
}

function governanceEnforced() {
  return env().MEMORY_GOVERNANCE !== 'legacy'
}

type MemoryRow = typeof agentMemoryEntries.$inferSelect

function promptEligible(row: Pick<MemoryRow, 'trust' | 'tombstonedAt' | 'body'>) {
  if (!governanceEnforced()) return true
  if (row.tombstonedAt) return false
  if (row.trust === 'quarantine') return false
  if (isPersistentInjection(row.body)) return false
  return true
}

/** Why a row is held out of the prompt. Null means it is eligible, subject to the newest-20 cap. */
export function memoryBlockReason(row: Pick<MemoryRow, 'trust' | 'tombstonedAt' | 'body' | 'compactedAt'>): string | null {
  if (row.compactedAt) return 'Folded into the compacted summary. Not injected as its own line.'
  if (!governanceEnforced()) return null
  if (row.tombstonedAt) return 'Tombstoned. Not in the prompt.'
  if (row.trust === 'quarantine') return 'Quarantined. Not in the prompt until a different person promotes it.'
  if (isPersistentInjection(row.body)) return 'Looks like an instruction override. Not in the prompt.'
  return null
}

/** Ids injected for these agents: every eligible safety note, plus the 20 newest other eligible notes. */
export async function promptMembership(orgId: string, agentKeys: string[]) {
  const injected = new Set<string>()
  for (const agentKey of [...new Set(agentKeys)]) {
    const live = await listMemoryEntries(orgId, agentKey as AgentKey, { limit: 200 })
    const eligible = live.filter((row) => promptEligible(row))
    for (const row of eligible.filter((entry) => entry.kind === 'safety')) injected.add(row.id)
    for (const row of eligible.filter((entry) => entry.kind !== 'safety').slice(0, 20)) injected.add(row.id)
  }
  return injected
}

export function describeMemory(row: Pick<MemoryRow, 'id' | 'trust' | 'tombstonedAt' | 'body' | 'compactedAt'>, injected: Set<string>) {
  const blocked = memoryBlockReason(row)
  const inPrompt = blocked === null && injected.has(row.id)
  const reason = blocked ?? (inPrompt ? 'In the prompt.' : 'Kept in the record. Only the 20 newest non-safety notes are injected, plus every eligible safety note.')
  return { inPrompt, reason }
}

/**
 * Append a memory entry (#31). Secrets are redacted before storage.
 * Squad classify() runs on the redacted body. FORBIDDEN and TRANSIENT are refused.
 * classify() does not stop generic instruction injection, so untrusted sources and injection
 * text are quarantined here. Operator safety sentences stay live so compaction can keep them.
 */
export async function appendMemory(input: {
  orgId: string
  agentKey: AgentKey
  body: string
  kind?: MemoryKind
  sourceType?: string
  sourceId?: string
  authorId?: string | null
}) {
  const raw = input.body.trim()
  if (!raw) throw new Error('memory body is empty')
  const redacted = looksSecret(raw)
  const body = truncate(redactString(raw), 2000)
  const kind = input.kind ?? (SAFETY_RE.test(body) ? 'safety' : 'fact')
  const source = input.sourceType ?? null
  const untrusted = source !== null && UNTRUSTED_SOURCES.has(source)
  const injection = isPersistentInjection(body)
  let sdkClass: string | null = null
  let sdkAllowed: boolean | null = null
  if (governanceEnforced()) {
    let classification
    try {
      classification = await classifyWithSquad(body)
    } catch (err) {
      throw new MemoryRefusedError(`Memory governance unavailable: ${err instanceof Error ? err.message : String(err)}`)
    }
    sdkClass = classification.class
    sdkAllowed = classification.allowed
    if (!classification.allowed || classification.class === 'FORBIDDEN' || classification.class === 'TRANSIENT') {
      throw new MemoryRefusedError(`Memory refused (${classification.class}).`)
    }
  }
  const safetyKeep = kind === 'safety' && !untrusted && !injection
  const quarantine = governanceEnforced() && (injection || untrusted || ((sdkClass === 'POLICY' || sdkClass === 'DECISION') && !safetyKeep))
  const [row] = await getDb()
    .insert(agentMemoryEntries)
    .values({
      orgId: input.orgId,
      agentKey: input.agentKey,
      kind,
      body,
      sourceType: source,
      sourceId: input.sourceId,
      authorId: input.authorId ?? null,
      redacted,
      trust: quarantine ? 'quarantine' : 'operator',
      visibility: quarantine ? 'private_case' : 'org',
      sdkClass,
      sdkAllowed,
      contentSha256: sha256(body),
    })
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

/** Build the memory block injected into an agent's system prompt. Quarantine, tombstones, and injection stay out. Safety is not limited to the newest 20. */
export async function memoryContext(orgId: string, agentKey: AgentKey) {
  const [mem, live] = await Promise.all([getMemory(orgId, agentKey), listMemoryEntries(orgId, agentKey, { limit: 200 })])
  const eligible = live.filter(promptEligible)
  const safety = eligible.filter((e) => e.kind === 'safety')
  const recent = eligible.filter((e) => e.kind !== 'safety').slice(0, 20)
  const lines = [...safety, ...recent].reverse().map((e) => `- ${e.kind === 'safety' ? '[safety] ' : ''}${e.body}`)
  const parts = []
  const body = mem?.body ? (governanceEnforced() ? mem.body.split('\n').filter((line) => !isPersistentInjection(line)).join('\n') : mem.body) : ''
  if (body.trim()) parts.push(`Compacted org memory (v${mem!.version}):\n${body}`)
  if (lines.length) parts.push(`Recent memory entries:\n${lines.join('\n')}`)
  return parts.join('\n\n')
}

export async function searchMemory(orgId: string, query: string, limit = 10, agentKey?: AgentKey) {
  const q = `%${query.replace(/[%_\\]/g, (c) => `\\${c}`)}%`
  const conds = [eq(agentMemoryEntries.orgId, orgId), sql`${agentMemoryEntries.body} ilike ${q}`]
  if (governanceEnforced()) {
    conds.push(ne(agentMemoryEntries.trust, 'quarantine'))
    conds.push(isNull(agentMemoryEntries.tombstonedAt))
    conds.push(agentKey ? or(eq(agentMemoryEntries.visibility, 'org'), eq(agentMemoryEntries.agentKey, agentKey))! : eq(agentMemoryEntries.visibility, 'org'))
  }
  const rows = await getDb()
    .select({ agentKey: agentMemoryEntries.agentKey, kind: agentMemoryEntries.kind, body: agentMemoryEntries.body, createdAt: agentMemoryEntries.createdAt, trust: agentMemoryEntries.trust, tombstonedAt: agentMemoryEntries.tombstonedAt })
    .from(agentMemoryEntries)
    .where(and(...conds))
    .orderBy(desc(agentMemoryEntries.createdAt))
    .limit(limit)
  return rows.filter((row) => promptEligible(row)).map(({ agentKey: key, kind, body, createdAt }) => ({ agentKey: key, kind, body, createdAt }))
}

/** Org-wide find for the Agents page. Includes quarantine and tombstones so a person can review them. Agents keep using searchMemory. */
export async function findMemory(orgId: string, query: string, limit = 50) {
  const q = query.trim()
  if (q.length < 2) return []
  const pattern = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`
  return getDb()
    .select()
    .from(agentMemoryEntries)
    .where(and(eq(agentMemoryEntries.orgId, orgId), sql`${agentMemoryEntries.body} ilike ${pattern}`))
    .orderBy(desc(agentMemoryEntries.createdAt))
    .limit(Math.min(limit, 50))
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

  const trusted = (e: MemoryRow) => !governanceEnforced() || (e.trust !== 'quarantine' && !e.tombstonedAt && !isPersistentInjection(e.body))
  const fold = live.slice(keep).filter((e) => e.kind !== 'safety' && trusted(e))
  const safety = live.filter((e) => e.kind === 'safety' && trusted(e))
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

/** A different person promotes a quarantined note. Injection text cannot be promoted. */
export async function promoteMemory(orgId: string, entryId: string, approverUserId: string) {
  const [row] = await getDb()
    .select()
    .from(agentMemoryEntries)
    .where(and(eq(agentMemoryEntries.orgId, orgId), eq(agentMemoryEntries.id, entryId)))
    .limit(1)
  if (!row) throw new Error('Memory entry not found.')
  if (!row.authorId) throw new Error('Memory has no author, so it cannot be promoted.')
  if (row.authorId === approverUserId) throw new Error('You cannot promote your own memory.')
  if (isPersistentInjection(row.body)) throw new Error('Injection text cannot be promoted.')
  const [updated] = await getDb()
    .update(agentMemoryEntries)
    .set({ trust: 'reviewed', visibility: 'org', promotedBy: approverUserId, promotedAt: new Date() })
    .where(and(eq(agentMemoryEntries.id, entryId), eq(agentMemoryEntries.orgId, orgId)))
    .returning()
  await writeAudit({ category: 'memory', action: 'promote', actorType: 'user', actorId: approverUserId, orgId, targetType: 'agent_memory_entry', targetId: entryId })
  return updated!
}

/** Keep the old row and point it at the replacement. Tombstoned rows stay out of the prompt. The replacement must be in the same organisation and agent. */
export async function supersedeMemory(orgId: string, entryId: string, replacementId: string) {
  if (entryId === replacementId) throw new Error('A memory entry cannot supersede itself.')
  const rows = await getDb()
    .select()
    .from(agentMemoryEntries)
    .where(and(eq(agentMemoryEntries.orgId, orgId), inArray(agentMemoryEntries.id, [entryId, replacementId])))
  const existing = rows.find((row) => row.id === entryId)
  const replacement = rows.find((row) => row.id === replacementId)
  if (!existing) throw new Error('Memory entry not found.')
  if (!replacement) throw new Error('Replacement memory was not found in this organisation.')
  if (existing.agentKey !== replacement.agentKey) throw new Error('Replacement must belong to the same agent.')
  const [updated] = await getDb()
    .update(agentMemoryEntries)
    .set({ supersededBy: replacementId, tombstonedAt: new Date() })
    .where(and(eq(agentMemoryEntries.orgId, orgId), eq(agentMemoryEntries.id, entryId)))
    .returning()
  if (!updated) throw new Error('Memory entry not found.')
  return updated
}

/** Operator note. Source `operator` is trusted. Squad classify still refuses forbidden text, and injection text is quarantined. */
export async function rememberOperator(orgId: string, userId: string, agentKey: AgentKey, body: string, kind?: 'fact' | 'safety') {
  return appendMemory({ orgId, agentKey, body, kind, sourceType: 'operator', authorId: userId })
}

/** Write a replacement note, then tombstone the old row. */
export async function replaceMemory(orgId: string, userId: string, entryId: string, body: string) {
  const [existing] = await getDb()
    .select()
    .from(agentMemoryEntries)
    .where(and(eq(agentMemoryEntries.orgId, orgId), eq(agentMemoryEntries.id, entryId)))
    .limit(1)
  if (!existing) throw new Error('Memory entry not found.')
  if (!isAgentKey(existing.agentKey)) throw new Error('Memory entry has an unknown agent.')
  const replacement = await rememberOperator(orgId, userId, existing.agentKey, body, existing.kind === 'safety' ? 'safety' : 'fact')
  await supersedeMemory(orgId, entryId, replacement.id)
  return replacement
}

/**
 * Quarantined notes waiting for a person, across every agent in this organisation, newest first.
 * Tombstoned and compacted rows are not in the queue.
 */
export async function listReviewQueue(orgId: string, limit = 100) {
  return getDb()
    .select()
    .from(agentMemoryEntries)
    .where(and(eq(agentMemoryEntries.orgId, orgId), eq(agentMemoryEntries.trust, 'quarantine'), isNull(agentMemoryEntries.tombstonedAt), isNull(agentMemoryEntries.compactedAt)))
    .orderBy(desc(agentMemoryEntries.createdAt))
    .limit(Math.min(Math.max(limit, 1), 200))
}

/**
 * Why this person cannot promote this note, or null when they can. Mirrors promoteMemory's checks
 * so the screen can say why before anyone clicks. promoteMemory still enforces every rule.
 */
export function promoteBlockReason(row: Pick<MemoryRow, 'authorId' | 'body' | 'trust'>, viewer: { userId: string; canApprove: boolean }): string | null {
  if (row.trust !== 'quarantine') return 'Already reviewed.'
  if (!viewer.canApprove) return 'Only owners and approvers can promote memory.'
  if (!row.authorId) return 'This note has no author, so nobody can vouch for it. Replace it with a note you write.'
  if (row.authorId === viewer.userId) return 'You wrote this note. A different approver must promote it, so two people agree before it reaches the agent.'
  if (isPersistentInjection(row.body)) return 'This reads like an instruction to the agent, so it cannot be promoted.'
  return null
}

/** Held notes this person could promote: quarantined, live, and written by someone else. Not capped. */
export async function countReviewable(orgId: string, viewerUserId: string) {
  const [row] = await getDb()
    .select({ n: sql<number>`count(*)::int` })
    .from(agentMemoryEntries)
    .where(
      and(
        eq(agentMemoryEntries.orgId, orgId),
        eq(agentMemoryEntries.trust, 'quarantine'),
        isNull(agentMemoryEntries.tombstonedAt),
        isNull(agentMemoryEntries.compactedAt),
        sql`${agentMemoryEntries.authorId} is not null`,
        ne(agentMemoryEntries.authorId, viewerUserId),
      ),
    )
  return Number(row?.n ?? 0)
}
