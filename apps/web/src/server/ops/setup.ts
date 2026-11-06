import { and, count, eq, isNull } from 'drizzle-orm'
import { getDb } from '../db/client'
import { orgConnectors, orgs, ssoOrgBindings, watchEntries } from '../db/schema'
import { env, responseSafety } from '../env'

export interface SetupItem {
  key: 'sso' | 'hunting' | 'secrets' | 'watchlist' | 'dryrun'
  label: string
  done: boolean
  detail: string
  href: string
}

/**
 * First-run checklist (#79). Each item is derived from a real signal. Secrets: production requires
 * BETTER_AUTH_SECRET and APP_ENCRYPTION_KEY to boot, so "present" means set and not the dev default.
 */
export async function setupChecklist(orgId: string) {
  const db = getDb()
  const e = env()
  const [org] = await db.select().from(orgs).where(eq(orgs.id, orgId)).limit(1)
  const [conn] = await db.select({ id: orgConnectors.id }).from(orgConnectors).where(eq(orgConnectors.orgId, orgId)).limit(1)
  const [saml] = await db.select({ id: ssoOrgBindings.providerId }).from(ssoOrgBindings).where(eq(ssoOrgBindings.orgId, orgId)).limit(1)
  const [w] = (await db.select({ n: count() }).from(watchEntries).where(and(eq(watchEntries.orgId, orgId), isNull(watchEntries.disabledAt)))) as [{ n: number }]
  const safety = responseSafety(e)
  const ssoDone = Boolean((e.ENTRA_CLIENT_ID && e.ENTRA_CLIENT_SECRET && org?.entraTenantId) || saml)
  const secretsDone = Boolean(e.APP_ENCRYPTION_KEY) && !e.BETTER_AUTH_SECRET.startsWith('dev-only-insecure')
  const liveExec = Object.values(safety.executors).some((v) => v === 'on')
  const items: SetupItem[] = [
    { key: 'sso', label: 'Entra SSO connected', done: ssoDone, detail: ssoDone ? 'Entra app configured and this org is linked to its tenant.' : 'Set ENTRA_CLIENT_ID/SECRET and link this org to your tenant id.', href: 'https://github.com/jusso-dev/crosswire/blob/main/docs/auth.md#entra-id-oidc-issue-19' },
    { key: 'hunting', label: 'Hunting app registration connected', done: Boolean(conn), detail: conn ? 'Connector saved.' : 'Register the least-privilege hunting app and save the connector in Settings.', href: '/app/settings' },
    { key: 'secrets', label: 'Secrets present (Key Vault / env)', done: secretsDone, detail: secretsDone ? 'BETTER_AUTH_SECRET and APP_ENCRYPTION_KEY are set.' : 'Set BETTER_AUTH_SECRET and APP_ENCRYPTION_KEY (Key Vault in Azure).', href: 'https://github.com/jusso-dev/crosswire/blob/main/docs/configuration.md' },
    { key: 'watchlist', label: 'First watchlist entry created', done: w.n > 0, detail: `${w.n} active watch entr${w.n === 1 ? 'y' : 'ies'}.`, href: '/app/watches' },
    { key: 'dryrun', label: 'Dry-run confirmed ON, executors OFF', done: safety.dryRun && !liveExec, detail: safety.dryRun ? `Dry-run on. Executors: ${Object.entries(safety.executors).map(([k, v]) => `${k}=${v}`).join(', ')}.` : 'RESPONSE_DRY_RUN=false: live execution possible.', href: 'https://github.com/jusso-dev/crosswire/blob/main/docs/response.md' },
  ]
  return { items, complete: items.every((i) => i.done), dismissed: Boolean(org?.setupDismissedAt), safety }
}

export async function dismissSetup(orgId: string) {
  await getDb().update(orgs).set({ setupDismissedAt: new Date() }).where(eq(orgs.id, orgId))
}
