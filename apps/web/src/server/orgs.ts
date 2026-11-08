import { and, asc, eq, sql } from 'drizzle-orm'
import { getDb } from './db/client'
import { orgMemberships, orgs, user } from './db/schema'

export type OrgRole = (typeof orgMemberships.$inferSelect)['role']

export interface CurrentOrg {
  id: string
  name: string
  slug: string
  role: OrgRole
}

function slugify(input: string) {
  const base = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return `${base || 'org'}-${crypto.randomUUID().slice(0, 8)}`
}

export async function createOrg(name: string, opts: { entraTenantId?: string; emailDomain?: string; isPersonal?: boolean } = {}) {
  const [row] = await getDb()
    .insert(orgs)
    .values({ name, slug: slugify(name), entraTenantId: opts.entraTenantId, emailDomain: opts.emailDomain, isPersonal: opts.isPersonal ?? false })
    .returning()
  if (!row) throw new Error('failed to create org')
  return row
}

export async function addMembership(orgId: string, userId: string, role: OrgRole) {
  await getDb().insert(orgMemberships).values({ orgId, userId, role }).onConflictDoNothing()
}

export async function findOrgByEntraTenant(tid: string) {
  const [row] = await getDb().select().from(orgs).where(eq(orgs.entraTenantId, tid)).limit(1)
  return row
}

/** Ensure a user has at least one org. Local sign-ups get a personal org where they are owner. */
export async function ensurePersonalOrg(userId: string, displayName: string) {
  const existing = await getDb().select({ id: orgMemberships.orgId }).from(orgMemberships).where(eq(orgMemberships.userId, userId)).limit(1)
  if (existing.length > 0) return
  const org = await createOrg(`${displayName}'s workspace`, { isPersonal: true })
  await addMembership(org.id, userId, 'owner')
}

/**
 * Resolve the active org for a user. v1: one workspace == org; a team org wins over a personal
 * workspace, then the oldest membership is active unless `preferredOrgId` names another org they belong to.
 */
export async function getCurrentOrg(userId: string, preferredOrgId?: string | null): Promise<CurrentOrg | null> {
  const rows = await getDb()
    .select({ id: orgs.id, name: orgs.name, slug: orgs.slug, role: orgMemberships.role })
    .from(orgMemberships)
    .innerJoin(orgs, eq(orgs.id, orgMemberships.orgId))
    .where(eq(orgMemberships.userId, userId))
    // Team orgs before personal workspaces, then oldest membership first.
    .orderBy(asc(orgs.isPersonal), asc(orgMemberships.createdAt))
  if (rows.length === 0) return null
  return rows.find((r) => r.id === preferredOrgId) ?? rows[0] ?? null
}

export async function listOrgMembers(orgId: string) {
  return getDb()
    .select({ userId: user.id, email: user.email, name: user.name, role: orgMemberships.role })
    .from(orgMemberships)
    .innerJoin(user, eq(user.id, orgMemberships.userId))
    .where(eq(orgMemberships.orgId, orgId))
}

export async function setMemberRole(orgId: string, userId: string, role: OrgRole) {
  await getDb().update(orgMemberships).set({ role }).where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.userId, userId)))
}

/**
 * Digest recipients for one org: each owner's confirmed digest address (#102), or their sign-in
 * email when they have not set one. Only that org's own owner memberships, de-duplicated.
 */
export async function listOrgOwnerEmails(orgId: string) {
  const rows = await getDb()
    .select({ email: sql<string>`coalesce(${orgMemberships.digestEmail}, ${user.email})` })
    .from(orgMemberships)
    .innerJoin(user, eq(user.id, orgMemberships.userId))
    .where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.role, 'owner')))
  // Case-insensitive: digest addresses are stored lowercased, sign-in emails may not be.
  return [...new Map(rows.map((r) => [r.email.toLowerCase(), r.email])).values()]
}
