# Agents, memory and the learning loop (Phase 3)

Decision records: [ADR 0002](adr/0002-squad-sdk-embed.md) (Squad-shaped files, Copilot custom agents) and [ADR 0004](adr/0004-chat-model-azure-openai.md) (Crosswire hosts the agents; model on Azure OpenAI). Setup: [copilot-chat.md](chat-model.md).

## Cast and charters (issue #30)

`.squad/agents/<key>/charter.md` for `lead`, `hunter`, `intel`, `responder`, `scribe` is the charter
source. The loader fails closed (`CharterError`) when a file is missing, empty, or does not contain
`Never execute containment without an approved proposal.` `defineAgent` does not open those files.
`SQUAD_DIR` overrides the directory. The Docker image copies `.squad` to `/app/.squad`.

`.squad/team.md` and `.squad/routing.md` are generated views of `apps/web/src/server/agents/policy.ts`.
The server does not parse them. The analyst's selection still chooses the agent. `defineRouting`
checks the rule list. It does not steer a live turn.

## Runtime (issue #32)

`AgentRuntime.run({ orgId, userId, selection, threadId, messages })` in
`apps/web/src/server/agents/runtime.ts`. The default `LlmAgentRuntime`:

1. Reconciles stale runs, loads the fail-closed policy (charters, skill allowlists, `defineSquad`), and redacts the model copy of history.
2. Builds the system prompt: charter, approved org directives, eligible org memory, and the global safety rule. Quarantine, tombstones and injection text stay out.
3. Opens an `agent_runs` row (charter, policy, toolset and memory hashes, SDK pin `1.1.0`) unless `RUN_LEDGER=legacy`.
4. Registers only that agent's tools (`AGENT_TOOLS`, re-exported from `policy.ts` by `tools.ts`).
5. Refuses the call when the token, context, daily, spend or inflight budget says no. The slot is taken only after the model adapter exists, and released when the stream finishes.
6. Streams through TanStack AI `chat()` with the model from `model.ts`: `MODEL_PROVIDER=azure`
   (Azure OpenAI, Entra ID sign-in) or `openai-compatible`. See [chat-model.md](chat-model.md).
   `modelOptions.max_tokens` plus a character stop enforce the output budget. There is no Copilot provider.
7. Enforces `AGENT_TIMEOUT_MS`. The worker also marks old or cancelled `running` rows `interrupted`. If both the web process and the worker are down, those rows stay `running` until one of them starts. `server.mjs` and `start.ts` do not reconcile.

**Lead (orchestrate squad):** selecting it gives Lead two tools. `delegate` runs one specialist
(non-streaming) and returns its answer. `delegate_parallel` (v2, #93) runs up to 4 *different*
specialists at the same time and returns each answer or error; a failure in one does not drop the
others, and all share the turn's abort signal and `AGENT_TIMEOUT_MS`. Lead then signs off one
combined answer. Each delegation is a decision row. Sub-agents get only their own tool allowlist,
which never contains an execute, approve, schedule or rollback tool.

No GitHub token or Copilot entitlement is required.

### Registering tools (Phase 5+)

Add a `toolDefinition(...).server(...)` in `buildTools`, wrap it in `traced()` so it writes a
decision row, and add its name to the relevant agents in `AGENT_TOOLS`. Never add a tool that
executes KQL or a response proposal; `EXECUTION_TOOL_NAMES` must stay empty (tested).

## Memory (issue #31)

- `agent_memory_entries`: append-only facts per org + agent (`fact`, `feedback`, `safety`, `summary`),
  with source thread/hunt ids, trust (`operator`, `quarantine`, `reviewed`) and visibility (`org`, `private_case`).
- `agent_memories`: one compacted body per org + agent with a version number.
- Token-like strings (bearer tokens, JWTs, API keys, `client_secret=`…, Key Vault URLs) are
  redacted before storage and the entry is flagged `redacted`. Squad `classify()` then runs on the
  redacted body. `FORBIDDEN` and `TRANSIENT` are refused. `POLICY` and `DECISION` are quarantined
  unless the row is an operator safety sentence. `classify()` marks generic instruction injection as
  `LOCAL` and allowed. Crosswire quarantines that text anyway (`MEMORY_GOVERNANCE=enforced`, the default).
- Untrusted sources (`thread`, `message`, `import`, `remember`, `tool`, `feedback`, `scribe`) are
  quarantined. A different person may promote a normal note. The author cannot. Injection text cannot
  be promoted. Tombstoned rows stay stored and stay out of the prompt.
- Markdown mapping: `exportHistoryMarkdown` writes Squad-style `history.md`; `importHistoryMarkdown`
  reads bullets back as `sourceType=import`, so they are quarantined. Agents page shows the export.
- Versioned org export (`exportOrgBundle`, schema version 1) round-trips content and hashes. Import
  does not restore `approved` directives or reviewed trust, except operator safety sentences that are
  not injection. A second import skips the same content hash. A hash mismatch is refused.
- Hunt results are stored as summaries on hunt cases, never as raw tables in memory. The model copy
  of a tool result drops `sample` rows (`EGRESS_FILTER=enforced`). The run output keeps the full value.

## Decision log (issue #33)

`agent_decisions` records every turn, tool call, delegation, KQL proposal/approval/run and
response decision: actor, action, redacted and truncated input/output summaries, thread and hunt
ids. Indexed on `(org_id, created_at)`. Summaries are cut at 1000 characters and then a truncation
marker is appended, so the stored summary can be a little longer than 1000. **Agents → Decision log**
lists them. This is not the approval record; response approvals live in `response_events`.

The replay record is `agent_run_outputs.body`. It is not cut to 1000 characters. `agent_runs` and
`agent_run_events` hold status, parent run, policy and charter hashes, and cancel or timeout recovery.

## Learning loop (issue #35)

1. Each assistant message has **useful / wrong / escalate** buttons (`message_feedback`).
2. Feedback appends a `feedback` memory entry for that agent and an audit row. The source is untrusted, so the entry is quarantined and is not injected until a different person promotes it.
3. Compaction (Squad `nap` analogue): `pnpm compact-memory [--org <id>] [--keep 20]`, or
   **Agents → Compact memory** (owners/approvers). It keeps the newest N trusted entries live, folds older
   trusted ones into the versioned memory body, and marks them `compacted_at` (raw entries are never
   deleted). Quarantine stays live for review and is not folded into the prompt. Operator safety entries (containing "never", "do not", "must not", and not from an untrusted source) are never folded away and
   are copied verbatim into the body. Compaction is deterministic; it does not invent facts.
   Each run is audited (`category = 'memory'`).
4. Reviewed skills live in `skills.ts` and are checked with `defineSkill`. Their tools must be inside that agent's allowlist. Org directives are separate rows. They are created as drafts. The author cannot approve one. Only approved directives enter the system prompt. Incident reviews, handovers and lessons do not promote policy. A lesson is a draft directive.

**When to run:** weekly, or when an agent's live entries pass a few hundred. It is cheap and safe to
run often.
