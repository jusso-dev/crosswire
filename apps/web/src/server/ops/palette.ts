import { and, desc, eq, gt } from 'drizzle-orm'
import { getDb } from '../db/client'
import { chatThreads, cveRecords, huntCases, responseProposals } from '../db/schema'

/**
 * Items for the command palette: recent hunts, this person's conversations, pending approvals and
 * recent CVE keys. Small capped lists, one round trip. Titles only, no bodies.
 */
export async function paletteIndex(orgId: string, userId: string) {
  const db = getDb()
  const [hunts, threads, approvals, cves] = await Promise.all([
    db.select({ id: huntCases.id, title: huntCases.title, status: huntCases.status }).from(huntCases).where(eq(huntCases.orgId, orgId)).orderBy(desc(huntCases.updatedAt)).limit(15),
    db
      .select({ id: chatThreads.id, title: chatThreads.title })
      .from(chatThreads)
      .where(and(eq(chatThreads.orgId, orgId), eq(chatThreads.userId, userId)))
      .orderBy(desc(chatThreads.updatedAt))
      .limit(15),
    db
      .select({ id: responseProposals.id, title: responseProposals.title })
      .from(responseProposals)
      .where(and(eq(responseProposals.orgId, orgId), eq(responseProposals.status, 'pending'), gt(responseProposals.expiresAt, new Date())))
      .orderBy(desc(responseProposals.createdAt))
      .limit(15),
    db.selectDistinct({ cveId: cveRecords.cveId, publishedAt: cveRecords.publishedAt }).from(cveRecords).where(eq(cveRecords.source, 'cisa-kev')).orderBy(desc(cveRecords.publishedAt)).limit(15),
  ])
  return { hunts, threads, approvals, intel: [...new Set(cves.map((c) => c.cveId))] }
}
