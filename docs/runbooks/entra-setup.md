# Runbook: customer Entra setup

Crosswire uses **separate app registrations** so sign-in never carries hunting permissions, and
read-only hunting never carries response (write) permissions.

| | SSO app | Hunting app | Response app (v2, optional) |
| --- | --- | --- | --- |
| Purpose | Analysts sign in to Crosswire | Server queries Defender XDR / Sentinel | Approved containment: isolate/release devices, run allowlisted playbooks |
| Flow | OIDC authorisation code (delegated) | Client credentials (application) | Client credentials (application) |
| Permissions | `openid`, `profile`, `email` | `ThreatHunting.Read.All` + Log Analytics Reader + Sentinel Reader | WindowsDefenderATP `Machine.Isolate`; Sentinel Responder on the workspace; Logic App Contributor on allowlisted playbooks |
| Redirect URI | `${APP_URL}/api/auth/callback/microsoft` | none | none |
| Where configured | `ENTRA_CLIENT_ID` / `ENTRA_CLIENT_SECRET` / `ENTRA_TENANT_ID` | Settings → Hunting connector (per org) | Settings → Response connector (per org) |
| Full guide | [docs/auth.md](../auth.md#entra-id-oidc-issue-19) | [docs/hunting.md](../hunting.md) | [docs/response.md](../response.md#live-microsoft-executors-v2-88-89) |

Never add write permissions to the hunting app. Skip the response app entirely if you only use
dry runs or the Logic App executor (whose identity holds the permissions instead).

## Response app (v2)

1. Register `crosswire-response` (single tenant, no redirect URI). Add a client secret, or store it
   in Key Vault and expose it to the container as `CROSSWIRE_RESP_<ORGID>_SECRET`.
2. API permissions → *APIs my organization uses* → **WindowsDefenderATP** → Application →
   `Machine.Isolate`. Grant admin consent. Nothing else.
3. Sentinel playbooks only: on the Sentinel workspace resource group assign **Microsoft Sentinel
   Responder**; on each playbook (Logic App) you will allowlist, assign **Logic App Contributor**.
4. Settings → Response connector: tenant id, client id, secret (or `env:` reference), and the
   playbook allowlist (one Logic App resource id per line).
5. Keep `RESPONSE_DRY_RUN=true`. Create an isolate proposal for a lab device, dry run it, check
   the planned calls show no blockers. Only then follow the change process to go live.

## Checklist

1. SSO app registered, secret in Key Vault/env, single-tenant, `email` optional claim added.
2. Crosswire org linked to the tenant (`orgs.entra_tenant_id`), or `ENTRA_AUTO_PROVISION_ORGS=true`.
3. First Entra user promoted to owner/approver as needed (Settings → Members).
4. Hunting app registered, admin consent granted, Azure roles assigned on the Sentinel workspace.
5. Connector saved in Settings; `HUNTING_DEMO_MODE=false` in production.
6. Test: propose `DeviceInfo | take 5` on a hunt case, approve, confirm `mode: live` on the evidence.
7. Response flags remain `off` until a dry run has been reviewed.
8. (v2) If live response is planned: response app consented, connector saved, playbook allowlist
   reviewed, and an isolate → rollback walked on a lab device.
