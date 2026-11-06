import { bootstrap } from '../ops/bootstrap'
import { runCli } from './run'

/**
 * `pnpm bootstrap` (#78): run once after migrations on a fresh install.
 *   ADMIN_EMAIL=you@corp.example ORG_NAME="Contoso SOC" [BOOTSTRAP_ENTRA_TENANT_ID=<guid>] pnpm bootstrap
 * Refuses if any org exists. Safe defaults: dry-run on, executors off.
 */
runCli('bootstrap', async () => {
  const adminEmail = process.env.ADMIN_EMAIL
  if (!adminEmail) throw new Error('Set ADMIN_EMAIL (and optionally ORG_NAME, BOOTSTRAP_ENTRA_TENANT_ID).')
  return bootstrap({ orgName: process.env.ORG_NAME ?? 'Crosswire', adminEmail, entraTenantId: process.env.BOOTSTRAP_ENTRA_TENANT_ID })
})
