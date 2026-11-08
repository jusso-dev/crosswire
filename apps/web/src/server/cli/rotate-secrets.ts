import { eq, isNotNull } from 'drizzle-orm'
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core'
import { getDb } from '../db/client'
import { orgConnectors, orgNotificationChannels, orgResponseConnectors } from '../db/schema'
import { decryptSecretDetailed, encryptSecret } from '../lib/crypto'
import { writeAudit } from '../audit'

/**
 * Re-encrypt (run via `pnpm rotate-secrets`, src/server/cli/rotate-secrets-cli.ts) stored secrets with the current APP_ENCRYPTION_KEY.
 *
 * Rotation procedure:
 *   1. Set APP_ENCRYPTION_KEY to the new key and APP_ENCRYPTION_KEY_PREVIOUS to the old one, deploy.
 *   2. Run `pnpm rotate-secrets`.
 *   3. Remove the old key from APP_ENCRYPTION_KEY_PREVIOUS and deploy again.
 *
 * Runs in one transaction with the rows locked, so a value that cannot be decrypted rolls the
 * whole run back. Idempotent: values already under the current key are left alone. Reports
 * counts only; plaintext and ciphertext are never logged.
 */
export interface RotationCounts {
  rotated: number
  current: number
}
export type RotationReport = Record<'orgConnectors' | 'orgResponseConnectors' | 'orgNotificationChannels', RotationCounts>

type Tx = Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0]

/** Re-encrypt one secret column under the current key; values already under it are left alone. */
async function rotateColumn(tx: Tx, table: PgTable, idCol: PgColumn, encCol: PgColumn): Promise<RotationCounts> {
  const rows = (await tx.select({ id: idCol, enc: encCol }).from(table).where(isNotNull(encCol)).for('update')) as Array<{ id: string; enc: string }>
  const out = { rotated: 0, current: 0 }
  for (const r of rows) {
    const { plaintext, keyIndex } = decryptSecretDetailed(r.enc)
    if (keyIndex === 0) {
      out.current++
      continue
    }
    await tx.update(table).set({ [encCol.name === 'url_enc' ? 'urlEnc' : 'clientSecretEnc']: encryptSecret(plaintext) }).where(eq(idCol, r.id))
    out.rotated++
  }
  return out
}

export async function rotateSecrets(): Promise<RotationReport> {
  const report = await getDb().transaction(async (tx) => ({
    orgConnectors: await rotateColumn(tx, orgConnectors, orgConnectors.id, orgConnectors.clientSecretEnc),
    orgResponseConnectors: await rotateColumn(tx, orgResponseConnectors, orgResponseConnectors.id, orgResponseConnectors.clientSecretEnc),
    orgNotificationChannels: await rotateColumn(tx, orgNotificationChannels, orgNotificationChannels.id, orgNotificationChannels.urlEnc),
  }))
  await writeAudit({ category: 'system', action: 'secrets_rotated', actorType: 'system', data: { ...report } })
  return report
}

