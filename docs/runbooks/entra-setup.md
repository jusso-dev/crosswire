# Runbook: customer Entra setup

Crosswire uses **two separate app registrations**. Keep them separate so sign-in never carries
hunting permissions.

| | SSO app | Hunting app |
| --- | --- | --- |
| Purpose | Analysts sign in to Crosswire | Server queries Defender XDR / Sentinel |
| Flow | OIDC authorisation code (delegated) | Client credentials (application) |
| Permissions | `openid`, `profile`, `email` | `ThreatHunting.Read.All` + Log Analytics Reader + Sentinel Reader |
| Redirect URI | `${APP_URL}/api/auth/callback/microsoft` | none |
| Where configured | `ENTRA_CLIENT_ID` / `ENTRA_CLIENT_SECRET` / `ENTRA_TENANT_ID` | Settings → Hunting connector (per org) |
| Full guide | [docs/auth.md](../auth.md#entra-id-oidc-issue-19) | [docs/hunting.md](../hunting.md) |

Response executors (Phase 6) need their own, separately consented permissions; see
[docs/response.md](../response.md). Never add write permissions to the hunting app.

## Checklist

1. SSO app registered, secret in Key Vault/env, single-tenant, `email` optional claim added.
2. Crosswire org linked to the tenant (`orgs.entra_tenant_id`), or `ENTRA_AUTO_PROVISION_ORGS=true`.
3. First Entra user promoted to owner/approver as needed (Settings → Members).
4. Hunting app registered, admin consent granted, Azure roles assigned on the Sentinel workspace.
5. Connector saved in Settings; `HUNTING_DEMO_MODE=false` in production.
6. Test: propose `DeviceInfo | take 5` on a hunt case, approve, confirm `mode: live` on the evidence.
7. Response flags remain `off` until a dry run has been reviewed.
