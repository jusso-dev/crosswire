import { and, eq } from 'drizzle-orm'
import { getDb } from '../db/client'
import { agentMemoryEntries, agentRunOutputs, agentRuns, orgDirectives } from '../db/schema'
import { sha256 } from './canonical'
import { isPersistentInjection, type MemoryKind } from './memory'
import { SQUAD_SDK_PIN } from './squad-sdk'

export const BUNDLE_VERSION = 1

const SAFETY_RE = /\b(do not|don't|never|must not)\b/i

export interface OrgBundle {
  schemaVersion: typeof BUNDLE_VERSION
  bundleVersion: typeof BUNDLE_VERSION
  sdkVersion: string
  exportedAt: string
  sourceOrgId: string
  memories: Array<{
    id: string
    agentKey: string
    kind: string
    body: string
    trust: string
    visibility: string
    sourceType: string | null
    sourceId: string | null
    contentSha256: string
    createdAt: string
  }>
  runs: Array<{
    id: string
    parentRunId: string | null
    agentKey: string
    status: string
    policySha256: string | null
    charterSha256: string | null
    sdkVersion: string | null
    startedAt: string
    outputs: Array<{ kind: string; body: string; contentSha256: string }>
  }>
  directives: Array<{ id: string; title: string; body: string; version: number; status: string; contentSha256: string; source: string }>
}

export async function exportOrgBundle(orgId: string): Promise<OrgBundle> {
  const memories = await getDb().select().from(agentMemoryEntries).where(eq(agentMemoryEntries.orgId, orgId))
  const runs = await getDb().select().from(agentRuns).where(eq(agentRuns.orgId, orgId))
  const outputs = await getDb().select().from(agentRunOutputs).where(eq(agentRunOutputs.orgId, orgId))
  const directives = await getDb().select().from(orgDirectives).where(eq(orgDirectives.orgId, orgId))
  return {
    schemaVersion: BUNDLE_VERSION,
    bundleVersion: BUNDLE_VERSION,
    sdkVersion: SQUAD_SDK_PIN,
    exportedAt: new Date().toISOString(),
    sourceOrgId: orgId,
    memories: memories.map((row) => ({
      id: row.id,
      agentKey: row.agentKey,
      kind: row.kind,
      body: row.body,
      trust: row.trust,
      visibility: row.visibility,
      sourceType: row.sourceType,
      sourceId: row.sourceId,
      contentSha256: row.contentSha256 ?? sha256(row.body),
      createdAt: row.createdAt.toISOString(),
    })),
    runs: runs.map((run) => ({
      id: run.id,
      parentRunId: run.parentRunId,
      agentKey: run.agentKey,
      status: run.status,
      policySha256: run.policySha256,
      charterSha256: run.charterSha256,
      sdkVersion: run.sdkVersion,
      startedAt: run.startedAt.toISOString(),
      outputs: outputs.filter((output) => output.runId === run.id).map((output) => ({ kind: output.kind, body: output.body, contentSha256: output.contentSha256 })),
    })),
    directives: directives.map((row) => ({
      id: row.id,
      title: row.title,
      body: row.body,
      version: row.version,
      status: row.status,
      contentSha256: row.contentSha256,
      source: row.source,
    })),
  }
}

export interface ImportResult {
  memories: number
  skippedMemories: number
  directives: number
  skippedDirectives: number
}

/**
 * Import keeps content and provenance. It does not grant trust.
 * Operator safety sentences that are not injection stay safety. Everything else is quarantined.
 * Directives land as drafts, including ones that were approved in the source org.
 */
export async function importOrgBundle(orgId: string, bundle: OrgBundle): Promise<ImportResult> {
  if (bundle.schemaVersion !== BUNDLE_VERSION || bundle.bundleVersion !== BUNDLE_VERSION) throw new Error(`Unsupported bundle version ${bundle.schemaVersion}.`)
  let memories = 0
  let skippedMemories = 0
  let directives = 0
  let skippedDirectives = 0
  for (const entry of bundle.memories) {
    const digest = sha256(entry.body)
    if (digest !== entry.contentSha256) throw new Error('Memory provenance hash does not match the body.')
    const [existing] = await getDb()
      .select({ id: agentMemoryEntries.id })
      .from(agentMemoryEntries)
      .where(and(eq(agentMemoryEntries.orgId, orgId), eq(agentMemoryEntries.agentKey, entry.agentKey), eq(agentMemoryEntries.contentSha256, digest)))
      .limit(1)
    if (existing) {
      skippedMemories++
      continue
    }
    const injection = isPersistentInjection(entry.body)
    const keepSafety = entry.kind === 'safety' && entry.trust === 'operator' && SAFETY_RE.test(entry.body) && !injection
    await getDb().insert(agentMemoryEntries).values({
      orgId,
      agentKey: entry.agentKey,
      kind: keepSafety ? 'safety' : (entry.kind as MemoryKind),
      body: entry.body,
      sourceType: 'import',
      sourceId: entry.id,
      trust: keepSafety ? 'operator' : 'quarantine',
      visibility: keepSafety ? 'org' : 'private_case',
      contentSha256: digest,
      redacted: false,
    })
    memories++
  }
  for (const directive of bundle.directives) {
    if (sha256(directive.body) !== directive.contentSha256) throw new Error('Directive provenance hash does not match the body.')
    const [existing] = await getDb()
      .select({ id: orgDirectives.id })
      .from(orgDirectives)
      .where(and(eq(orgDirectives.orgId, orgId), eq(orgDirectives.contentSha256, directive.contentSha256)))
      .limit(1)
    if (existing) {
      skippedDirectives++
      continue
    }
    await getDb().insert(orgDirectives).values({
      orgId,
      title: directive.title,
      body: directive.body,
      version: directive.version,
      contentSha256: directive.contentSha256,
      status: 'draft',
      source: 'import',
      provenance: { sourceOrgId: bundle.sourceOrgId, sourceId: directive.id, sourceStatus: directive.status },
    })
    directives++
  }
  return { memories, skippedMemories, directives, skippedDirectives }
}
