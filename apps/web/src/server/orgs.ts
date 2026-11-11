import { and, asc, eq, sql } from 'drizzle-orm'
import { getDb } from './db/client'
import { orgMemberRemovals, orgMemberships, orgs, user } from './db/schema'
import { writeAudit } from './audit'
import { logger } from './lib/logger'

export type OrgRole = (typeof orgMemberships.$inferSelect)['role']
export type RoleSource = (typeof orgMemberships.$inferSelect)['roleSource']

/** Higher number, more rights. */
export const ROLE_RANK: Record<OrgRole, number> = { analyst: 0, approver: 1, owner: 2 }

/** The role with the most rights in the list, or null for an empty list. */
export function highestRole(roles: readonly OrgRole[]): OrgRole | null {
  let best: OrgRole | null = null
  for (const r of roles) if (best === null || ROLE_RANK[r] > ROLE_RANK[best]) best = r
  return best
}

export interface CurrentOrg {
  id: string
  name: string
  slug: string
  role: OrgRole
}

export function slugify(input: string) {
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

/** Idempotent: an existing membership is left as it is. Returns true when a row was inserted. */
export async function addMembership(orgId: string, userId: string, role: OrgRole, roleSource: RoleSource = 'manual') {
  const rows = await getDb().insert(orgMemberships).values({ orgId, userId, role, roleSource }).onConflictDoNothing().returning({ id: orgMemberships.id })
  return rows.length > 0
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
    .select({ userId: user.id, email: user.email, name: user.name, role: orgMemberships.role, roleSource: orgMemberships.roleSource })
    .from(orgMemberships)
    .innerJoin(user, eq(user.id, orgMemberships.userId))
    .where(eq(orgMemberships.orgId, orgId))
}

/** Test helper only: sets a role with no checks. App code uses changeMemberRole. */
export async function setMemberRole(orgId: string, userId: string, role: OrgRole) {
  await getDb().update(orgMemberships).set({ role }).where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.userId, userId)))
}

export async function isOrgOwner(orgId: string, userId: string) {
  const [m] = await getDb()
    .select({ id: orgMemberships.id })
    .from(orgMemberships)
    .where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.userId, userId), eq(orgMemberships.role, 'owner')))
    .limit(1)
  return Boolean(m)
}

/** A refused membership change. The message is plain words, safe to show. */
export class MemberChangeError extends Error {}

type Db = ReturnType<typeof getDb>
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

/**
 * Lock the org's owner rows (#202), in a fixed order so two changes cannot deadlock. A second
 * change for the same org waits here until the first commits, then sees its result.
 */
async function lockOwners(tx: Tx, orgId: string) {
  const rows = await tx
    .select({ userId: orgMemberships.userId })
    .from(orgMemberships)
    .where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.role, 'owner')))
    .orderBy(asc(orgMemberships.id))
    .for('update')
  return rows.map((r) => r.userId)
}

async function lockMember(tx: Tx, orgId: string, userId: string) {
  const [m] = await tx
    .select({ role: orgMemberships.role, roleSource: orgMemberships.roleSource })
    .from(orgMemberships)
    .where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.userId, userId)))
    .for('update')
  return m
}

const roleListeners = new Set<(e: { orgId: string; userId: string; oldRole: OrgRole; newRole: OrgRole | null }) => Promise<void> | void>()

/**
 * Side effects when a member's role goes down or they are removed (`newRole` null). Manual changes,
 * Entra sync and removal all call this, after their change commits.
 */
export async function onRoleLowered(orgId: string, userId: string, oldRole: OrgRole, newRole: OrgRole | null) {
  logger.info('member role lowered', { orgId, userId, oldRole, newRole })
  // Repeat searches this person approved stop once they can no longer approve (#189). Imported
  // lazily: the hunting module imports this one.
  const { canApprove } = await import('./response/rbac')
  if (newRole === null || !canApprove(newRole)) {
    const { disableSchedulesApprovedBy } = await import('./hunting/schedules')
    const why = newRole === null ? 'the person who approved it was removed from the organisation' : 'the person who approved it is no longer an owner or approver'
    await disableSchedulesApprovedBy(orgId, userId, `${why}; re-approve to resume`)
  }
  for (const fn of roleListeners) await fn({ orgId, userId, oldRole, newRole })
}

/** Test hook: observe onRoleLowered calls. Returns an unsubscribe function. */
export function listenRoleLoweredForTests(fn: (e: { orgId: string; userId: string; oldRole: OrgRole; newRole: OrgRole | null }) => void) {
  roleListeners.add(fn)
  return () => void roleListeners.delete(fn)
}

export interface RoleChangeInput {
  orgId: string
  userId: string
  role: OrgRole
  /** The owner making a manual change. Null for Entra sync, which has no acting person. */
  actorId: string | null
  /** Set role_source. Omit to keep it: a manual change to an Entra-managed member stays Entra-managed. */
  source?: RoleSource
  /** Audit action and extra data. */
  audit: { action: string; data?: Record<string, unknown> }
}

export type RoleChangeResult = { changed: boolean; from: OrgRole; to: OrgRole; blocked?: 'last_owner' }

/**
 * The one way to change a member's role (#202). In one transaction it locks the org's owners and the
 * target row, re-checks that the acting person is still an owner, and refuses any change that would
 * leave the org with no owner. Exactly one row must change. The audit row records `from` and `to`.
 *
 * Manual changes (actorId set) throw MemberChangeError when refused. Entra sync (actorId null) gets
 * `blocked: 'last_owner'` instead, so a sign-in is never refused because of it.
 */
export async function changeMemberRole(input: RoleChangeInput): Promise<RoleChangeResult> {
  const { orgId, userId, role, actorId } = input
  const result = await getDb().transaction(async (tx): Promise<RoleChangeResult> => {
    const owners = await lockOwners(tx, orgId)
    if (actorId !== null) {
      if (!owners.includes(actorId)) throw new MemberChangeError('Only owners can change roles.')
      if (actorId === userId) throw new MemberChangeError('You cannot change your own role. Ask another owner.')
    }
    const current = await lockMember(tx, orgId, userId)
    if (!current) throw new MemberChangeError('That person is not a member of this organisation.')
    const source = input.source ?? current.roleSource
    if (current.role === role) {
      if (source !== current.roleSource) {
        await tx.update(orgMemberships).set({ roleSource: source }).where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.userId, userId)))
      }
      return { changed: false, from: current.role, to: role }
    }
    if (current.role === 'owner' && owners.filter((o) => o !== userId).length === 0) {
      if (actorId !== null) throw new MemberChangeError('This is the last owner. Make someone else an owner first.')
      return { changed: false, from: current.role, to: current.role, blocked: 'last_owner' }
    }
    const updated = await tx
      .update(orgMemberships)
      .set({ role, roleSource: source })
      .where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.userId, userId)))
      .returning({ id: orgMemberships.id })
    if (updated.length !== 1) throw new MemberChangeError('That person is not a member of this organisation.')
    return { changed: true, from: current.role, to: role }
  })
  if (result.changed || result.blocked) {
    await writeAudit({
      category: 'auth',
      action: result.blocked ? `${input.audit.action}_blocked_last_owner` : input.audit.action,
      result: result.blocked ? 'failure' : 'success',
      actorType: actorId ? 'user' : 'system',
      actorId: actorId ?? null,
      orgId,
      targetType: 'user',
      targetId: userId,
      data: { from: result.from, to: result.blocked ? role : result.to, ...input.audit.data },
    })
  }
  if (result.blocked) logger.warn('role change would leave no owner; kept', { orgId, userId, requested: role })
  if (result.changed && ROLE_RANK[result.to] < ROLE_RANK[result.from]) await onRoleLowered(orgId, userId, result.from, result.to)
  return result
}

/**
 * Owner removes a member (#195). Same locks and last-owner guard as a role change. A removal row
 * keeps the person out on later SSO sign-ins until it is deleted (docs/auth.md).
 */
export async function removeMember(orgId: string, userId: string, actorId: string) {
  const removed = await getDb().transaction(async (tx) => {
    const owners = await lockOwners(tx, orgId)
    if (!owners.includes(actorId)) throw new MemberChangeError('Only owners can remove people.')
    if (actorId === userId) throw new MemberChangeError('You cannot remove yourself. Ask another owner.')
    const current = await lockMember(tx, orgId, userId)
    if (!current) throw new MemberChangeError('That person is not a member of this organisation.')
    if (current.role === 'owner' && owners.filter((o) => o !== userId).length === 0) throw new MemberChangeError('This is the last owner. Make someone else an owner first.')
    const rows = await tx
      .delete(orgMemberships)
      .where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.userId, userId)))
      .returning({ id: orgMemberships.id })
    if (rows.length !== 1) throw new MemberChangeError('That person is not a member of this organisation.')
    await tx.insert(orgMemberRemovals).values({ orgId, userId, removedBy: actorId }).onConflictDoNothing()
    return current.role
  })
  await writeAudit({ category: 'auth', action: 'member_removed', actorType: 'user', actorId, orgId, targetType: 'user', targetId: userId, data: { from: removed } })
  await onRoleLowered(orgId, userId, removed, null)
  return { from: removed }
}

/** True when an owner removed this person from the org (#195). */
export async function isRemovedMember(orgId: string, userId: string) {
  const [r] = await getDb()
    .select({ id: orgMemberRemovals.id })
    .from(orgMemberRemovals)
    .where(and(eq(orgMemberRemovals.orgId, orgId), eq(orgMemberRemovals.userId, userId)))
    .limit(1)
  return Boolean(r)
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
