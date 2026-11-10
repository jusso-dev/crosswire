import { and, count, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm'
import { getDb } from '../db/client'
import { huntEvidence, orgConnectors, orgs, ssoOrgBindings, watchEntries } from '../db/schema'
import { env, responseSafety, type ResponseSafety } from '../env'

export interface SetupItem {
  key: 'sso' | 'hunting' | 'secrets' | 'watchlist' | 'dryrun'
  label: string
  done: boolean
  detail: string
  href: string
}

/**
 * Whether the hunting connector has actually worked, not just whether a row exists (#165).
 * - none: nothing saved.
 * - untested: saved (or changed) and no live search has run since.
 * - working: the most recent live search since the last save succeeded.
 * - failing: a search since the last success failed for a connector reason (token, permission, not configured).
 * Dates are ISO strings so the value crosses the server function boundary unchanged.
 */
export type ConnectorHealth =
  | { state: 'none' }
  | { state: 'untested'; savedAt: string }
  | { state: 'working'; lastOkAt: string }
  | { state: 'failing'; since: string; lastOkAt: string | null }

/**
 * Failures that say the connector itself is wrong. A query the service rejected (bad KQL, HTTP 400)
 * or a throttled call says nothing about the secret, so it does not turn the lamp to failing.
 */
const CONNECTOR_FAILURE = /Token request failed|token was rejected|Permission denied|not configured|HTTP 401|HTTP 403/i

/**
 * Derived from what the hunting code already records: every approved or scheduled search writes
 * `kql_result` / `scheduled_result` evidence with the data mode, or `kql_failed` / `scheduled_failed`
 * with the error. Only live results count (demo data never touches the tenant), and only events
 * after the connector was last saved, so a changed secret starts again at "Saved, not tested".
 */
export async function connectorHealth(orgId: string): Promise<ConnectorHealth> {
  const db = getDb()
  const [conn] = await db.select({ updatedAt: orgConnectors.updatedAt }).from(orgConnectors).where(eq(orgConnectors.orgId, orgId)).limit(1)
  if (!conn) return { state: 'none' }
  const savedAt = conn.updatedAt
  const [ok] = await db
    .select({ at: huntEvidence.createdAt })
    .from(huntEvidence)
    .where(and(eq(huntEvidence.orgId, orgId), gte(huntEvidence.createdAt, savedAt), inArray(huntEvidence.type, ['kql_result', 'scheduled_result']), sql`${huntEvidence.payload}->>'mode' = 'live'`))
    .orderBy(desc(huntEvidence.createdAt))
    .limit(1)
  const failures = await db
    .select({ at: huntEvidence.createdAt, payload: huntEvidence.payload })
    .from(huntEvidence)
    .where(and(eq(huntEvidence.orgId, orgId), gte(huntEvidence.createdAt, ok?.at ?? savedAt), inArray(huntEvidence.type, ['kql_failed', 'scheduled_failed'])))
    .orderBy(huntEvidence.createdAt)
    .limit(200)
  const first = failures.find((f) => CONNECTOR_FAILURE.test(String(f.payload.error ?? '')))
  if (first) return { state: 'failing', since: first.at.toISOString(), lastOkAt: ok?.at.toISOString() ?? null }
  if (ok) return { state: 'working', lastOkAt: ok.at.toISOString() }
  return { state: 'untested', savedAt: savedAt.toISOString() }
}

const EXECUTOR_NAME: Record<string, string> = { sentinel: 'Sentinel playbooks', logicapp: 'Logic Apps', graph: 'Defender device actions' }
const EXECUTOR_STATE: Record<string, string> = { off: 'off', 'dry-run': 'dry run only', on: 'live' }

/**
 * Response safety as one value, so the lamp colour and the words beside it always agree (#165).
 * `detail` names each executor in words, never `k=v` configuration.
 */
export function safetyStatus(safety: Pick<ResponseSafety, 'dryRun' | 'executors'>) {
  const entries = Object.entries(safety.executors)
  const live = entries.filter(([, v]) => v === 'on')
  const state: 'ok' | 'warn' = safety.dryRun && live.length === 0 ? 'ok' : 'warn'
  const label = state === 'ok' ? 'Safe mode on' : live.length > 0 ? 'Live actions on' : 'Safe mode off'
  const summary =
    state === 'ok'
      ? 'Every approved action runs as a dry run. Nothing changes in Microsoft.'
      : live.length > 0
        ? `Approved actions can change your tenant through ${live.map(([k]) => EXECUTOR_NAME[k] ?? k).join(' and ')}.`
        : 'Dry run is turned off, but no action type is live yet.'
  const executors = entries.map(([k, v]) => `${EXECUTOR_NAME[k] ?? k}: ${EXECUTOR_STATE[v] ?? v}`).join('. ')
  return { state, label, detail: `${summary} ${executors}.` }
}

/**
 * First-run checklist (#79). Each item is derived from a real signal. Secrets: production requires
 * BETTER_AUTH_SECRET and APP_ENCRYPTION_KEY to boot, so "present" means set and not the dev default.
 */
export async function setupChecklist(orgId: string) {
  const db = getDb()
  const e = env()
  const [org] = await db.select().from(orgs).where(eq(orgs.id, orgId)).limit(1)
  const connector = await connectorHealth(orgId)
  const [saml] = await db.select({ id: ssoOrgBindings.providerId }).from(ssoOrgBindings).where(eq(ssoOrgBindings.orgId, orgId)).limit(1)
  const [w] = (await db.select({ n: count() }).from(watchEntries).where(and(eq(watchEntries.orgId, orgId), isNull(watchEntries.disabledAt)))) as [{ n: number }]
  const safety = responseSafety(e)
  const status = safetyStatus(safety)
  const ssoDone = Boolean((e.ENTRA_CLIENT_ID && e.ENTRA_CLIENT_SECRET && org?.entraTenantId) || saml)
  const secretsDone = Boolean(e.APP_ENCRYPTION_KEY) && !e.BETTER_AUTH_SECRET.startsWith('dev-only-insecure')
  const huntingDetail = {
    none: 'Register the least-privilege hunting app and save the connector in Settings.',
    untested: 'Connector saved, not tested. Approve a search in a hunt to check it.',
    working: 'Connector saved and a live search has succeeded.',
    failing: 'Connector saved, but searches are failing. Check the client secret and admin consent.',
  }[connector.state]
  const items: SetupItem[] = [
    { key: 'sso', label: 'Entra SSO connected', done: ssoDone, detail: ssoDone ? 'Entra app configured and this org is linked to its tenant.' : 'Set ENTRA_CLIENT_ID/SECRET and link this org to your tenant id.', href: 'https://github.com/jusso-dev/crosswire/blob/main/docs/auth.md#entra-id-oidc-issue-19' },
    { key: 'hunting', label: 'Hunting app registration working', done: connector.state === 'working', detail: huntingDetail, href: '/app/settings' },
    { key: 'secrets', label: 'Secrets present (Key Vault / env)', done: secretsDone, detail: secretsDone ? 'BETTER_AUTH_SECRET and APP_ENCRYPTION_KEY are set.' : 'Set BETTER_AUTH_SECRET and APP_ENCRYPTION_KEY (Key Vault in Azure).', href: 'https://github.com/jusso-dev/crosswire/blob/main/docs/configuration.md' },
    { key: 'watchlist', label: 'First watchlist entry created', done: w.n > 0, detail: `${w.n} active watch entr${w.n === 1 ? 'y' : 'ies'}.`, href: '/app/watches' },
    { key: 'dryrun', label: 'Dry run on, no live actions', done: status.state === 'ok', detail: status.detail, href: 'https://github.com/jusso-dev/crosswire/blob/main/docs/response.md' },
  ]
  return { items, complete: items.every((i) => i.done), dismissed: Boolean(org?.setupDismissedAt), safety, safetyStatus: status, connector }
}

export async function dismissSetup(orgId: string) {
  await getDb().update(orgs).set({ setupDismissedAt: new Date() }).where(eq(orgs.id, orgId))
}

/** Bring the checklist back for everyone in the org (#165). */
export async function restoreSetup(orgId: string) {
  await getDb().update(orgs).set({ setupDismissedAt: null }).where(eq(orgs.id, orgId))
}
