import { and, eq } from 'drizzle-orm'
import { getDb } from '../db/client'
import { orgMemberships, orgs, ssoOrgBindings } from '../db/schema'
import { addMembership, isRemovedMember } from '../orgs'
import { writeAudit } from '../audit'

/**
 * SAML SSO helpers (#65). Org mapping rule: each SAML provider is bound to exactly one Crosswire org
 * (`sso_org_bindings`). Users who sign in through a bound provider join that org as analyst.
 * Providers without a binding grant no org access (the user cannot reach /app).
 */

/**
 * Only owners of a team org may register SAML providers (Better Auth `providersLimit`, #203). Owning
 * a personal workspace, which every local sign-up does, is not enough.
 */
export async function samlProvidersLimit(user: { id: string }) {
  const [owner] = await getDb()
    .select({ orgId: orgMemberships.orgId })
    .from(orgMemberships)
    .innerJoin(orgs, eq(orgs.id, orgMemberships.orgId))
    .where(and(eq(orgMemberships.userId, user.id), eq(orgMemberships.role, 'owner'), eq(orgs.isPersonal, false)))
    .limit(1)
  return owner ? 5 : 0
}

export async function bindProviderToOrg(providerId: string, orgId: string, userId: string) {
  await getDb().insert(ssoOrgBindings).values({ providerId, orgId, createdBy: userId }).onConflictDoUpdate({ target: ssoOrgBindings.providerId, set: { orgId } })
}

/** Better Auth `provisionUser` callback: place the user into the provider's bound org. */
export async function provisionSamlUser({ user, provider }: { user: { id: string }; provider: { providerId: string } }) {
  const [binding] = await getDb().select().from(ssoOrgBindings).where(eq(ssoOrgBindings.providerId, provider.providerId)).limit(1)
  if (!binding) {
    await writeAudit({ category: 'auth', action: 'saml_unbound_provider', result: 'failure', actorType: 'user', actorId: user.id, data: { providerId: provider.providerId } })
    return null
  }
  // A person an owner removed is not added back (#195).
  if (await isRemovedMember(binding.orgId, user.id)) {
    await writeAudit({ category: 'auth', action: 'sso_refused', result: 'failure', actorType: 'user', actorId: user.id, orgId: binding.orgId, data: { reason: 'member_removed', providerId: provider.providerId } })
    return null
  }
  await addMembership(binding.orgId, user.id, 'analyst')
  // Needs a verified email (#188): SAML has no tenant id to bind the claim to.
  const { claimBootstrapOwner } = await import('../ops/bootstrap')
  await claimBootstrapOwner(binding.orgId, user.id)
  await writeAudit({ category: 'auth', action: 'saml_linked', actorType: 'user', actorId: user.id, orgId: binding.orgId, data: { providerId: provider.providerId } })
  return binding.orgId
}

export class SamlBindingError extends Error {}

/** Owner binds a provider they registered to their current org. */
export async function bindOwnProvider(providerId: string, orgId: string, userId: string, role: string) {
  if (role !== 'owner') throw new SamlBindingError('Only org owners can bind SAML providers.')
  const [org] = await getDb().select({ isPersonal: orgs.isPersonal }).from(orgs).where(eq(orgs.id, orgId)).limit(1)
  if (!org || org.isPersonal) throw new SamlBindingError('SAML providers can only be bound to a team organisation, not a personal workspace.')
  const { ssoProvider } = await import('../db/schema')
  const [p] = await getDb().select().from(ssoProvider).where(and(eq(ssoProvider.providerId, providerId), eq(ssoProvider.userId, userId))).limit(1)
  if (!p) throw new SamlBindingError('Provider not found or not registered by you.')
  await bindProviderToOrg(providerId, orgId, userId)
  await writeAudit({ category: 'auth', action: 'saml_provider_bound', actorType: 'user', actorId: userId, orgId, data: { providerId } })
}
