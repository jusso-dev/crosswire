# Day-1 operator playbook: first hunt and first approval (#82)

For the first analyst session after the [go-live checklist](go-live-checklist.md). No tenant yet?
Owners can click **Load demo data** on the dashboard (or `pnpm fixtures:load --email you@…`) and
follow the same steps with `[DEMO]` records.

> **Day-one rule:** do not turn off dry-run or enable any executor. That needs a change ticket.

## 1. Sign in and confirm safety

1. Open the app and choose **Sign in with Microsoft**.
2. Dashboard shows **Response safety: dry-run ON · executors sentinel=off, logicapp=off, graph=off**.
   *Good looks like:* no yellow warning banners. A banner saying an executor was "ignored" means
   someone set a flag; leave it, it is failing closed.

## 2. Watchlist and first hit

1. **Watches** → add a `tag` `cisa-kev` and a `vendor` you run (e.g. `fortinet`).
2. Hits appear after the next worker cycle (hourly) or immediately for demo data.
3. Open a hit's **Compare CVE-…** link to see pwn.watch and CISA KEV side by side.

## 3. First hunt

1. On the hit, click **Start hunt**. Give it a hypothesis.
2. **Chat** → pick **Hunter** → "Propose a KQL query on hunt <title> for <hypothesis>".
   Hunter proposes; it cannot run anything.
3. Back on the hunt case, review the proposed KQL. Edit it if needed (add `| take 100`, tighten
   the time range), then **Approve and run**. If an info notice says another approver must run it,
   your deployment uses a stricter `KQL_APPROVAL_POLICY`: ask a second approver, or propose your
   edit as a new search ([hunting](hunting.md#approval-policy-kql_approval_policy)).
4. *Good looks like:* the evidence trail shows `kql_proposed → kql_approved → kql_result` with
   `mode live`, a row count, and your name as approver.

## 4. First response proposal (dry run only)

1. **Chat** → **Responder** → "Draft containment for <device> from hunt <title>".
2. Open the link it returns (**Approvals**). Check targets and blast radius.
3. An approver (not the requester) clicks **Dry run**, reads the planned calls and rollback notes,
   then **Approve**. Do **not** execute.
4. *Good looks like:* proposal `approved`, a `dry_run` and `approved` event on the timeline, no
   `executed` event.

## 5. Inspect the audit trail

- **Agents → Decision log**: every tool call and decision with redacted inputs.
- **Settings → Audit log** (owners): sign-ins, role changes, response events.
- Old data is removed daily by the retention purge (chat and decision log after 365 days, result
  samples after 180, audit after 730 by default). See [data retention](runbooks/data-retention.md).

## Troubleshooting permission denials

| Message on the hunt case | Fix |
| --- | --- |
| `Permission denied … HTTP 403` from Advanced Hunting | Grant **ThreatHunting.Read.All** (application) to the hunting app and **admin consent** ([hunting](hunting.md#1-register-the-hunting-app-issue-43)) |
| 403 from Sentinel query | Assign **Log Analytics Reader** on the workspace to the hunting app's service principal |
| 403 listing incidents | Assign **Microsoft Sentinel Reader** on the workspace resource group |
| `token was rejected … HTTP 401` | Wrong tenant/client id or expired secret: re-save the connector |
| `Hunting is not configured for this org` | Save the connector in **Settings**, or use demo mode in a lab |
| `Blocked in hunting queries: …` | The query used a blocked operator (externaldata, http_request, management commands); rewrite it |
| "Your organisation requires an approver to run searches." | `KQL_APPROVAL_POLICY` is `approver` or `second-person`: ask an owner or approver to run it |
| "Another approver must run this search. You asked for it, …" | `second-person` policy: a different approver must run it |
| "… an edited search must be proposed as a new search. …" | `second-person` policy: restore the original, or click **Propose the edit as a new search** |
| "Sample removed after N days (retention)" | Expected: the stored sample aged out; the row count is kept. Rerun the query for fresh rows |
| Signed out after a few hours | Expected: `SESSION_MAX_AGE_HOURS` (default 12) or `SESSION_IDLE_MINUTES` (default 60) passed; sign in again |
| Sign-in shows "tenant is not connected" | Link the org to your tenant id or rerun [bootstrap](runbooks/bootstrap.md) with `BOOTSTRAP_ENTRA_TENANT_ID` |
