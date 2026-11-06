# Agents, memory and the learning loop (Phase 3)

Decision record: [ADR 0002](adr/0002-squad-sdk-embed.md) (hybrid: Squad-shaped files, in-process runtime, Copilot defs).

## Cast and charters (issue #30)

`.squad/agents/<key>/charter.md` for `lead`, `hunter`, `intel`, `responder`, `scribe`, plus
`.squad/team.md` and `.squad/routing.md`. Edit these to customise the cast; the server reads them at
startup (`SQUAD_DIR` overrides the path; the Docker image copies them to `/app/.squad`).

## Runtime (issue #32)

`AgentRuntime.run({ orgId, userId, selection, threadId, messages })` in
`apps/web/src/server/agents/runtime.ts`. The default `LlmAgentRuntime`:

1. Builds the system prompt: charter + org memory (compacted body + recent entries) + global safety rule.
2. Registers only that agent's tools (`AGENT_TOOLS` in `tools.ts`).
3. Streams through TanStack AI `chat()` with `MODEL_PROVIDER`:
   - `stub` (default): deterministic, labelled fake model; no key, works offline.
   - `anthropic` / `openai`: bring your own key (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY`), optional `MODEL_NAME`.
4. Enforces `AGENT_TIMEOUT_MS`; on timeout the chat shows an error instead of hanging.

**Lead (orchestrate squad):** selecting it gives Lead a `delegate` tool that runs specialists
sequentially (non-streaming) and returns their answers; Lead then signs off one combined answer.
Each delegation is a decision row.

No GitHub token or Copilot entitlement is required by the control plane.

### Registering tools (Phase 5+)

Add a `toolDefinition(...).server(...)` in `buildTools`, wrap it in `traced()` so it writes a
decision row, and add its name to the relevant agents in `AGENT_TOOLS`. Never add a tool that
executes KQL or a response proposal; `EXECUTION_TOOL_NAMES` must stay empty (tested).

## Memory (issue #31)

- `agent_memory_entries`: append-only facts per org + agent (`fact`, `feedback`, `safety`, `summary`),
  with source thread/hunt ids.
- `agent_memories`: one compacted body per org + agent with a version number.
- Token-like strings (bearer tokens, JWTs, API keys, `client_secret=`…, Key Vault URLs) are
  redacted before storage and the entry is flagged `redacted`.
- Markdown mapping: `exportHistoryMarkdown` writes Squad-style `history.md`; `importHistoryMarkdown`
  reads bullets back. Agents page shows the export.
- Hunt results are stored as summaries on hunt cases, never as raw tables in memory.

## Decision log (issue #33)

`agent_decisions` records every turn, tool call, delegation, KQL proposal/approval/run and
response decision: actor, action, redacted and truncated input/output summaries, thread and hunt
ids. Indexed on `(org_id, created_at)`. **Agents → Decision log** lists them. This is not the
approval record; response approvals live in `response_events`.

## Learning loop (issue #35)

1. Each assistant message has **useful / wrong / escalate** buttons (`message_feedback`).
2. Feedback appends a `feedback` memory entry for that agent and an audit row.
3. Compaction (Squad `nap` analogue): `pnpm compact-memory [--org <id>] [--keep 20]`, or
   **Agents → Compact memory** (owners/approvers). It keeps the newest N entries live, folds older
   ones into the versioned memory body, and marks them `compacted_at` (raw entries are never
   deleted). Safety entries (containing "never", "do not", "must not") are never folded away and
   are copied verbatim into the body. Compaction is deterministic; it does not invent facts.
   Each run is audited (`category = 'memory'`).

**When to run:** weekly, or when an agent's live entries pass a few hundred. It is cheap and safe to
run often.
