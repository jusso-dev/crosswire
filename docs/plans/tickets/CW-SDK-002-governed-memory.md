# CW-SDK-002. Governed memory and prompt-injection defence

- **Priority:** P0. Must land before production SOC reliance.
- **Class:** adopt SDK classify/write/promote. Adapt Crosswire quarantine, visibility, and prompt assembly.
- **Depends on:** CW-SDK-001.
- **Blocks:** CW-SDK-007, CW-SDK-008, the export schema in CW-SDK-010.

## Outcome

Untrusted text cannot become system-prompt policy. `LocalMemoryStore` rejects `FORBIDDEN` and `TRANSIENT`. Crosswire also quarantines instruction-shaped text that the SDK classifies as allowed. Safety entries stay in the prompt beyond the newest 20 rows and across compaction. Promotion to org policy is a human action with no self-approval.

## Current evidence

- `memory.ts` `appendMemory` inserts `fact`, `feedback`, `safety`, or `summary` after secret redaction. No trust state.
- `memoryContext` uses `listMemoryEntries(..., { limit: 20 })`.
- `compactMemory` keeps safety live and copies it into the compacted body, but the newest-20 window can hide a safety row before that job runs.
- `tools.ts` `remember` accepts another agent key.
- `threads.ts` `submitFeedback` calls `appendMemory` with the rationale.
- `systemPromptFor` interpolates the result into `systemPrompts`.
- SDK `FORBIDDEN` patterns do not match a generic “ignore previous instructions” sentence. Verified in 1.1.0 `dist/memory/index.js`.

## Components

- `apps/web/src/server/agents/memory.ts`
- `apps/web/src/server/agents/squad-sdk.ts` (process-local `LocalMemoryStore` on `InMemoryStorageProvider` from `@bradygaster/squad-sdk/storage`, for classification only. Do not construct the file or SQLite providers.)
- `apps/web/src/server/agents/runtime.ts` `systemPromptFor`
- `apps/web/src/server/agents/tools.ts` `remember`
- `apps/web/src/server/chat/threads.ts` `submitFeedback`
- `apps/web/src/server/db/schema/app.ts` and a new drizzle migration
- `apps/web/src/fns/agents.ts` if the agents screen lists entries
- Tests in `apps/web/test/`

## Data

Extend `agent_memory_entries` additively:

| Column | Values |
| --- | --- |
| `sdk_class` | SDK `MemoryClass` or null for legacy rows |
| `trust` | `quarantine`, `agent_local`, `approved` |
| `visibility` | `private_case`, `org` |
| `case_id` | nullable hunt or thread id when visibility is `private_case` |
| `content_sha256` | hash of the stored body |
| `approved_by` | user id, null unless `trust=approved` |
| `supersedes_id` | nullable entry id |
| `tombstoned_at` | nullable |

Legacy rows stay readable. `MEMORY_GOVERNANCE=legacy` keeps today’s insert path. `enforced` uses the gate below.

Do not add a Git or filesystem memory provider.

## API and jobs

`appendMemory` gains an internal gate:

1. Call `LocalMemoryStore.write` (or `classify` plus `write`) on the in-memory store.
2. If `stored === false`, do not insert a prompt-eligible row. Insert an audit row that records the class and reason, with the body redacted. Return a rejection to `remember`.
3. If the SDK class is `POLICY` or `DECISION`, or the source is `thread`, `message`, `import`, `remember`, or a tool result, store `trust=quarantine`. It is not loaded by `memoryContext`.
4. `remember` may target only `ctx.agentKey`. A different `agent` is rejected.
5. Promotion is a new server function: approver is an org admin, approver is not the author, body hash matches, visibility is chosen explicitly. It calls SDK `promote` only as a second check, then updates Postgres. The SDK in-memory store is not the record of promotion.
6. `memoryContext` loads every live `kind=safety` or approved safety directive, then quarantines nothing, then the newest other approved rows up to the existing budget. Tombstones and superseded rows are omitted.
7. `submitFeedback` still stores feedback. `trust` stays `quarantine` until promotion.
8. `compactMemory` must not copy quarantined bodies into the compacted prompt. Safety behaviour stays: safety is copied and kept live.

UI: the agents memory panel shows trust and visibility. Quarantine is the empty-prompt default, not an error toast that dumps the body into the chat system prompt. A promotion control is visible only to someone who may approve. No new public page is required if the existing agents route can show the columns.

Jobs: `pnpm compact-memory` stays. It must refuse to promote.

## Acceptance tests

Use fixture strings in unit tests. Do not use a live tenant.

1. Private-key fixture: SDK `write` returns `stored: false`, class `FORBIDDEN`. Postgres gains no prompt row. `systemPromptFor` does not contain the fixture.
2. Transient fixture (a CI status line the SDK already classifies as transient): same, class `TRANSIENT`.
3. Injection fixture that SDK `classify` returns as `LOCAL` and `allowed: true` (assert that SDK result in the test, so a future SDK change is visible): Crosswire stores `trust=quarantine`. `systemPromptFor` does not contain it.
4. Policy-shaped line beginning with “Never execute containment without approval” from `remember`: quarantined, not in the prompt, until a different user promotes it.
5. Author cannot promote their own row.
6. `remember` with `agent` set to another key does not write that agent’s row.
7. Insert one safety row, then 25 newer facts. Before compaction, `systemPromptFor` still contains the safety body.
8. After `compactMemory`, the safety body remains and the injection fixture is absent from the compacted body.
9. Two orgs. Org A’s approved memory is absent from org B’s prompt.
10. `private_case` memory for hunt H appears only when the run’s case id is H. It does not appear in an unrelated thread.
11. Feedback rationale with the injection fixture is stored and absent from the prompt.
12. Import of a markdown bullet with the injection fixture is quarantined.

## Threat

This is the memory-to-prompt boundary. The SDK gate stops the patterns it actually implements. Crosswire stops unreviewed policy and instruction text the SDK allows. No claim of a proven in-tenant exploit.

## Rollout

Flag `MEMORY_GOVERNANCE`. Default `legacy` until these tests pass. Then `enforced` in a non-production environment. Rollback sets the flag to `legacy`. New columns remain.

## Out of scope

Copilot memory provider. Cross-agent automatic promotion. Deleting raw evidence. Changing retention of chat messages except that quarantined memory is not compacted into the prompt.
