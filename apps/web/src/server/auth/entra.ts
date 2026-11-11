import { and, desc, eq } from 'drizzle-orm'
import { getDb } from '../db/client'
import { account, entraRoleMappings, orgMemberships, orgs } from '../db/schema'
import { changeMemberRole, findOrgByEntraTenant, highestRole, placeSsoMember, slugify, type OrgRole } from '../orgs'
import { env } from '../env'
import { writeAudit } from '../audit'
import { claimBootstrapOwner } from '../ops/bootstrap'

/**
 * Entra org mapping rule (documented in docs/auth.md):
 * 1. The ID token `tid` claim is matched to `orgs.entra_tenant_id`.
 * 2. Unknown tenant: rejected by default. If ENTRA_AUTO_PROVISION_ORGS=true, a new org is
 *    created for that tenant at the first sign-in, and that person becomes its owner (#187).
 * 3. Group and app-role mappings (`entra_role_mappings`) set the member's role on every sign-in.
 */
export class UnknownTenantError extends Error {
  constructor(public readonly tid: string) {
    super('unknown_tenant')
  }
}

/** A sign-in refused by an org rule. `code` goes to /auth-error, which shows a plain message. */
export class EntraSignInRefused extends Error {
  constructor(public readonly code: 'NOT_IN_MAPPED_GROUP' | 'MEMBER_REMOVED' | 'ENTRA_TOKEN_STALE') {
    super(code)
  }
}

/** Claims Crosswire reads from the Entra ID token. */
export interface EntraClaims {
  tid?: unknown
  groups?: unknown
  roles?: unknown
  hasgroups?: unknown
  _claim_names?: unknown
  iat?: unknown
}

export interface EntraMapping {
  kind: 'group' | 'app_role'
  value: string
  role: OrgRole
}

const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

/**
 * Groups and app roles from the token. Group overage: when a user is in too many groups, Entra
 * leaves out `groups` and sends `_claim_names.groups` (or `hasgroups`) instead. Then group
 * membership is unknown, so no role is raised from groups (fail closed). Crosswire makes no Graph call.
 */
export function entraTokenMemberships(claims: EntraClaims) {
  const names = claims._claim_names
  const overage = claims.hasgroups === true || claims.hasgroups === 'true' || (typeof names === 'object' && names !== null && 'groups' in names)
  return { groups: overage ? [] : strings(claims.groups).map((g) => g.toLowerCase()), roles: strings(claims.roles), overage }
}

/** The highest mapped role the token matches, and which mappings matched. Pure. */
export function decideEntraRole(mappings: readonly EntraMapping[], claims: EntraClaims) {
  const { groups, roles, overage } = entraTokenMemberships(claims)
  const matched = mappings.filter((m) => (m.kind === 'group' ? groups.includes(m.value.toLowerCase()) : roles.includes(m.value)))
  return { role: highestRole(matched.map((m) => m.role)), matched: matched.map((m) => ({ kind: m.kind, value: m.value, role: m.role })), overage }
}

async function orgMappings(orgId: string): Promise<EntraMapping[]> {
  return getDb().select({ kind: entraRoleMappings.kind, value: entraRoleMappings.value, role: entraRoleMappings.role }).from(entraRoleMappings).where(eq(entraRoleMappings.orgId, orgId))
}

async function refuse(code: EntraSignInRefused['code'], orgId: string | null, userId: string | null, data: Record<string, unknown> = {}): Promise<never> {
  await writeAudit({ category: 'auth', action: 'sso_refused', result: 'failure', actorType: userId ? 'user' : 'system', actorId: userId, orgId, data: { reason: code.toLowerCase(), ...data } })
  throw new EntraSignInRefused(code)
}

/**
 * Check-only gate, run in `mapProfileToUser` before any user row exists (#187). It never creates an
 * org. Refuses an unknown tenant (unless auto-provision is on) and, when the org requires it, a
 * token that matches no mapping.
 */
export async function checkEntraGate(claims: EntraClaims) {
  const tid = typeof claims.tid === 'string' ? claims.tid : ''
  const org = tid ? await findOrgByEntraTenant(tid) : undefined
  if (!org) {
    if (tid && env().ENTRA_AUTO_PROVISION_ORGS) return
    throw new UnknownTenantError(tid)
  }
  if (org.entraRequireMappedGroup) {
    const d = decideEntraRole(await orgMappings(org.id), claims)
    if (!d.role) await refuse('NOT_IN_MAPPED_GROUP', org.id, null, { overage: d.overage })
  }
}

/**
 * The org for a tenant. With auto-provision, the first sign-in creates the org and makes this
 * person its owner in one transaction (#187). `on conflict (entra_tenant_id)` means two first
 * sign-ins at once create one org: the loser joins it like anyone else.
 */
export async function ensureEntraOrg(tid: string, userId: string): Promise<{ orgId: string; created: boolean }> {
  const existing = await findOrgByEntraTenant(tid)
  if (existing) return { orgId: existing.id, created: false }
  if (!env().ENTRA_AUTO_PROVISION_ORGS) throw new UnknownTenantError(tid)
  const name = env().ENTRA_ORG_NAME
  const created = await getDb().transaction(async (tx) => {
    const [row] = await tx.insert(orgs).values({ name, slug: slugify(name), entraTenantId: tid }).onConflictDoNothing({ target: orgs.entraTenantId }).returning({ id: orgs.id })
    if (!row) return null
    await tx.insert(orgMemberships).values({ orgId: row.id, userId, role: 'owner' })
    return row.id
  })
  if (created) {
    await writeAudit({ category: 'auth', action: 'entra_org_provisioned', actorType: 'user', actorId: userId, orgId: created, data: { tid } })
    return { orgId: created, created: true }
  }
  const raced = await findOrgByEntraTenant(tid)
  if (!raced) throw new UnknownTenantError(tid)
  return { orgId: raced.id, created: false }
}

/**
 * Place and sync an Entra user on every sign-in (#187, #195). Idempotent. Steps:
 * 1. Find (or, with auto-provision, create) the tenant's org.
 * 2. Refuse a person an owner removed, and, when the org requires it, a token that matches no mapping.
 * 3. New member: join with the highest mapped role, or analyst.
 * 4. Existing member: a mapping match sets the role (up or down) and marks it Entra-managed. With no
 *    match, a manual role is kept and an Entra-managed role drops to analyst.
 * Role changes go through changeMemberRole, so the last owner is never removed.
 */
export async function syncEntraSignIn(userId: string, claims: EntraClaims): Promise<string> {
  const tid = typeof claims.tid === 'string' ? claims.tid : ''
  if (!tid) throw new UnknownTenantError('')
  const { orgId, created } = await ensureEntraOrg(tid, userId)
  const [org] = await getDb().select({ requireGroup: orgs.entraRequireMappedGroup }).from(orgs).where(eq(orgs.id, orgId)).limit(1)
  const mappings = await orgMappings(orgId)
  const d = decideEntraRole(mappings, claims)
  if (org?.requireGroup && !d.role) await refuse('NOT_IN_MAPPED_GROUP', orgId, userId, { overage: d.overage })
  const auditData = { matched: d.matched, ...(d.overage ? { groupsOverage: true } : {}) }

  const placement = await placeSsoMember(orgId, userId, d.role ?? 'analyst', d.role ? 'entra' : 'manual')
  if (placement === 'removed') await refuse('MEMBER_REMOVED', orgId, userId)
  const joined = placement === 'joined'
  if (created || joined) await writeAudit({ category: 'auth', action: 'sso_linked', actorType: 'user', actorId: userId, orgId, data: { provider: 'microsoft' } })
  if (joined && d.role) await writeAudit({ category: 'auth', action: 'entra_role_synced', actorType: 'system', orgId, targetType: 'user', targetId: userId, data: { from: null, to: d.role, ...auditData } })
  // The org was found by this token's tenant, so the bootstrap email claim is tenant-bound (#188).
  await claimBootstrapOwner(orgId, userId, { tenantMatched: true })
  if (joined) return orgId

  const [m] = await getDb()
    .select({ role: orgMemberships.role, source: orgMemberships.roleSource })
    .from(orgMemberships)
    .where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.userId, userId)))
    .limit(1)
  if (!m) return orgId
  if (d.role) {
    await changeMemberRole({ orgId, userId, role: d.role, actorId: null, source: 'entra', audit: { action: 'entra_role_synced', data: auditData } })
  } else if (m.source === 'entra') {
    await changeMemberRole({ orgId, userId, role: 'analyst', actorId: null, source: 'manual', audit: { action: 'entra_role_synced', data: { ...auditData, reason: 'no_mapping_matched' } } })
  }
  return orgId
}

/** Kept for callers and tests that place a user by tenant id only (no group or role claims). */
export async function placeEntraUser(userId: string, tid: string) {
  return syncEntraSignIn(userId, { tid })
}

/**
 * Claims of the ID token from this sign-in. Better Auth stores it on the user's Microsoft account
 * row just before it creates the session. A token issued more than an hour ago is not this
 * sign-in's, so it is refused rather than trusted for roles.
 */
export async function latestEntraClaims(userId: string, now = Date.now()): Promise<EntraClaims> {
  const [row] = await getDb()
    .select({ idToken: account.idToken })
    .from(account)
    .where(and(eq(account.userId, userId), eq(account.providerId, 'microsoft')))
    .orderBy(desc(account.updatedAt))
    .limit(1)
  const claims = row?.idToken ? (decodeJwtClaims(row.idToken) as EntraClaims) : {}
  const iat = typeof claims.iat === 'number' ? claims.iat * 1000 : 0
  if (!iat || now - iat > 3_600_000) throw new EntraSignInRefused('ENTRA_TOKEN_STALE')
  return claims
}

/** Decode a JWT payload without verification. Only used on tokens Better Auth already validated. */
export function decodeJwtClaims(idToken: string): Record<string, unknown> {
  const part = idToken.split('.')[1]
  if (!part) return {}
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

/**
 * Entra omits the `email` claim for users without an Exchange mailbox (common for cloud-only
 * accounts). Fall back to the sign-in name (`preferred_username`, the UPN in this tenant) when it
 * looks like an address and `email` is truly absent. Returns the fields to merge into the user.
 *
 * A UPN is a sign-in name, not a proven mailbox, and can be reassigned. The fallback is therefore
 * always marked unverified (whatever `email_verified` says), so it can never implicitly link this
 * Entra identity to an existing local account with the same address. Org placement still uses the
 * token's tenant id, not the email.
 */
export function entraEmailFallback(profile: { email?: unknown; preferred_username?: unknown }): { email?: string; emailVerified?: boolean } {
  if (typeof profile.email === 'string' && profile.email) return {}
  const upn = typeof profile.preferred_username === 'string' ? profile.preferred_username.trim().toLowerCase() : ''
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(upn) ? { email: upn, emailVerified: false } : {}
}
