# Gated response (Phase 6)

Propose → human approve → execute. Nothing executes unattended.

## Proposal model (issue #50)

Table `response_proposals`:

| Field | Values |
| --- | --- |
| `action_type` | `sentinel_playbook`, `logic_app`, `graph_containment`, `other` |
| `targets` | `{ devices?: string[], users?: string[], incidents?: string[] }` (at least one, max 50 each) |
| `blast_radius` | `{ summary, devices, users, incidents }`. Summary is required (10+ characters); counts are computed from targets |
| `requester_type` / `requester_id` | `user` + user id, or `agent` + agent key |
| `requested_by_user_id` | The human behind the request (for agents: the analyst in the chat) |
| `status` | `pending` → `approved` / `rejected` / `expired` → `executed` / `failed` |
| `expires_at` | Default now + `RESPONSE_PROPOSAL_TTL_HOURS` (24) |
| `last_dry_run`, `execution`, `rollback_notes` | Filled by dry runs and execution |

Shared TypeScript types: `apps/web/src/shared/response.ts`.

## Approval workflow and RBAC (issues #51, #55)

- Transitions happen only on the server; the client never sends a status.
- **Who can approve, reject, dry-run, execute:** `owner` and `approver`. New members are `analyst`.
  Owners change roles under **Settings → Members**.
- **Self-approval is denied by default.** A user cannot decide a proposal they requested, including
  ones an agent created from their chat. `RESPONSE_ALLOW_SELF_APPROVAL=true` is for tiny labs only.
- Double approval is rejected ("already approved"); concurrent decisions are serialised.
- Expired proposals cannot be approved or executed. `pnpm expire:proposals` (and the worker,
  every minute) flips stale `pending` proposals to `expired`.
- The UI hides buttons for non-approvers; the server still returns an error if called.

## Executors (issue #52)

| Executor | Flag | Status (v2) |
| --- | --- | --- |
| Logic App HTTP trigger | `RESPONSE_EXECUTOR_LOGICAPP` | **Live.** POSTs `{ proposalId, orgId, action, targets }` to `RESPONSE_LOGICAPP_URL` |
| Sentinel playbook | `RESPONSE_EXECUTOR_SENTINEL` | **Live (v2, #89).** `POST …/incidents/{id}/runPlaybook?api-version=2025-09-01` per incident, with an **allowlisted** Logic App |
| Defender containment | `RESPONSE_EXECUTOR_GRAPH` | **Live (v2, #89).** `POST api.security.microsoft.com/api/machines/{id}/isolate` (or `unisolate`) per device |
| Other | (none) | Manual: no executor, recorded and approved like any proposal |

Flag values: `off` (default; execute refused), `dry-run` (execute records a dry run instead), `on`.

### Production flag matrix (#83, fail closed)

| `RESPONSE_DRY_RUN` | `RESPONSE_EXECUTOR_X` | Effective | Notes |
| --- | --- | --- | --- |
| unset / `true` | unset / `off` | **off** | Default. Execute refused. |
| unset / `true` | `dry-run` | dry-run | Execute records a dry run. |
| unset / `true` | `on` | **dry-run** | Downgraded; warning logged at boot and shown on the dashboard. |
| `false` | `on` | on | Live calls. Requires a change ticket. |
| invalid value (e.g. `maybe`) | any | — | Server refuses to start (config error). |

Row limits (`HUNTING_MAX_ROWS`, hard cap 1,000) are always on. The effective state is logged at boot
(`response safety`), shown on the dashboard, and in the first-run checklist.

The Logic App URL comes only from server configuration, never from a proposal, so an agent cannot
redirect the call. Executors are called only from `executeProposal`, which requires an approved,
unexpired proposal and an approver, and claims the proposal atomically so it runs once.

### Enabling the Logic App executor

1. Build a Logic App (Consumption or Standard) with an HTTP request trigger. Validate the body,
   check `orgId`, and perform the containment steps you want (for example call Defender's isolate
   API with the Logic App's managed identity).
2. Grant the Logic App's identity only the permissions its steps need (for example
   `Machine.Isolate` on WindowsDefenderATP). Crosswire itself needs no extra Entra permissions for
   this executor.
3. Store the trigger URL (it contains a SAS `sig`) as a secret: `RESPONSE_LOGICAPP_URL`.
4. Start with `RESPONSE_EXECUTOR_LOGICAPP=dry-run`, review dry runs, then `on`.

## Live Microsoft executors (v2, #88, #89)

The Sentinel and Defender executors use a **response connector**: a second Entra app
registration per org, separate from the read-only hunting app (Settings → Response connector,
owners only). Response tokens are minted only from it; the hunting client can never use it, and
response can never borrow the hunting credential. Secrets are stored AES-GCM encrypted, or as
`env:CROSSWIRE_RESP_<ORG>_<NAME>` (a Key Vault-backed container secret).

Least privilege for `crosswire-response` (see [entra-setup](runbooks/entra-setup.md)):

| Executor | Permission |
| --- | --- |
| Defender containment | WindowsDefenderATP application permission `Machine.Isolate` (admin consent) |
| Sentinel playbook | **Microsoft Sentinel Responder** on the workspace, plus **Logic App Contributor** on each allowlisted playbook (Sentinel requires it to trigger a playbook) |

Guards, all checked **before** a token is requested or the proposal is claimed:

- **Playbook allowlist.** `payload.playbookResourceId` must be a Logic App resource id on the org's
  allowlist (owners edit it under Settings). An agent cannot name an arbitrary playbook.
- **Defender machine ids only.** Device targets must be 40-hex Defender machine ids; hostnames are refused.
- **Target cap.** `RESPONSE_MAX_LIVE_TARGETS` (default 10, max 50) devices or incidents per proposal.
- **Response HTTP allowlist.** Exact POST endpoints only: `api.security.microsoft.com/api/machines/{id}/isolate|unisolate`
  and Sentinel `…/incidents/{id}/runPlaybook`. No generic request path; redirects are refused.
- The workspace location comes from the hunting connector's Sentinel fields (not from the proposal).

Each call is recorded separately (`execution.results[]`: target, ok, HTTP status, redacted body).
If some calls fail, the proposal is `failed` with status `partial`, and rollback covers exactly
the calls that succeeded. A dry run shows the exact calls **and** any blockers (`status: blocked`).

Turning a live executor on still needs `RESPONSE_DRY_RUN=false` **and** `RESPONSE_EXECUTOR_X=on`
(the matrix above). Walk isolate → rollback in a lab tenant before enabling either in production.

## Rollback as a gated proposal (v2, #90)

On an executed (or partly failed) live proposal, an approver can click **Propose rollback**. That
creates a **new pending proposal** linked to the original (`rollback_of_id`):

- Defender isolate → `unisolate` for exactly the devices that were isolated successfully.
- Sentinel playbook / Logic App → `other` (manual) carrying the rollback notes, because a playbook
  cannot be reversed generically. The manual reversal is still approved and audited.

The rollback goes through the same approval, RBAC, self-approval ban, dry run and expiry. The
person who proposed it cannot approve it. Only one open rollback per original; a rejected or
expired rollback can be proposed again. Rollbacks of rollbacks are refused (propose a new action).

## Dry run (issue #53)

Approvers can dry-run any pending or approved proposal. A dry run computes the exact calls
(method, URL with SAS signatures redacted, body, targets) and rollback notes, stores them on the
proposal (`last_dry_run`) and shows them on the detail page. It never performs a request (tested
with mocks). Live execution does not *require* a prior dry run, but the UI prompts for one; teams
can enforce it by policy.

## Audit and rollback (issue #54)

Every step writes a `response_events` row and an `audit_events` row (`category = 'response'`):
`created`, `dry_run`, `approved`, `rejected`, `expired`, `execute_attempt`, `executed`,
`execute_failed`, `rollback_proposed`. Payloads are redacted (no tokens or SAS signatures). The proposal page shows the
timeline, dry-run output, execution result and **rollback notes**. Crosswire never undoes an action
on its own: reversal is a new proposal that a person approves (see above).

Owners can download a JSON audit bundle per proposal.

## Responder agent (issue #56)

Responder (and Lead, when orchestrating) has the `propose_response` tool. It requires explicit
targets and a blast radius; the tool rejects proposals without them. On success the agent links to
`/app/approvals/<id>`. No agent has an execute, approve, dry-run, rollback or schedule tool (enforced by the tool
registry, a lint rule, and tests).

Example transcript:

> **Analyst → Responder:** demo-wks-001 is beaconing to a known C2. Contain it.
>
> **Responder:** I've drafted a proposal to isolate `demo-wks-001` via the Logic App executor.
> Blast radius: one workstation loses network access except to Defender; its user cannot work
> until released. Rollback: release from isolation in the Defender portal. It is **pending
> approval** at /app/approvals/3f2c…; nothing has been executed.
