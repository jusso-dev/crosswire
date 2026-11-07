# Hunting: Defender XDR and Microsoft Sentinel

Phase 5 lets the Hunter agent (and analysts) hunt **live** in a customer tenant. It is
read-oriented: queries are proposed, reviewed by a human, then run with hard limits. Nothing in
this phase changes tenant state.

## 1. Register the hunting app (issue #43)

Create a **separate** app registration from the SSO app, so hunting permissions are never mixed
with sign-in. One customer tenant per Crosswire org.

1. Entra admin centre → App registrations → New registration → `Crosswire Hunting`,
   single tenant, no redirect URI (client credentials only).
2. Certificates & secrets → new client secret (or upload a certificate).
3. Add the permissions below, then **Grant admin consent** (Global Admin or Privileged Role Admin).

### Least-privilege permissions

| API | Permission | Type | Why | Consent |
| --- | --- | --- | --- | --- |
| Microsoft Graph | `ThreatHunting.Read.All` | Application | Run Advanced Hunting KQL via `POST /v1.0/security/runHuntingQuery` | Admin |
| Log Analytics workspace (Azure RBAC) | **Log Analytics Reader** on the Sentinel workspace | Role assignment | Run KQL via `api.loganalytics.io/v1/workspaces/{id}/query` | Azure role |
| Microsoft Sentinel (Azure RBAC) | **Microsoft Sentinel Reader** on the workspace's resource group | Role assignment | List incidents (read-only) | Azure role |

Assign the two Azure roles to the app's service principal (Access control (IAM) → Add role
assignment). Prefer the narrowest scope (the workspace or its resource group).

Application permissions are used (not delegated) because queries run server-side for the org, not
as the signed-in analyst. The human review step is the control on what runs.

### Not requested in Phase 5

Do **not** grant: `SecurityIncident.ReadWrite.All`, `SecurityAlert.ReadWrite.All`,
`Machine.Isolate`, `Machine.ReadWrite.All`, `User.ReadWrite.All`, `Directory.ReadWrite.All`,
`Microsoft Sentinel Responder/Contributor`, or any Logic App contributor role. Write and
containment permissions belong to Phase 6 executors (docs/response.md) and are granted separately.

## 2. Configure the connector (issue #44)

Settings → Hunting connector (org owners only): tenant ID, client ID, and either

- **Client secret:** encrypted with AES-256-GCM using `APP_ENCRYPTION_KEY` before it is stored in
  `org_connectors.client_secret_enc`. It is never returned to the browser.
- **Secret reference:** `env:CROSSWIRE_HUNT_<ORGID>_<NAME>`, where `<ORGID>` is the org id in
  upper case with dashes removed (the form shows the exact prefix in its error message). The server
  reads that environment variable. Refs outside the org's own prefix are refused, so one org can
  never use another org's secret or the app's own secrets. In Azure Container Apps, add a Key Vault
  reference secret and expose it under that name; this is the Key Vault pattern, and no secret is
  stored in Postgres.

Sentinel needs the subscription ID, resource group, workspace name and the Log Analytics
workspace ID (GUID).

The token broker (`apps/web/src/server/hunting/broker.ts`) uses the OAuth client-credentials grant
against `login.microsoftonline.com/{tenant}`, caches tokens in memory until a minute before expiry,
and never logs them. Missing config raises "Hunting is not configured for this org".

## 3. Propose → review → run (issues #45–#48)

1. Open or create a hunt case (**Hunts**). Watch hits have a "Start hunt" link.
2. Hunter (via chat) or an analyst proposes KQL. `propose_kql` never executes.
3. A person reviews the query on the case, edits it if needed, and clicks **Approve and run**.
   The stored query is exactly what ran; the original proposal is kept.
4. Results are summarised onto the evidence trail (row count, columns, first 20 rows, who
   approved). Raw result sets are not stored.
5. Proposals expire after `KQL_PROPOSAL_TTL_HOURS` (default 24) and can never run after that.
   Rejected proposals never run.

Agent tools on Hunter: `propose_kql`, `get_hunt`, `list_sentinel_incidents`, `memory_search`.
There is no `run_kql` tool; running requires a human user action (enforced server-side).

## 3a. Scheduled hunts (v2, #92)

An owner or approver can turn a query that **already ran** into a recurring hunt: on the hunt
case, under the query card, pick an interval (hour, 6 hours, day, week) and click **Schedule**.

- The schedule stores a **frozen copy** of the exact KQL that ran. It is never edited in place;
  to change the query, propose and run a new one and schedule that.
- Approval lasts at most **30 days**. When it lapses, the worker disables the schedule and records
  `schedule_disabled` on the case; it never runs again until an approver clicks **Re-approve**.
- Minimum interval 60 minutes. The worker checks every minute and claims each due schedule
  atomically (`FOR UPDATE SKIP LOCKED`), so extra worker replicas never run a schedule twice.
- Runs go through the same `HuntingClient` (allowlist, KQL blocklist, row and timeout caps) and
  add `scheduled_result` / `scheduled_failed` evidence with the approver's id.
- When a run returns rows and the count changed since the last run, subscribed Teams/Slack
  channels get a `scheduled_hunt` notification (see [notifications](notifications.md)).
- Agents have no schedule tool. `SCHEDULED_HUNTS_ENABLED=false` stops the worker loop entirely.

## 3b. Hunt report (v2, #94)

**Export report (Markdown)** on any hunt case downloads a shareable report: hypothesis, origin
watch hit, every query that ran (exact KQL, who approved it and when, row count, columns, a
5-row × 8-column redacted sample), other proposals, schedules and recent scheduled results, linked
response proposals (including rollbacks) and the evidence timeline. Any member of the org can
export its hunts; exports are audited (`hunt_report_exported`). Reports are capped at 200,000
characters. Full result sets stay in Defender / Sentinel.

## 4. Safety rails (issue #49)

- **Separate client.** `HuntingClient` is the only HTTP path for hunting. It has no generic
  request method. Response executors use a different module.
- **Endpoint allowlist** (method + host + exact path pattern, https only):
  - `POST graph.microsoft.com/v1.0/security/runHuntingQuery`
  - `POST api.loganalytics.io/v1/workspaces/{guid}/query`
  - `GET management.azure.com/.../providers/Microsoft.SecurityInsights/incidents`
- **KQL checks:** max 10,000 characters; scans the raw query text (including comments and string
  literals, so a `//` in a URL cannot hide anything) and blocks `externaldata`, `external_table()`,
  `evaluate http_request/sql_request/python/R`, management commands (`.drop`, `.set`, ...) and
  `cluster()`.
- **Limits:** default 100 rows (`HUNTING_MAX_ROWS`), hard cap 1,000; timeout default 60 s, hard
  cap 120 s, whatever callers pass.
- **Audit:** every proposal, approval, run and failure writes an `agent_decisions` row.

Residual risk: approved KQL can read any table the app is allowed to read. That is the point of
hunting; the review step and the evidence trail are the controls.

## 5. Demo mode for contributors

With `HUNTING_DEMO_MODE=true` (default), orgs without a connector get deterministic fixture data,
clearly labelled `mode: demo` and "[demo]". No tenant is contacted. Set it to `false` in
production so a missing connector fails loudly instead.
