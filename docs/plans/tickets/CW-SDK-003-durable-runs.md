# CW-SDK-003. Durable reproducible agent runs

- **Priority:** P0.
- **Class:** adapt. Preview `SquadBackend.readEvents` and `cancelRun` are not imported.
- **Depends on:** CW-SDK-001. Policy hashes from CW-SDK-004 may be nullable until that ticket lands.
- **Blocks:** CW-SDK-005 token rows that need a run id. CW-SDK-010 export of runs.

## Outcome

Every chat turn and every specialist delegation has a durable id, parent id, status, and enough stored context to reconstruct the turn without the 1000-character decision summary.

## Current evidence

- `AgentRunInput` and `AgentRunHandle` in `runtime.ts` have no run id.
- `recordDecision` stores redacted summaries truncated to 1000 characters (`decisions.ts`).
- `handleChat` writes the assistant message after the stream ends. A disconnect still attempts that write with whatever text arrived. There is no `interrupted` state.
- Abort is in-process (`AbortController` from the request signal, plus `withTimeout`).
- Specialist `recordDecision` stores `output: answer` and the trace stores `answer.slice(0, 500)`.
- Since the audit hash, `withoutSamples` removes result rows from the decision log only. It is not a replay record.

## Components

- `apps/web/src/server/agents/runtime.ts`
- `apps/web/src/server/chat/handler.ts`
- `apps/web/src/server/agents/decisions.ts` (keep the activity log)
- `apps/web/src/server/db/schema/app.ts` plus migration
- Read path on the existing chat thread UI only if a run status is already shown. Do not redesign chat.

## Data

`agent_runs`:

| Column | Notes |
| --- | --- |
| `id` | UUID, created before the model stream starts |
| `org_id` | required |
| `parent_run_id` | null for the user turn, set for `delegate` and `delegate_parallel` children |
| `thread_id`, `user_id`, `agent_key`, `selection` | |
| `status` | `running`, `completed`, `failed`, `interrupted` |
| `model_provider`, `model_deployment` | from `modelDescription`, no secrets |
| `charter_sha256`, `policy_sha256`, `tool_allowlist_sha256` | versions bound to the turn |
| `memory_snapshot_id` | ids or hash of the prompt-eligible memory rows, not a copy of quarantined text in a second store |
| `started_at`, `finished_at` | |
| `error` | short, redacted |

`agent_run_events`: ordered `seq`, `run_id`, `org_id`, `kind`, `payload` (redacted, size-capped per event), `created_at`. Kinds include `started`, `tool_call`, `tool_result_ref`, `delegate_spawned`, `completed`, `failed`, `interrupted`.

`agent_run_outputs`: full assistant text and full tool outputs the product already stored for the analyst, with the same org auth as chat messages. This table is the replay body. `agent_decisions` stays truncated.

Cancellation: on abort or timeout, status becomes `interrupted` if no successful completion was committed. A process restart marks `running` rows older than `AGENT_TIMEOUT_MS` plus a grace period as `interrupted` on startup. That reconciliation is idempotent.

## API, UI, jobs

- `LlmAgentRuntime.run` inserts the parent row before `chat()`.
- `runSpecialist` inserts a child row and links it before the specialist call.
- `handleChat` updates status when the SSE loop finishes, errors, or the abort signal fires.
- No new public route in this ticket. Thread metadata may include `runId` for support.
- Startup reconciliation is a function called from the server boot path, covered by a test, not a new daemon.

## Acceptance tests

1. A completed turn has one parent row, status `completed`, and the full assistant text in `agent_run_outputs`. The decision row may still be truncated. The output row is not.
2. `delegate_parallel` of two specialists creates two children with `parent_run_id` set and ordered events.
3. Abort during the stream sets `interrupted` and does not set `completed`.
4. Timeout sets `interrupted` or `failed` with the timeout error, and not `completed`.
5. A row left `running` past the grace period is reconciled to `interrupted` on the next boot call.
6. Charter bytes in the fixture hash to the stored `charter_sha256`.
7. Org B cannot read org A’s run.
8. A tool result larger than 1000 characters is fully present in the output table and truncated in `agent_decisions`.

## Threat

Replay data is sensitive. Store it in Postgres with `org_id`. Do not write it to `log/usage.jsonl` or the repo. Redact credentials inside outputs with the existing redactor, and keep the raw chat row under the existing chat access path. Document which column is raw and which is redacted so operators do not confuse them.

## Rollout

Flag `RUN_LEDGER=off` by default. `on` writes rows without changing the SSE contract. Rollback sets the flag off. Tables remain.

## Out of scope

SDK session resume. Preview durable HTTP backend. Replaying a turn back into a model as an automatic retry.
