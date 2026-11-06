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
| Customer hunting secrets | any name, referenced as `env:NAME` from the connector | See docs/hunting.md |

Rotation: update the Key Vault secret, then restart the revision
(`az containerapp revision restart`). Rotating `APP_ENCRYPTION_KEY` requires re-saving connector
secrets (they are encrypted with it).
