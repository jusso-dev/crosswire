import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { env } from '../env'

/**
 * AES-256-GCM with APP_ENCRYPTION_KEY (base64url parts).
 *
 * - `v2.<iv>.<tag>.<ciphertext>` (current, #212): the owning org or SSO provider row id and the table and column are
 *   bound as additional authenticated data, so a value copied into another org's row, or into
 *   another secret column, fails to decrypt.
 * - `v1.<iv>.<tag>.<ciphertext>` (read only): no additional data. Still decrypted so existing
 *   deployments keep their secrets; `pnpm rotate-secrets` rewrites every v1 value as v2.
 *
 * Both formats require a 12-byte IV and a full 16-byte tag. Node would otherwise accept a short
 * tag (as small as 4 bytes), which weakens the integrity check.
 *
 * Key rotation: encryption always uses APP_ENCRYPTION_KEY. Decryption tries APP_ENCRYPTION_KEY
 * first, then each key in APP_ENCRYPTION_KEY_PREVIOUS in order. GCM authenticates, so a wrong key
 * fails cleanly and the next one is tried. `pnpm rotate-secrets` re-encrypts stored values with
 * the current key, after which the previous keys can be removed.
 */
const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12
const TAG_BYTES = 16

/** Every column that stores a secret, as `table.column`. Part of the v2 additional data. */
export const SECRET_COLUMNS = {
  huntingClientSecret: 'org_connectors.client_secret_enc',
  responseClientSecret: 'org_response_connectors.client_secret_enc',
  notificationUrl: 'org_notification_channels.url_enc',
  ssoOidcConfig: 'sso_provider.oidc_config',
  ssoSamlConfig: 'sso_provider.saml_config',
} as const
export type SecretColumn = (typeof SECRET_COLUMNS)[keyof typeof SECRET_COLUMNS]

/** SSO providers exist before org binding, so their immutable row id owns the ciphertext. */
export type SecretContext = {
  column: SecretColumn
} & ({ orgId: string; providerId?: never } | { providerId: string; orgId?: never })

function aad(ctx: SecretContext): Buffer {
  if (ctx.providerId !== undefined) {
    if (!ctx.providerId) throw new Error('A secret must be bound to a provider row id.')
    return Buffer.from(`crosswire:v2\n${ctx.column}\nprovider:${ctx.providerId}`, 'utf8')
  }
  if (!ctx.orgId) throw new Error('A secret must be bound to an org id.')
  return Buffer.from(`crosswire:v2\n${ctx.column}\n${ctx.orgId}`, 'utf8')
}

function currentKey(): Buffer {
  const hex = env().APP_ENCRYPTION_KEY
  if (!hex) throw new Error('APP_ENCRYPTION_KEY is not set; cannot encrypt or decrypt stored secrets.')
  return Buffer.from(hex, 'hex')
}

function previousKeys(): Buffer[] {
  return (env().APP_ENCRYPTION_KEY_PREVIOUS ?? '')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean)
    .map((k) => Buffer.from(k, 'hex'))
}

export function encryptSecret(plaintext: string, ctx: SecretContext): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, currentKey(), iv, { authTagLength: TAG_BYTES })
  cipher.setAAD(aad(ctx))
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return ['v2', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.')
}

function decryptWith(key: Buffer, iv: Buffer, tag: Buffer, ct: Buffer, additional: Buffer | null): string {
  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES })
  if (additional) decipher.setAAD(additional)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
}

export type CiphertextVersion = 'v1' | 'v2'

/**
 * Decrypts with the current key or any previous key. `keyIndex` is 0 for the current key and
 * 1.. for APP_ENCRYPTION_KEY_PREVIOUS entries, and `version` is the stored format, so callers can
 * tell whether re-encryption is due (anything other than v2 under key 0).
 */
export function decryptSecretDetailed(value: string, ctx: SecretContext): { plaintext: string; keyIndex: number; version: CiphertextVersion } {
  const parts = value.split('.')
  const [v, ivText, tagText, ctText] = parts
  if (parts.length !== 4 || (v !== 'v1' && v !== 'v2') || !ivText || !tagText || ctText === undefined) throw new Error('unsupported ciphertext format')
  const iv = Buffer.from(ivText, 'base64url')
  const tag = Buffer.from(tagText, 'base64url')
  if (iv.length !== IV_BYTES) throw new Error('unsupported ciphertext format: the IV must be 12 bytes')
  if (tag.length !== TAG_BYTES) throw new Error('unsupported ciphertext format: the authentication tag must be 16 bytes')
  const ct = Buffer.from(ctText, 'base64url')
  const additional = v === 'v2' ? aad(ctx) : null
  const keys = [currentKey(), ...previousKeys()]
  for (let i = 0; i < keys.length; i++) {
    try {
      return { plaintext: decryptWith(keys[i]!, iv, tag, ct, additional), keyIndex: i, version: v }
    } catch {
      // Authentication failed with this key; try the next one.
    }
  }
  throw new Error('cannot decrypt secret with APP_ENCRYPTION_KEY or any APP_ENCRYPTION_KEY_PREVIOUS key (or it belongs to another row)')
}

export function decryptSecret(value: string, ctx: SecretContext): string {
  return decryptSecretDetailed(value, ctx).plaintext
}
