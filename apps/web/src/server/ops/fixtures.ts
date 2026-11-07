import { readFileSync } from 'node:fs'
import path from 'node:path'
import { and, eq } from 'drizzle-orm'
import { getDb } from '../db/client'
import { huntCases, kqlProposals, orgs, responseProposals, watchEntries } from '../db/schema'
import { runMatcher, type TiRecord } from '../ti/matcher'
import { getConnector } from '../hunting/broker'
import { env } from '../env'
import { addWatch } from '../ti/watchlists'
import { createHunt, proposeKql, approveAndRunKql } from '../hunting/hunts'
import { createProposal, dryRunProposal } from '../response/proposals'
import { writeAudit } from '../audit'

/**
 * Demo fixture pack (#77). Obviously fake: every record is prefixed "[DEMO]", demo devices are
 * `demo-*`, and the response proposal stays in dry-run. Org-scoped only:
 * - Never writes the shared (global) TI tables: recorded fixture feeds are matched in memory against
 *   this org's watches only, producing `[DEMO]`-sourced hits.
 * - Refuses unless hunting is in demo mode for this org (HUNTING_DEMO_MODE=true and no connector),
 *   so the sample KQL can never reach a real tenant.
 * Idempotent per org: a second load is a no-op.
 */
export class DemoFixturesError extends Error {}

function fixtureRecords(read: (f: string) => string): TiRecord[] {
  const inc = JSON.parse(read('pwnwatch/incidents.json')).incidents as Array<{ slug: string; title: string; summary?: string; url: string; cveIds?: string[]; tags?: string[]; product?: string }>
  const kev = JSON.parse(read('kev.json')).vulnerabilities as Array<{ cveID: string; vendorProject?: string; product?: string; vulnerabilityName?: string; shortDescription?: string }>
  return [
    ...inc.map((i) => ({ source: 'demo:pwn.watch', sourceId: i.slug, title: `${DEMO_PREFIX} ${i.title}`, text: i.summary ?? '', url: i.url, cveIds: (i.cveIds ?? []).map((c) => c.toUpperCase()), tags: i.tags ?? [], vendors: [i.product ?? ''].filter(Boolean) })),
    ...kev.map((k) => ({ source: 'demo:cisa-kev', sourceId: k.cveID, title: `${DEMO_PREFIX} ${k.cveID}: ${k.vulnerabilityName ?? ''}`, text: k.shortDescription ?? '', url: `https://nvd.nist.gov/vuln/detail/${k.cveID}`, cveIds: [k.cveID.toUpperCase()], tags: ['cisa-kev'], vendors: [k.vendorProject ?? '', k.product ?? ''].filter(Boolean) })),
  ]
}
export const DEMO_PREFIX = '[DEMO]'

function fixturesDir() {
  const candidates = [process.env.FIXTURES_DIR, path.resolve(process.cwd(), 'fixtures'), path.resolve(process.cwd(), 'test/fixtures'), path.resolve(process.cwd(), 'apps/web/test/fixtures')].filter(Boolean) as string[]
  for (const c of candidates) {
    try {
      readFileSync(path.join(c, 'kev.json'))
      return c
    } catch {
      /* try next */
    }
  }
  throw new Error('Fixture files not found. Set FIXTURES_DIR to apps/web/test/fixtures.')
}

export async function loadDemoFixtures(orgId: string, userId: string) {
  const db = getDb()
  const [existing] = await db.select({ id: huntCases.id }).from(huntCases).where(and(eq(huntCases.orgId, orgId), eq(huntCases.title, `${DEMO_PREFIX} Suspicious PowerShell on demo workstations`))).limit(1)
  if (existing) return { loaded: false, reason: 'already loaded' }
  const [org] = await db.select().from(orgs).where(eq(orgs.id, orgId)).limit(1)
  if (!org) throw new Error('Org not found.')

  if (!env().HUNTING_DEMO_MODE || (await getConnector(orgId))) {
    throw new DemoFixturesError('Demo data needs hunting demo mode: HUNTING_DEMO_MODE=true and no hunting connector for this org.')
  }

  const dir = fixturesDir()
  const read = (f: string) => readFileSync(path.join(dir, f), 'utf8')
  const records = fixtureRecords(read)

  const incidents = JSON.parse(read('pwnwatch/incidents.json')).incidents as Array<{ cveIds: string[]; tags: string[] }>
  const firstCve = incidents.find((i) => i.cveIds.length)?.cveIds[0]
  const entries = [
    { type: 'tag' as const, value: 'cisa-kev', notes: `${DEMO_PREFIX} sample watch` },
    ...(firstCve ? [{ type: 'cve' as const, value: firstCve, notes: `${DEMO_PREFIX} sample watch` }] : []),
    { type: 'keyword' as const, value: 'auth bypass', notes: `${DEMO_PREFIX} sample watch` },
  ]
  const have = await db.select({ value: watchEntries.normalized }).from(watchEntries).where(eq(watchEntries.orgId, orgId))
  for (const w of entries) if (!have.some((h) => h.value.toLowerCase() === w.value.toLowerCase())) await addWatch(orgId, userId, w)
  await runMatcher({ orgId, records })

  const hunt = await createHunt(orgId, userId, {
    title: `${DEMO_PREFIX} Suspicious PowerShell on demo workstations`,
    hypothesis: 'Encoded PowerShell launched by Office apps on demo-wks-* hosts (fixture data, no real tenant).',
  })
  const p1 = await proposeKql(orgId, { type: 'agent', id: 'hunter' }, {
    huntId: hunt.id,
    target: 'defender',
    kql: 'DeviceProcessEvents | where Timestamp > ago(7d) | where FileName =~ "powershell.exe" and ProcessCommandLine has "-enc" | take 50',
    rationale: `${DEMO_PREFIX} Encoded command lines are a common loader pattern.`,
  })
  await approveAndRunKql(orgId, userId, p1.id)
  await proposeKql(orgId, { type: 'agent', id: 'hunter' }, {
    huntId: hunt.id,
    target: 'sentinel',
    kql: 'SecurityEvent | where TimeGenerated > ago(1d) | where EventID == 4625 | summarize count() by Account | take 20',
    rationale: `${DEMO_PREFIX} Pending review: failed sign-ins around the same window.`,
  })

  const proposal = await createProposal(
    orgId,
    { type: 'agent', agentKey: 'responder', onBehalfOfUserId: userId },
    {
      title: `${DEMO_PREFIX} Isolate demo-wks-001`,
      actionType: 'logic_app',
      targets: { devices: ['demo-wks-001'] },
      blastRadius: { summary: 'One demo workstation would lose network access except to Defender. Fixture only.' },
      payload: { action: 'isolate', demo: true },
      huntId: hunt.id,
    },
  )
  // Dry run is computed locally and never calls anything; requires an approver role, so do it directly.
  await dryRunProposal(orgId, { userId, role: 'owner' }, proposal.id).catch(() => undefined)
  await writeAudit({ category: 'system', action: 'fixtures_loaded', actorType: 'user', actorId: userId, orgId, data: { huntId: hunt.id, proposalId: proposal.id } })
  return { loaded: true, huntId: hunt.id, proposalId: proposal.id }
}

/** Remove demo records for an org (hunts, proposals, demo hits, watches marked [DEMO]). */
export async function resetDemoFixtures(orgId: string) {
  const db = getDb()
  const { like } = await import('drizzle-orm')
  const { watchHits } = await import('../db/schema')
  await db.delete(watchHits).where(and(eq(watchHits.orgId, orgId), like(watchHits.source, 'demo:%')))
  await db.delete(responseProposals).where(and(eq(responseProposals.orgId, orgId), like(responseProposals.title, `${DEMO_PREFIX}%`)))
  const hunts = await db.select({ id: huntCases.id }).from(huntCases).where(and(eq(huntCases.orgId, orgId), like(huntCases.title, `${DEMO_PREFIX}%`)))
  for (const h of hunts) {
    await db.delete(kqlProposals).where(eq(kqlProposals.huntId, h.id))
    await db.delete(huntCases).where(eq(huntCases.id, h.id))
  }
  await db.delete(watchEntries).where(and(eq(watchEntries.orgId, orgId), like(watchEntries.notes, `${DEMO_PREFIX}%`)))
  return { hunts: hunts.length }
}
