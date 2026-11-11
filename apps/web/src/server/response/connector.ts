import { eq } from 'drizzle-orm'
import { getDb } from '../db/client'
import { orgResponseConnectors } from '../db/schema'
import { decryptSecret, encryptSecret, SECRET_COLUMNS } from '../lib/crypto'
import { writeAudit } from '../audit'
import { entraSts, type Sts, type TokenResult } from '../hunting/broker'

/**
 * Response connector (#88). A second, separate Entra app per org with only response permissions
 * (Defender `Machine.Isolate`, Sentinel Responder + playbook run). It lives in its own table and has
 * its own token broker, so hunting code can never mint a response token and response executors can
 * never borrow the read-only hunting credential.
 */
export class ResponseNotConfiguredError extends Error {
  constructor() {
    super('Response connector is not configured for this org. An owner adds it in Settings → Response connector.')
  }
}

export function allowedResponseSecretRefPrefix(orgId: string) {
  return `CROSSWIRE_RESP_${orgId.replace(/[^A-Za-z0-9]/g, '').toUpperCase()}_`
}

export function assertResponseSecretRefAllowed(orgId: string, ref: string) {
  const prefix = `env:${allowedResponseSecretRefPrefix(orgId)}`
  if (!ref.startsWith(prefix) || !/^env:[A-Z0-9_]+$/.test(ref)) {
    throw new Error(`Response secret reference must be env:${allowedResponseSecretRefPrefix(orgId)}<NAME> (uppercase letters, digits, underscores).`)
  }
}

type Row = typeof orgResponseConnectors.$inferSelect

export function resolveResponseSecret(c: Pick<Row, 'orgId' | 'clientSecretEnc' | 'clientSecretRef'>): string | null {
  if (c.clientSecretEnc) return decryptSecret(c.clientSecretEnc, { orgId: c.orgId, column: SECRET_COLUMNS.responseClientSecret })
  if (c.clientSecretRef) {
    assertResponseSecretRefAllowed(c.orgId, c.clientSecretRef)
    return process.env[c.clientSecretRef.slice(4)] ?? null
  }
  return null
}

export async function getResponseConnector(orgId: string) {
  const [row] = await getDb().select().from(orgResponseConnectors).where(eq(orgResponseConnectors.orgId, orgId)).limit(1)
  return row ?? null
}

/** Client-safe view: never includes secret material. */
export async function getResponseConnectorView(orgId: string) {
  const c = await getResponseConnector(orgId)
  if (!c) return null
  return {
    tenantId: c.tenantId,
    clientId: c.clientId,
    secretSource: c.clientSecretEnc ? 'encrypted' : c.clientSecretRef ? 'env' : 'none',
    playbookAllowlist: c.playbookAllowlist,
  }
}

/** ARM resource id of a Logic App workflow (the only thing a Sentinel playbook proposal may name). */
export const LOGIC_APP_RESOURCE_ID = /^\/subscriptions\/[0-9a-f-]{36}\/resourceGroups\/[A-Za-z0-9._()-]{1,90}\/providers\/Microsoft\.Logic\/workflows\/[A-Za-z0-9._()-]{1,80}$/i

export function normalisePlaybookId(id: string) {
  return id.trim().toLowerCase()
}

export async function upsertResponseConnector(
  orgId: string,
  actorUserId: string,
  input: { tenantId: string; clientId: string; clientSecret?: string; clientSecretRef?: string; playbookAllowlist?: string[] },
) {
  if (!input.clientSecret && input.clientSecretRef) assertResponseSecretRefAllowed(orgId, input.clientSecretRef)
  const playbooks = [...new Set((input.playbookAllowlist ?? []).map((p) => p.trim()).filter(Boolean))]
  for (const p of playbooks) {
    if (!LOGIC_APP_RESOURCE_ID.test(p)) throw new Error(`Not a Logic App resource id: ${p.slice(0, 200)}`)
  }
  if (playbooks.length > 50) throw new Error('At most 50 allowlisted playbooks.')
  const existing = await getResponseConnector(orgId)
  // Keep the stored secret when the owner only edits the allowlist.
  const keepSecret = !input.clientSecret && !input.clientSecretRef && existing
  if (!input.clientSecret && !input.clientSecretRef && !existing) throw new Error('A client secret or secret reference is required the first time.')
  const values = {
    orgId,
    tenantId: input.tenantId,
    clientId: input.clientId,
    clientSecretEnc: keepSecret ? existing.clientSecretEnc : input.clientSecret ? encryptSecret(input.clientSecret, { orgId, column: SECRET_COLUMNS.responseClientSecret }) : null,
    clientSecretRef: keepSecret ? existing.clientSecretRef : input.clientSecret ? null : (input.clientSecretRef ?? null),
    playbookAllowlist: playbooks,
  }
  await getDb().insert(orgResponseConnectors).values(values).onConflictDoUpdate({ target: orgResponseConnectors.orgId, set: values })
  responseTokenBroker().clear(orgId)
  await writeAudit({
    category: 'response',
    action: 'response_connector_saved',
    actorType: 'user',
    actorId: actorUserId,
    orgId,
    data: { tenantId: input.tenantId, clientId: input.clientId, secretSource: values.clientSecretEnc ? 'encrypted' : values.clientSecretRef ? 'env' : 'none', playbooks: playbooks.length },
  })
}

/** Response-only token broker. Separate cache and credential source from the hunting broker. */
export class ResponseTokenBroker {
  private cache = new Map<string, TokenResult>()
  constructor(private readonly sts: Sts = entraSts) {}

  async acquire({ orgId, scope }: { orgId: string; scope: string }): Promise<string> {
    const key = `${orgId}|${scope}`
    const hit = this.cache.get(key)
    if (hit && hit.expiresAt - 60_000 > Date.now()) return hit.accessToken
    const c = await getResponseConnector(orgId)
    if (!c) throw new ResponseNotConfiguredError()
    const clientSecret = resolveResponseSecret(c)
    if (!clientSecret) throw new ResponseNotConfiguredError()
    const token = await this.sts.clientCredentials({ tenantId: c.tenantId, clientId: c.clientId, clientSecret, scope })
    this.cache.set(key, token)
    return token.accessToken
  }

  clear(orgId?: string) {
    if (!orgId) return this.cache.clear()
    for (const k of this.cache.keys()) if (k.startsWith(`${orgId}|`)) this.cache.delete(k)
  }
}

let broker: ResponseTokenBroker | undefined
export function responseTokenBroker(): ResponseTokenBroker {
  broker ??= new ResponseTokenBroker()
  return broker
}
export function setResponseTokenBroker(b: ResponseTokenBroker) {
  broker = b
}
