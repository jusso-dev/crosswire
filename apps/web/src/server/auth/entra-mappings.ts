import { and, asc, count, desc, eq } from 'drizzle-orm'
import { getDb } from '../db/client'
import { account, entraRoleMappings, orgs } from '../db/schema'
import { isOrgOwner, MemberChangeError, type OrgRole } from '../orgs'
import { writeAudit } from '../audit'
import { decideEntraRole, decodeJwtClaims, type EntraClaims } from './entra'

/**
 * Owner-managed Entra group and app-role mappings (owner request, #195). Every write re-checks that
 * the actor is an owner of this org on a fresh row and is audited. Mappings belong to one org.
 */

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// Entra app role values: no spaces, letters, digits and . _ - (the portal refuses others).
const APP_ROLE = /^[A-Za-z0-9._-]{1,120}$/

export function normaliseMappingValue(kind: 'group' | 'app_role', raw: string): string {
  const v = raw.trim()
  if (kind === 'group') {
    if (!GUID.test(v)) throw new MemberChangeError('Enter the group Object ID from Entra, for example 1b2c3d4e-0000-1111-2222-333344445555.')
    return v.toLowerCase()
  }
  if (!APP_ROLE.test(v)) throw new MemberChangeError('Enter the app role Value from the app registration, for example Crosswire.Approver. Spaces are not allowed.')
  return v
}

async function requireOwner(orgId: string, actorId: string) {
  if (!(await isOrgOwner(orgId, actorId))) throw new MemberChangeError('Only owners can change Entra group mappings.')
}

export async function listEntraMappings(orgId: string) {
  const [org] = await getDb().select({ requireGroup: orgs.entraRequireMappedGroup, tid: orgs.entraTenantId }).from(orgs).where(eq(orgs.id, orgId)).limit(1)
  const mappings = await getDb()
    .select({ id: entraRoleMappings.id, kind: entraRoleMappings.kind, value: entraRoleMappings.value, role: entraRoleMappings.role, createdAt: entraRoleMappings.createdAt })
    .from(entraRoleMappings)
    .where(eq(entraRoleMappings.orgId, orgId))
    .orderBy(asc(entraRoleMappings.createdAt))
  return { tenantBound: Boolean(org?.tid), requireMappedGroup: org?.requireGroup ?? false, mappings }
}

export async function addEntraMapping(orgId: string, actorId: string, input: { kind: 'group' | 'app_role'; value: string; role: OrgRole }) {
  await requireOwner(orgId, actorId)
  const value = normaliseMappingValue(input.kind, input.value)
  const [row] = await getDb().insert(entraRoleMappings).values({ orgId, kind: input.kind, value, role: input.role, createdBy: actorId }).onConflictDoNothing().returning({ id: entraRoleMappings.id })
  if (!row) throw new MemberChangeError('That group or app role is already mapped. Remove it first to change its role.')
  await writeAudit({ category: 'auth', action: 'entra_mapping_added', actorType: 'user', actorId, orgId, targetType: 'entra_mapping', targetId: row.id, data: { kind: input.kind, value, role: input.role } })
  return row
}

export async function removeEntraMapping(orgId: string, actorId: string, id: string) {
  await requireOwner(orgId, actorId)
  const removed = await getDb().transaction(async (tx) => {
    const [org] = await tx.select({ requireGroup: orgs.entraRequireMappedGroup }).from(orgs).where(eq(orgs.id, orgId)).for('update')
    if (org?.requireGroup) {
      const [{ n }] = (await tx.select({ n: count() }).from(entraRoleMappings).where(eq(entraRoleMappings.orgId, orgId))) as [{ n: number }]
      if (n <= 1) throw new MemberChangeError('This is the last mapping, and only people in a mapped group can sign in. Turn that setting off first, or nobody could sign in.')
    }
    const [row] = await tx
      .delete(entraRoleMappings)
      .where(and(eq(entraRoleMappings.id, id), eq(entraRoleMappings.orgId, orgId)))
      .returning({ kind: entraRoleMappings.kind, value: entraRoleMappings.value, role: entraRoleMappings.role })
    return row
  })
  if (!removed) throw new MemberChangeError('That mapping no longer exists.')
  await writeAudit({ category: 'auth', action: 'entra_mapping_removed', actorType: 'user', actorId, orgId, targetType: 'entra_mapping', targetId: id, data: removed })
  return removed
}

/** Claims from the actor's last Entra sign-in, without the freshness check sign-in uses. */
async function lastStoredClaims(userId: string): Promise<EntraClaims | null> {
  const [row] = await getDb()
    .select({ idToken: account.idToken })
    .from(account)
    .where(and(eq(account.userId, userId), eq(account.providerId, 'microsoft')))
    .orderBy(desc(account.updatedAt))
    .limit(1)
  return row?.idToken ? (decodeJwtClaims(row.idToken) as EntraClaims) : null
}

/**
 * Owner turns "Only people in a mapped group can sign in" on or off. Turning it on is refused when
 * the owner's own last Entra sign-in matches no mapping, so an owner cannot lock themselves out.
 */
export async function setEntraRequireMappedGroup(orgId: string, actorId: string, on: boolean) {
  await requireOwner(orgId, actorId)
  const claims = on ? await lastStoredClaims(actorId) : null
  await getDb().transaction(async (tx) => {
    // Same lock as removeEntraMapping: its last-mapping check and this toggle must agree.
    await tx.select({ id: orgs.id }).from(orgs).where(eq(orgs.id, orgId)).for('update')
    if (on) {
      const mappings = await tx.select({ kind: entraRoleMappings.kind, value: entraRoleMappings.value, role: entraRoleMappings.role }).from(entraRoleMappings).where(eq(entraRoleMappings.orgId, orgId))
      if (mappings.length === 0) throw new MemberChangeError('Add at least one group or app role mapping first.')
      if (!claims || !decideEntraRole(mappings, claims).role) {
        throw new MemberChangeError('Your own last Microsoft sign-in matched no mapping, so turning this on would lock you out. Add a mapping for one of your groups, sign in again, then retry.')
      }
    }
    await tx.update(orgs).set({ entraRequireMappedGroup: on }).where(eq(orgs.id, orgId))
  })
  await writeAudit({ category: 'auth', action: 'entra_require_mapped_group_changed', actorType: 'user', actorId, orgId, data: { to: on } })
}
