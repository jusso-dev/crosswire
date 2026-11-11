import { eq, isNotNull } from 'drizzle-orm'
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core'
import { getDb } from '../db/client'
import { orgConnectors, orgNotificationChannels, orgResponseConnectors, ssoProvider } from '../db/schema'
import { decryptSecretDetailed, encryptSecret, SECRET_COLUMNS, type SecretColumn } from '../lib/crypto'
import { writeAudit } from '../audit'
import { encryptSsoConfig, readSsoConfig, SSO_CONFIG_FIELDS } from '../auth/sso-secrets'

/**
 * Re-encrypt (run via `pnpm rotate-secrets`, src/server/cli/rotate-secrets-cli.ts) stored secrets with the current APP_ENCRYPTION_KEY.
 *
 * Includes SAML and OIDC provider configs, including legacy plaintext JSON (see docs/auth.md).
 *
 * Rotation procedure:
 *   1. Set APP_ENCRYPTION_KEY to the new key and APP_ENCRYPTION_KEY_PREVIOUS to the old one, deploy.
 *   2. Run `pnpm rotate-secrets`.
 *   3. Remove the old key from APP_ENCRYPTION_KEY_PREVIOUS and deploy again.
 *
 * It also upgrades the storage format (#212): every `v1` value (no binding to its row) is rewritten
 * as `v2`, bound to its org and column, even when it is already under the current key.
 *
 * Runs in one transaction with the rows locked, so a value that cannot be decrypted rolls the
 * whole run back. Idempotent: `v2` values under the current key are left alone. Reports counts
 * only; plaintext and ciphertext are never logged.
 */
export interface RotationCounts {
  rotated: number
  current: number
}
export type RotationReport = Record<'orgConnectors' | 'orgResponseConnectors' | 'orgNotificationChannels' | 'ssoOidcConfigs' | 'ssoSamlConfigs', RotationCounts>

type Tx = Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0]

/** Re-encrypt one secret column as v2 under the current key; values already in that state are left alone. */
async function rotateColumn(tx: Tx, table: PgTable, cols: { id: PgColumn; orgId: PgColumn; enc: PgColumn }, column: SecretColumn): Promise<RotationCounts> {
  const rows = (await tx.select({ id: cols.id, orgId: cols.orgId, enc: cols.enc }).from(table).where(isNotNull(cols.enc)).for('update')) as Array<{ id: string; orgId: string; enc: string }>
  const out = { rotated: 0, current: 0 }
  for (const r of rows) {
    const ctx = { orgId: r.orgId, column }
    const { plaintext, keyIndex, version } = decryptSecretDetailed(r.enc, ctx)
    if (keyIndex === 0 && version === 'v2') {
      out.current++
      continue
    }
    await tx.update(table).set({ [cols.enc.name === 'url_enc' ? 'urlEnc' : 'clientSecretEnc']: encryptSecret(plaintext, ctx) }).where(eq(cols.id, r.id))
    out.rotated++
  }
  return out
}

async function rotateSsoConfigs(tx: Tx) {
  const counts = { oidcConfig: { rotated: 0, current: 0 }, samlConfig: { rotated: 0, current: 0 } }
  const rows = await tx.select().from(ssoProvider).for('update')
  for (const row of rows) {
    const update: Partial<typeof ssoProvider.$inferInsert> = {}
    for (const field of SSO_CONFIG_FIELDS) {
      const value = row[field]
      if (value === null) continue
      const { plaintext, keyIndex } = readSsoConfig(value, row.id, field)
      if (keyIndex === 0) counts[field].current++
      else {
        update[field] = encryptSsoConfig(plaintext, row.id, field)
        counts[field].rotated++
      }
    }
    if (Object.keys(update).length) await tx.update(ssoProvider).set(update).where(eq(ssoProvider.id, row.id))
  }
  return { ssoOidcConfigs: counts.oidcConfig, ssoSamlConfigs: counts.samlConfig }
}

export async function rotateSecrets(): Promise<RotationReport> {
  const report = await getDb().transaction(async (tx) => ({
    orgConnectors: await rotateColumn(tx, orgConnectors, { id: orgConnectors.id, orgId: orgConnectors.orgId, enc: orgConnectors.clientSecretEnc }, SECRET_COLUMNS.huntingClientSecret),
    orgResponseConnectors: await rotateColumn(
      tx,
      orgResponseConnectors,
      { id: orgResponseConnectors.id, orgId: orgResponseConnectors.orgId, enc: orgResponseConnectors.clientSecretEnc },
      SECRET_COLUMNS.responseClientSecret,
    ),
    orgNotificationChannels: await rotateColumn(
      tx,
      orgNotificationChannels,
      { id: orgNotificationChannels.id, orgId: orgNotificationChannels.orgId, enc: orgNotificationChannels.urlEnc },
      SECRET_COLUMNS.notificationUrl,
    ),
    ...await rotateSsoConfigs(tx),
  }))
  await writeAudit({ category: 'system', action: 'secrets_rotated', actorType: 'system', data: { ...report } })
  return report
}

