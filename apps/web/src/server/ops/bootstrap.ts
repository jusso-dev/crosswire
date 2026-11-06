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
 * - If a user with ADMIN_EMAIL already exists (local sign-up), they become owner now.
 * - Otherwise the first SSO sign-in with that email becomes owner (`orgs.bootstrap_owner_email`).
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
  const org = await createOrg(input.orgName.trim() || 'Crosswire', { entraTenantId: input.entraTenantId || undefined })
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
 * Called when a user is placed into an org via SSO: if they match the org's bootstrap email they
 * become owner (once), then the bootstrap email is cleared.
 */
/**
 * Local sign-up path (#78): if a pending bootstrap org names this email, join it as owner instead of
 * creating a personal workspace. Only verified-by-construction for email/password sign-up because
 * production disables it (AUTH_EMAIL_PASSWORD=false); docs say to bootstrap before opening sign-up.
 */
export async function claimPendingBootstrapByEmail(userId: string, email: string) {
  const db = getDb()
  const [o] = await db.select({ id: orgs.id }).from(orgs).where(eq(orgs.bootstrapOwnerEmail, email.toLowerCase())).limit(1)
  if (!o) return null
  await addMembership(o.id, userId, 'owner')
  await claimBootstrapOwner(o.id, userId)
  return o.id
}

export async function claimBootstrapOwner(orgId: string, userId: string) {
  const db = getDb()
  const [o] = await db.select({ email: orgs.bootstrapOwnerEmail }).from(orgs).where(eq(orgs.id, orgId)).limit(1)
  if (!o?.email) return false
  const [u] = await db.select({ email: user.email }).from(user).where(eq(user.id, userId)).limit(1)
  if (!u || u.email.toLowerCase() !== o.email) return false
  await db.update(orgMemberships).set({ role: 'owner' }).where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.userId, userId)))
  await db.update(orgs).set({ bootstrapOwnerEmail: null }).where(eq(orgs.id, orgId))
  await writeAudit({ category: 'auth', action: 'bootstrap_owner_claimed', actorType: 'user', actorId: userId, orgId })
  return true
}
