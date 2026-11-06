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

| Executor | Flag | v1 status |
| --- | --- | --- |
| Logic App HTTP trigger | `RESPONSE_EXECUTOR_LOGICAPP` | **Live-capable.** POSTs `{ proposalId, orgId, action, targets }` to `RESPONSE_LOGICAPP_URL` |
| Sentinel playbook | `RESPONSE_EXECUTOR_SENTINEL` | Documented stub: plans the `runPlaybook` ARM call, makes no request |
| Graph / Defender containment | `RESPONSE_EXECUTOR_GRAPH` | Documented stub: plans `machines/{id}/isolate` calls (allowlisted paths), makes no request |

Flag values: `off` (default; execute refused), `dry-run` (execute records a dry run instead), `on`.

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

When the Sentinel and Graph executors are implemented they will need, respectively, **Microsoft
Sentinel Automation Contributor** (to run playbooks) and the WindowsDefenderATP
`Machine.Isolate` application permission, on a separate app registration from hunting.

## Dry run (issue #53)

Approvers can dry-run any pending or approved proposal. A dry run computes the exact calls
(method, URL with SAS signatures redacted, body, targets) and rollback notes, stores them on the
proposal (`last_dry_run`) and shows them on the detail page. It never performs a request (tested
with mocks). Live execution does not *require* a prior dry run, but the UI prompts for one; teams
can enforce it by policy.

## Audit and rollback (issue #54)

Every step writes a `response_events` row and an `audit_events` row (`category = 'response'`):
`created`, `dry_run`, `approved`, `rejected`, `expired`, `execute_attempt`, `executed`,
`execute_failed`. Payloads are redacted (no tokens or SAS signatures). The proposal page shows the
timeline, dry-run output, execution result and **rollback notes**. Crosswire does not undo actions
automatically; rollback notes tell the operator what to reverse and where.

Owners can download a JSON audit bundle per proposal.

## Responder agent (issue #56)

Responder (and Lead, when orchestrating) has the `propose_response` tool. It requires explicit
targets and a blast radius; the tool rejects proposals without them. On success the agent links to
`/app/approvals/<id>`. No agent has an execute, approve or dry-run tool (enforced by the tool
registry, a lint rule, and tests).

Example transcript:

> **Analyst → Responder:** demo-wks-001 is beaconing to a known C2. Contain it.
>
> **Responder:** I've drafted a proposal to isolate `demo-wks-001` via the Logic App executor.
> Blast radius: one workstation loses network access except to Defender; its user cannot work
> until released. Rollback: release from isolation in the Defender portal. It is **pending
> approval** at /app/approvals/3f2c…; nothing has been executed.
