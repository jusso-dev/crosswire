import { decryptSecretDetailed, encryptSecret, SECRET_COLUMNS } from '../lib/crypto'

export const SSO_CONFIG_FIELDS = ['oidcConfig', 'samlConfig'] as const
export type SsoConfigField = (typeof SSO_CONFIG_FIELDS)[number]

const context = (id: string, field: SsoConfigField) => ({
  providerId: id,
  column: field === 'oidcConfig' ? SECRET_COLUMNS.ssoOidcConfig : SECRET_COLUMNS.ssoSamlConfig,
})

function validateConfig(value: string) {
  try {
    const parsed: unknown = JSON.parse(value)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return
  } catch { /* Never include config text or parser details in errors. */ }
  throw new Error('Invalid stored SSO configuration.')
}

export function encryptSsoConfig(value: string, id: string, field: SsoConfigField): string {
  validateConfig(value)
  return encryptSecret(value, context(id, field))
}

/** Legacy JSON is readable during upgrade; rotate-secrets rewrites it. Other formats fail closed. */
export function readSsoConfig(value: string, id: string, field: SsoConfigField): { plaintext: string; keyIndex: number | null } {
  const result = value.startsWith('v2.') ? decryptSecretDetailed(value, context(id, field)) : { plaintext: value, keyIndex: null }
  validateConfig(result.plaintext)
  return { plaintext: result.plaintext, keyIndex: result.keyIndex }
}
