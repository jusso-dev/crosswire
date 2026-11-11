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
| `DATABASE_URL` (web, worker) | `database-url-app` | Least-privilege app role, written by Bicep; `sslmode=verify-full` |
| `DATABASE_URL` (migration job) | `database-url` | Postgres owner, written by Bicep; the job also gets `APP_DATABASE_URL` to manage the app role |
| `BETTER_AUTH_SECRET` | `better-auth-secret` | `openssl rand -hex 32` |
| `APP_ENCRYPTION_KEY` | `app-encryption-key` | 64 hex chars; encrypts connector secrets in Postgres |
| `ENTRA_CLIENT_SECRET` | `entra-client-secret` | SSO app registration secret |
| `ENTRA_CLIENT_ID`, `ENTRA_TENANT_ID`, `APP_URL`, flags | (plain env) | Not secret |
| `RESPONSE_LOGICAPP_URL` | add `response-logicapp-url` if used | Contains a SAS signature |
| `RESPONSE_DRY_RUN`, `RESPONSE_EXECUTOR_*` | (plain env, Bicep sets `true` / `off`) | Fail closed, see docs/response.md |
| `APP_ENCRYPTION_KEY_PREVIOUS` | add `app-encryption-key-previous` during a rotation only | Old key(s) for decryption; see [key rotation](runbooks/key-rotation.md) |
| `CORS_ALLOWED_ORIGINS`, `RATE_LIMIT_CHAT_PER_MIN`, `RATE_LIMIT_STORAGE`, `TRUSTED_PROXIES` | (plain env from Bicep parameters) | HTTP hardening (#74). `TRUSTED_PROXIES` takes IP addresses or CIDR ranges |
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | (plain env from Bicep) | Not a secret |
| Customer hunting secrets | `CROSSWIRE_HUNT_<ORG>_*`, referenced as `env:NAME` from the connector | See docs/hunting.md |
| Customer response secrets (v2) | `CROSSWIRE_RESP_<ORG>_*`, referenced from the response connector | Separate app registration; see docs/response.md |
| `RESPONSE_MAX_LIVE_TARGETS` | (plain env, default 10, max 50) | Devices/incidents per live proposal (v2) |
| `SCHEDULED_HUNTS_ENABLED`, `NOTIFICATIONS_ENABLED` | (plain env, default `true`) | Kill switches for v2 scheduled hunts and webhooks |

The approval policy, session, retention and rate-limit settings in the next section are Bicep
parameters (#133): set them in your parameter file, not in the portal. A Bicep redeploy replaces each
app's env list, so a value added with `az containerapp update --set-env-vars` is dropped by the next
infrastructure deploy (the Deploy workflow only changes the image and keeps it).
`apps/web/test/bicep-env-coverage.test.ts` lists every variable Bicep does not set and why. The web
app logs the KQL approval policy in force at start-up.

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
| `TRUSTED_PROXIES` | (empty) | Comma-separated IPv4/IPv6 addresses or CIDR ranges of your proxies. An invalid entry stops the server. |
| `DATABASE_TLS_INSECURE_OK` | `false` | Silences the production warning for a `DATABASE_URL` without `sslmode=verify-full`, for a database without TLS on a private network. It does not change how the app connects. |
| `WORKER_HEALTH_PORT` | `3001` | Port of the worker's health server (`GET /healthz`), used by container probes. |

## Database TLS

Use `sslmode=verify-full` in production `DATABASE_URL`s: the driver then checks the server
certificate chain and host name. `sslmode=require` encrypts but does not verify, so the app logs a
warning at start-up in production. Azure Database for PostgreSQL chains to DigiCert Global Root G2 /
Microsoft RSA Root Certificate Authority 2017, both in Node's bundled CA list. For a private CA,
add `sslrootcert=/path/to/ca.pem` to the URL.

`0` for any `RETENTION_*` setting keeps that data forever. The worker runs the purge daily; see
[data retention](runbooks/data-retention.md).

Security headers (Content-Security-Policy and others) are fixed in code, not configured; see
[auth](auth.md#http-security-headers-74).
