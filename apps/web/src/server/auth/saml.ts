import { and, eq } from 'drizzle-orm'
import { getDb } from '../db/client'
import { orgMemberships, ssoOrgBindings } from '../db/schema'
import { addMembership } from '../orgs'
import { writeAudit } from '../audit'

/**
 * SAML SSO helpers (#65). Org mapping rule: each SAML provider is bound to exactly one Crosswire org
 * (`sso_org_bindings`). Users who sign in through a bound provider join that org as analyst.
 * Providers without a binding grant no org access (the user cannot reach /app).
 */

/** Only owners of at least one org may register SAML providers (Better Auth `providersLimit`). */
export async function samlProvidersLimit(user: { id: string }) {
  const [owner] = await getDb()
    .select({ orgId: orgMemberships.orgId })
    .from(orgMemberships)
    .where(and(eq(orgMemberships.userId, user.id), eq(orgMemberships.role, 'owner')))
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
  await addMembership(binding.orgId, user.id, 'analyst')
  await writeAudit({ category: 'auth', action: 'saml_linked', actorType: 'user', actorId: user.id, orgId: binding.orgId, data: { providerId: provider.providerId } })
  return binding.orgId
}

export class SamlBindingError extends Error {}

/** Owner binds a provider they registered to their current org. */
export async function bindOwnProvider(providerId: string, orgId: string, userId: string, role: string) {
  if (role !== 'owner') throw new SamlBindingError('Only org owners can bind SAML providers.')
  const { ssoProvider } = await import('../db/schema')
  const [p] = await getDb().select().from(ssoProvider).where(and(eq(ssoProvider.providerId, providerId), eq(ssoProvider.userId, userId))).limit(1)
  if (!p) throw new SamlBindingError('Provider not found or not registered by you.')
  await bindProviderToOrg(providerId, orgId, userId)
  await writeAudit({ category: 'auth', action: 'saml_provider_bound', actorType: 'user', actorId: userId, orgId, data: { providerId } })
}
