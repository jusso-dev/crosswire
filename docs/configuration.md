# Configuration

One pattern everywhere (issue #13): **environment variables**, validated at boot by
`apps/web/src/server/env.ts` (zod). `.env.example` is the source of truth for names.

- Local: `cp .env.example .env` (gitignored). Development has safe defaults for everything.
- Production (`NODE_ENV=production`): the server refuses to start unless `APP_URL`,
  `DATABASE_URL`, `BETTER_AUTH_SECRET` and `APP_ENCRYPTION_KEY` are set, and prints which are missing.
- Browser: nothing from the environment is bundled into client code. Server functions return only
  what the UI needs. `APP_URL` is the one value that appears client-side (in links).

## Azure mapping (Phase 7)

Container Apps receive the **same names**. Plain values are app environment variables; secrets
are Key Vault references (`infra/azure/modules/apps.bicep`):

| Env var | Key Vault secret | Notes |
| --- | --- | --- |
| `DATABASE_URL` | `database-url` | Written by Bicep from the Postgres admin password |
| `BETTER_AUTH_SECRET` | `better-auth-secret` | `openssl rand -hex 32` |
| `APP_ENCRYPTION_KEY` | `app-encryption-key` | 64 hex chars; encrypts connector secrets in Postgres |
| `ENTRA_CLIENT_SECRET` | `entra-client-secret` | SSO app registration secret |
| `ENTRA_CLIENT_ID`, `ENTRA_TENANT_ID`, `APP_URL`, flags | (plain env) | Not secret |
| `RESPONSE_LOGICAPP_URL` | add `response-logicapp-url` if used | Contains a SAS signature |
| `RESPONSE_DRY_RUN`, `RESPONSE_EXECUTOR_*` | (plain env, Bicep sets `true` / `off`) | Fail closed, see docs/response.md |
| `APP_ENCRYPTION_KEY_PREVIOUS` | add `app-encryption-key-previous` during a rotation only | Old key(s) for decryption; see [key rotation](runbooks/key-rotation.md) |
| `CORS_ALLOWED_ORIGINS`, `RATE_LIMIT_CHAT_PER_MIN`, `RATE_LIMIT_STORAGE`, `TRUSTED_PROXIES` | (plain env) | HTTP hardening (#74) |
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | (plain env from Bicep) | Not a secret |
| Customer hunting secrets | `CROSSWIRE_HUNT_<ORG>_*`, referenced as `env:NAME` from the connector | See docs/hunting.md |
| Customer response secrets (v2) | `CROSSWIRE_RESP_<ORG>_*`, referenced from the response connector | Separate app registration; see docs/response.md |
| `RESPONSE_MAX_LIVE_TARGETS` | (plain env, default 10, max 50) | Devices/incidents per live proposal (v2) |
| `SCHEDULED_HUNTS_ENABLED`, `NOTIFICATIONS_ENABLED` | (plain env, default `true`) | Kill switches for v2 scheduled hunts and webhooks |

The settings in the next section are plain env too. Bicep does not set them, so the code defaults
apply until you add them to the web and worker apps (`az containerapp update --set-env-vars`). A
later Bicep redeploy replaces each app's env list and drops values added this way; the deploy
workflow only changes the image and keeps them. Set them again after a Bicep redeploy.

Rotation: update the Key Vault secret, then restart the revision
(`az containerapp revision restart`). `APP_ENCRYPTION_KEY` is different: it encrypts connector and
webhook secrets in Postgres, so changing it alone makes them unreadable. Follow
[key rotation](runbooks/key-rotation.md) (new key, old key in `APP_ENCRYPTION_KEY_PREVIOUS`,
`pnpm rotate-secrets`, then remove the old key). Nothing needs to be re-saved.

## Security, sessions and retention

All optional. Defaults are shown; invalid values stop the server at boot.

| Env var | Default | What it does |
| --- | --- | --- |
| `KQL_APPROVAL_POLICY` | `member` | Who may approve and run a KQL search: `member`, `approver` or `second-person`. See [hunting](hunting.md#approval-policy-kql_approval_policy). |
| `SESSION_MAX_AGE_HOURS` | `12` | Absolute session cap since sign-in (1 to 720). See [auth](auth.md#session-lifetime). |
| `SESSION_IDLE_MINUTES` | `60` | Idle timeout; each request slides it forward (5 to 1440). |
| `RATE_LIMIT_STORAGE` | `database` | `database`: chat and sign-in limits are shared by every replica. `memory`: per process, so N replicas allow N times the limit. |
| `RETENTION_CHAT_DAYS` | `365` | Chat threads and messages older than this are deleted. |
| `RETENTION_DECISIONS_DAYS` | `365` | Decision log (`agent_decisions`) rows older than this are deleted. |
| `RETENTION_SAMPLES_DAYS` | `180` | Stored KQL result samples older than this are removed; row counts and columns stay. |
| `RETENTION_AUDIT_DAYS` | `730` | Audit log rows older than this are deleted. |
| `TI_MAX_RESPONSE_BYTES` | `26214400` (25 MB) | Largest TI feed response accepted. Larger responses are refused and not cached. |
| `APP_ENCRYPTION_KEY_PREVIOUS` | (empty) | Comma-separated old keys (64 hex each), used only to decrypt during a [key rotation](runbooks/key-rotation.md). |

`0` for any `RETENTION_*` setting keeps that data forever. The worker runs the purge daily; see
[data retention](runbooks/data-retention.md).

Security headers (Content-Security-Policy and others) are fixed in code, not configured; see
[auth](auth.md#http-security-headers-74).
