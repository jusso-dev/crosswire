import { and, count, eq } from 'drizzle-orm'
import { getDb } from '../db/client'
import { orgMemberships, orgs, user } from '../db/schema'
import { writeAudit } from '../audit'
import { addMembership, createOrg } from '../orgs'
import { responseSafety } from '../env'

export class BootstrapError extends Error {}

/**
 * First-install bootstrap (#78). Creates the first org and records the admin email.
 * - Refuses (hard fail) if any org already exists, so re-running is safe.
 * - If a user with ADMIN_EMAIL already exists (local sign-up), they become owner now. The operator
 *   runs this command, so this is their explicit choice (docs/runbooks/bootstrap.md).
 * - Otherwise the first SSO sign-in with that email, from the bound tenant or with a verified
 *   email, becomes owner (`orgs.bootstrap_owner_email`, #188). A later local sign-up cannot.
 * - Optional Entra tenant id binds the org for OIDC mapping.
 * Response safety is env-driven and fail-closed: dry-run ON and executors OFF unless explicitly
 * changed (see responseSafety). Bootstrap reports the effective state and refuses live executors.
 */
export async function bootstrap(input: { orgName: string; adminEmail: string; entraTenantId?: string }) {
  const db = getDb()
  // Personal workspaces from local sign-ups don't count; only a real (team) org blocks bootstrap.
  const [{ n }] = (await db.select({ n: count() }).from(orgs).where(eq(orgs.isPersonal, false))) as [{ n: number }]
  if (n > 0) throw new BootstrapError(`Refusing to bootstrap: ${n} org(s) already exist. For a lab reset, drop and recreate the database (docs/runbooks/bootstrap.md).`)
  const safety = responseSafety()
  const live = Object.entries(safety.executors).filter(([, v]) => v === 'on')
  if (!safety.dryRun || live.length > 0) {
    throw new BootstrapError('Refusing to bootstrap with live response execution enabled. Set RESPONSE_DRY_RUN=true (or unset) and RESPONSE_EXECUTOR_*=off, then retry.')
  }
  const email = input.adminEmail.trim().toLowerCase()
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new BootstrapError('ADMIN_EMAIL is not a valid email address.')
  // With a tenant, the admin's domain is the tenant's: local and SAML sign-ups for it are refused (#203).
  const org = await createOrg(input.orgName.trim() || 'Crosswire', { entraTenantId: input.entraTenantId || undefined, emailDomain: input.entraTenantId ? email.split('@')[1] : undefined })
  await db.update(orgs).set({ bootstrapOwnerEmail: email }).where(eq(orgs.id, org.id))
  const [existing] = await db.select({ id: user.id }).from(user).where(eq(user.email, email)).limit(1)
  if (existing) await addMembership(org.id, existing.id, 'owner')
  await writeAudit({
    category: 'system',
    action: 'bootstrap',
    actorType: 'system',
    orgId: org.id,
    data: { adminEmailDomain: email.split('@')[1], entraTenantBound: Boolean(input.entraTenantId), dryRun: safety.dryRun, executors: safety.executors },
  })
  return { orgId: org.id, adminLinked: Boolean(existing), dryRun: safety.dryRun, executors: safety.executors }
}

/**
 * Called when a user is placed into an org via SSO (#78, #188). The bootstrap email alone is not
 * proof: the person must also come from the org's own Entra tenant (`tenantMatched`, set by the
 * Entra path, which found the org by the token's `tid`) or have a verified email. Local sign-ups are
 * never verified, so they cannot claim it. The claim is taken once, atomically.
 */
export async function claimBootstrapOwner(orgId: string, userId: string, opts: { tenantMatched?: boolean } = {}) {
  const db = getDb()
  const [o] = await db.select({ email: orgs.bootstrapOwnerEmail, tid: orgs.entraTenantId }).from(orgs).where(eq(orgs.id, orgId)).limit(1)
  if (!o?.email) return false
  const [u] = await db.select({ email: user.email, verified: user.emailVerified }).from(user).where(eq(user.id, userId)).limit(1)
  if (!u || u.email.toLowerCase() !== o.email) return false
  const trusted = (opts.tenantMatched === true && o.tid !== null) || u.verified
  if (!trusted) {
    await writeAudit({ category: 'auth', action: 'bootstrap_owner_claim_refused', result: 'failure', actorType: 'user', actorId: userId, orgId, data: { reason: 'email_not_proven' } })
    return false
  }
  const claimed = await db.transaction(async (tx) => {
    const [taken] = await tx
      .update(orgs)
      .set({ bootstrapOwnerEmail: null })
      .where(and(eq(orgs.id, orgId), eq(orgs.bootstrapOwnerEmail, o.email!)))
      .returning({ id: orgs.id })
    if (!taken) return false
    const rows = await tx
      .update(orgMemberships)
      .set({ role: 'owner', roleSource: 'manual' })
      .where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.userId, userId)))
      .returning({ id: orgMemberships.id })
    if (rows.length !== 1) throw new Error('bootstrap claim: no membership row')
    return true
  })
  if (claimed) await writeAudit({ category: 'auth', action: 'bootstrap_owner_claimed', actorType: 'user', actorId: userId, orgId })
  return claimed
}
