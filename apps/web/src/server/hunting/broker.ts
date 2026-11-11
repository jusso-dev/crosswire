import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { getDb } from '../db/client'
import { orgConnectors } from '../db/schema'
import { decryptSecret, encryptSecret } from '../lib/crypto'
import { writeAudit } from '../audit'

/**
 * Hunting has no connector (or no usable secret) for this organisation. The message is shown to the
 * analyst, so it carries no ids; the org id stays on the error for server logs.
 */
export class HuntingNotConfiguredError extends Error {
  readonly orgId: string
  constructor(orgId: string) {
    super('Hunting is not set up for this organisation. An owner adds a connector in Settings, or the deployment enables demo mode.')
    this.orgId = orgId
  }
}

export interface TokenResult {
  accessToken: string
  expiresAt: number
}

export interface Sts {
  /** OAuth2 client-credentials grant against Entra (login.microsoftonline.com/{tenant}/oauth2/v2.0/token). */
  clientCredentials(input: { tenantId: string; clientId: string; clientSecret: string; scope: string }): Promise<TokenResult>
}

/** Default STS: plain HTTPS client-credentials call. No secrets leave this module. */
export const entraSts: Sts = {
  async clientCredentials({ tenantId, clientId, clientSecret, scope }) {
    const res = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret, scope }),
      signal: AbortSignal.timeout(15_000),
    })
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string }
    if (!res.ok || !body.access_token) {
      // error_description from Entra never contains the secret; still keep the message short.
      throw new Error(`Token request failed (${res.status}): ${body.error ?? 'unknown_error'}`)
    }
    return { accessToken: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 }
  },
}

/**
 * Resolve the client secret for a connector:
 * - `client_secret_enc`: AES-GCM ciphertext under APP_ENCRYPTION_KEY
 * - `client_secret_ref`: `env:NAME` reads process.env.NAME. In Azure Container Apps, a Key Vault
 *   reference secret is surfaced as an env var, so `env:` covers Key Vault too (docs/hunting.md).
 *   NAME must be the org's own namespace (`CROSSWIRE_HUNT_<ORG>_...`, see `allowedSecretRefPrefix`),
 *   so one org can never point its connector at another org's secret or at app secrets.
 */
export function allowedSecretRefPrefix(orgId: string) {
  return `CROSSWIRE_HUNT_${orgId.replace(/[^A-Za-z0-9]/g, '').toUpperCase()}_`
}

export function assertSecretRefAllowed(orgId: string, ref: string) {
  const prefix = `env:${allowedSecretRefPrefix(orgId)}`
  if (!ref.startsWith(prefix) || !/^env:[A-Z0-9_]+$/.test(ref)) {
    throw new Error(`Secret reference must be env:${allowedSecretRefPrefix(orgId)}<NAME> (uppercase letters, digits, underscores).`)
  }
}

export function resolveClientSecret(c: Pick<typeof orgConnectors.$inferSelect, 'orgId' | 'clientSecretEnc' | 'clientSecretRef'>): string | null {
  if (c.clientSecretEnc) return decryptSecret(c.clientSecretEnc)
  if (c.clientSecretRef) {
    assertSecretRefAllowed(c.orgId, c.clientSecretRef)
    return process.env[c.clientSecretRef.slice(4)] ?? null
  }
  return null
}

/**
 * Identity of the credential a cached token was minted from (#194): tenant, app, the row's
 * `updatedAt` and a hash of the stored secret or reference. Every process reads the row from the
 * database, so a token cached by another web replica or the worker stops matching as soon as the
 * connector is saved, without a shared cache or a cross-process signal. The hash is never logged.
 */
export function connectorFingerprint(c: { tenantId: string; clientId: string; updatedAt: Date; clientSecretEnc: string | null; clientSecretRef: string | null }) {
  const secret = createHash('sha256').update(`${c.clientSecretEnc ?? ''}|${c.clientSecretRef ?? ''}`).digest('hex').slice(0, 16)
  return `${c.tenantId}|${c.clientId}|${c.updatedAt.getTime()}|${secret}`
}

/**
 * In-memory token cache shared by the hunting and response brokers. One entry per org and scope,
 * tagged with the connector fingerprint it was minted under; a different fingerprint is a miss.
 */
export class FingerprintedTokenCache {
  private entries = new Map<string, { fingerprint: string; token: TokenResult }>()

  get(orgId: string, scope: string, fingerprint: string): string | null {
    const hit = this.entries.get(`${orgId}|${scope}`)
    if (!hit || hit.fingerprint !== fingerprint || hit.token.expiresAt - 60_000 <= Date.now()) return null
    return hit.token.accessToken
  }

  set(orgId: string, scope: string, fingerprint: string, token: TokenResult) {
    this.entries.set(`${orgId}|${scope}`, { fingerprint, token })
  }

  clear(orgId?: string) {
    if (!orgId) return this.entries.clear()
    for (const k of this.entries.keys()) if (k.startsWith(`${orgId}|`)) this.entries.delete(k)
  }
}

/**
 * Token broker (#44): per-org client-credentials tokens, cached in memory until shortly before expiry.
 * The connector is read on every call and the cache is keyed on its fingerprint (#194), so a changed
 * tenant, app or secret never reuses a token minted for the old one, in any process.
 */
export class TokenBroker {
  private cache = new FingerprintedTokenCache()
  constructor(private readonly sts: Sts = entraSts) {}

  async acquire({ orgId, scope }: { orgId: string; scope: string }): Promise<string> {
    const connector = await getConnector(orgId)
    if (!connector) throw new HuntingNotConfiguredError(orgId)
    const fingerprint = connectorFingerprint(connector)
    const hit = this.cache.get(orgId, scope, fingerprint)
    if (hit) return hit
    const clientSecret = resolveClientSecret(connector)
    if (!clientSecret) throw new HuntingNotConfiguredError(orgId)
    const token = await this.sts.clientCredentials({ tenantId: connector.tenantId, clientId: connector.clientId, clientSecret, scope })
    this.cache.set(orgId, scope, fingerprint, token)
    return token.accessToken
  }

  clear(orgId?: string) {
    this.cache.clear(orgId)
  }
}

let broker: TokenBroker | undefined
export function tokenBroker(): TokenBroker {
  broker ??= new TokenBroker()
  return broker
}
export function setTokenBroker(b: TokenBroker) {
  broker = b
}

export async function getConnector(orgId: string) {
  const [row] = await getDb().select().from(orgConnectors).where(eq(orgConnectors.orgId, orgId)).limit(1)
  return row ?? null
}

/** Public (client-safe) view of a connector: never includes secret material. */
export async function getConnectorView(orgId: string) {
  const c = await getConnector(orgId)
  if (!c) return null
  return {
    tenantId: c.tenantId,
    clientId: c.clientId,
    secretSource: c.clientSecretEnc ? 'encrypted' : c.clientSecretRef ? c.clientSecretRef.split(':')[0] : 'none',
    sentinelSubscriptionId: c.sentinelSubscriptionId,
    sentinelResourceGroup: c.sentinelResourceGroup,
    sentinelWorkspaceName: c.sentinelWorkspaceName,
    sentinelWorkspaceId: c.sentinelWorkspaceId,
  }
}

export type ConnectorInput = {
  tenantId: string
  clientId: string
  /** Blank keeps the stored secret. */
  clientSecret?: string
  clientSecretRef?: string
  /** Explicitly remove the stored secret (and reference). Ignored when a new secret is given. */
  clearSecret?: boolean
  sentinelSubscriptionId?: string
  sentinelResourceGroup?: string
  sentinelWorkspaceName?: string
  sentinelWorkspaceId?: string
}

const AUDITED_FIELDS = ['tenantId', 'clientId', 'sentinelSubscriptionId', 'sentinelResourceGroup', 'sentinelWorkspaceName', 'sentinelWorkspaceId'] as const

/**
 * Save the org's hunting connector (#122). Blank secret fields keep the stored secret, the same rule
 * as the response connector; `clearSecret` is the only way to remove it. Writes an audit record that
 * names who changed which fields, never any value.
 */
export async function upsertConnector(orgId: string, input: ConnectorInput, actorUserId?: string) {
  if (!input.clientSecret && input.clientSecretRef) assertSecretRefAllowed(orgId, input.clientSecretRef)
  const existing = await getConnector(orgId)
  const newSecret = Boolean(input.clientSecret || input.clientSecretRef)
  const keepSecret = !newSecret && !input.clearSecret && existing
  const values = {
    orgId,
    tenantId: input.tenantId,
    clientId: input.clientId,
    clientSecretEnc: keepSecret ? existing.clientSecretEnc : input.clientSecret ? encryptSecret(input.clientSecret) : null,
    clientSecretRef: keepSecret ? existing.clientSecretRef : input.clientSecret ? null : (input.clientSecretRef ?? null),
    sentinelSubscriptionId: input.sentinelSubscriptionId ?? null,
    sentinelResourceGroup: input.sentinelResourceGroup ?? null,
    sentinelWorkspaceName: input.sentinelWorkspaceName ?? null,
    sentinelWorkspaceId: input.sentinelWorkspaceId ?? null,
    // Set explicitly on insert and on conflict: other processes key their token cache on it (#194).
    updatedAt: new Date(),
  }
  await getDb().insert(orgConnectors).values(values).onConflictDoUpdate({ target: orgConnectors.orgId, set: values })
  tokenBroker().clear(orgId)
  const changed: string[] = AUDITED_FIELDS.filter((f) => (existing?.[f] ?? null) !== values[f])
  const secretChanged = !existing || existing.clientSecretEnc !== values.clientSecretEnc || existing.clientSecretRef !== values.clientSecretRef
  if (secretChanged) changed.push(values.clientSecretEnc || values.clientSecretRef ? 'secret' : 'secret removed')
  await writeAudit({
    category: 'hunt',
    action: 'hunting_connector_saved',
    actorType: actorUserId ? 'user' : 'system',
    actorId: actorUserId ?? null,
    orgId,
    targetType: 'hunting_connector',
    targetId: orgId,
    // Field names and the secret's kind only. Never a value.
    data: { created: !existing, changed, secretSource: values.clientSecretEnc ? 'encrypted' : values.clientSecretRef ? 'env' : 'none' },
  })
}
