import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { ENV_KEYS } from '../src/server/env'

/**
 * Every variable env.ts reads is either set by the Azure Bicep (so a redeploy keeps it) or listed
 * here with the reason it is not (#133). A new variable fails this test until someone decides.
 */
const NOT_FOR_AZURE: Record<string, string> = {
  PORT: 'image default (3000)',
  ENTRA_ORG_NAME: 'display name only; code default',
  ENTRA_AUTO_PROVISION_ORGS: 'off by default; change ticket to enable',
  SMTP_HOST: 'optional email, add as Key Vault secret when used',
  SMTP_PORT: 'optional email',
  SMTP_USER: 'optional email',
  SMTP_PASSWORD: 'optional email secret',
  SMTP_FROM: 'optional email',
  AZURE_OPENAI_API_KEY: 'keyless managed identity in Azure',
  AZURE_OPENAI_API_VERSION: 'v1 API needs none',
  OPENAI_BASE_URL: 'openai-compatible provider is not used in Azure',
  OPENAI_MODEL: 'openai-compatible provider is not used in Azure',
  OPENAI_API_KEY: 'openai-compatible provider is not used in Azure',
  OPENAI_API: 'openai-compatible provider is not used in Azure',
  AGENT_TIMEOUT_MS: 'tuning; code default',
  TI_CACHE_TTL_SECONDS: 'tuning; code default',
  TI_HTTP_TIMEOUT_MS: 'tuning; code default',
  PWN_WATCH_BASE_URL: 'upstream URL; code default',
  CISA_KEV_URL: 'upstream URL; code default',
  CVE_WATCH_ENABLED: 'off by default',
  HUNTING_MAX_ROWS: 'tuning; code default',
  HUNTING_TIMEOUT_MS: 'tuning; code default',
  KQL_PROPOSAL_TTL_HOURS: 'code default',
  RESPONSE_LOGICAPP_URL: 'contains a SAS signature: add as a Key Vault secret when used',
  RESPONSE_PROPOSAL_TTL_HOURS: 'code default',
  RESPONSE_MAX_LIVE_TARGETS: 'code default, hard ceiling 50',
  SAML_ENABLED: 'off by default',
  RADAR_ENABLED: 'off by default',
  CLOUDFLARE_API_TOKEN: 'secret, only with RADAR_ENABLED',
  WORKER_TIMEZONE: 'code default; APP_TIMEZONE drives the digest day',
  SCHEDULED_HUNTS_ENABLED: 'kill switch, default on',
  NOTIFICATIONS_ENABLED: 'kill switch, default on',
  TI_MAX_RESPONSE_BYTES: 'tuning; code default',
  APP_ENCRYPTION_KEY_PREVIOUS: 'added as a Key Vault secret during a rotation only',
  MEMORY_GOVERNANCE: 'enforced by default; legacy is a rollback',
  RUN_LEDGER: 'enforced by default; legacy is a rollback',
  EGRESS_FILTER: 'enforced by default; legacy is a rollback',
  APPROVAL_BINDING: 'enforced by default; legacy is a rollback',
  BUDGET_MAX_INPUT_TOKENS: 'tuning; code default',
  BUDGET_MAX_OUTPUT_TOKENS: 'tuning; code default',
  BUDGET_MAX_INFLIGHT: 'tuning; code default',
  BUDGET_CONTEXT_WINDOW_TOKENS: 'tuning; code default',
  BUDGET_DAILY_INPUT_TOKENS: 'tuning; code default',
  BUDGET_MAX_SPEND_MICROS: 'customer pricing decision',
  BUDGET_USD_PER_MILLION_TOKENS: 'customer pricing decision',
  DATABASE_TLS_INSECURE_OK: 'Azure uses sslmode=verify-full, so the warning never fires',
}

describe('Azure Bicep sets or explicitly skips every env var (#133)', () => {
  const bicep = readFileSync(path.resolve(__dirname, '../../../infra/azure/modules/apps.bicep'), 'utf8')
  const inBicep = (k: string) => new RegExp(`name: '${k}'|env: '${k}'`).test(bicep)

  it('has no variable that is in neither list', () => {
    const missing = ENV_KEYS.filter((k) => !inBicep(k) && !(k in NOT_FOR_AZURE))
    expect(missing, `Add these to infra/azure/modules/apps.bicep or to NOT_FOR_AZURE with a reason: ${missing.join(', ')}`).toEqual([])
  })

  it('keeps the approval and security settings in Bicep', () => {
    for (const k of ['KQL_APPROVAL_POLICY', 'RESPONSE_ALLOW_SELF_APPROVAL', 'RESPONSE_DRY_RUN', 'SESSION_MAX_AGE_HOURS', 'SESSION_IDLE_MINUTES', 'RATE_LIMIT_CHAT_PER_MIN', 'RATE_LIMIT_STORAGE', 'TRUSTED_PROXIES', 'RETENTION_AUDIT_DAYS', 'DATABASE_URL']) {
      expect(inBicep(k), k).toBe(true)
    }
  })

  it('lists nothing as skipped that Bicep actually sets', () => {
    expect(Object.keys(NOT_FOR_AZURE).filter(inBicep)).toEqual([])
  })
})
