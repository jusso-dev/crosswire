import { addMembership, createOrg, findOrgByEntraTenant } from '../orgs'
import { env } from '../env'
import { claimBootstrapOwner } from '../ops/bootstrap'

/**
 * Entra org mapping rule (documented in docs/auth.md):
 * 1. The ID token `tid` claim is matched to `orgs.entra_tenant_id`.
 * 2. Unknown tenant: rejected by default. If ENTRA_AUTO_PROVISION_ORGS=true, a new org is
 *    created for that tenant and the first user becomes its owner (later users join as analyst).
 */
export class UnknownTenantError extends Error {
  constructor(public readonly tid: string) {
    super('unknown_tenant')
  }
}

export async function resolveEntraOrg(tid: string): Promise<{ orgId: string; created: boolean }> {
  const existing = await findOrgByEntraTenant(tid)
  if (existing) return { orgId: existing.id, created: false }
  if (!env().ENTRA_AUTO_PROVISION_ORGS) throw new UnknownTenantError(tid)
  const org = await createOrg(env().ENTRA_ORG_NAME, { entraTenantId: tid })
  return { orgId: org.id, created: true }
}

export async function placeEntraUser(userId: string, tid: string) {
  const { orgId, created } = await resolveEntraOrg(tid)
  await addMembership(orgId, userId, created ? 'owner' : 'analyst')
  await claimBootstrapOwner(orgId, userId)
  return orgId
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
 */
export function entraEmailFallback(profile: { email?: unknown; preferred_username?: unknown }): { email?: string } {
  if (typeof profile.email === 'string' && profile.email) return {}
  const upn = typeof profile.preferred_username === 'string' ? profile.preferred_username.trim().toLowerCase() : ''
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(upn) ? { email: upn } : {}
}
