# 0002. Embed `@bradygaster/squad-sdk` vs Copilot-only agents

- **Status:** Accepted (Hybrid)
- **Date:** 2026-11-07
- **Spike:** issue #29. Notes in [docs/spikes/squad-sdk.md](../spikes/squad-sdk.md).

## Context

The product lock prefers embedding `@bradygaster/squad-sdk` rather than reimplementing cast,
memory and orchestration. The control plane runs in Docker as a headless Node server and must work
for contributors without Copilot entitlements.

## Evidence (spike, 2026-11-07)

- `@bradygaster/squad-sdk@1.1.0` is MIT (compatible with Crosswire's MIT licence), ESM-only, Node ≥ 20.
- Its runtime sits on `@github/copilot-sdk@1.0.x`, which drives the **GitHub Copilot CLI over
  JSON-RPC**. The SDK bundles a platform-specific Copilot CLI runtime and authenticates as a GitHub
  user (`authentication: { mode: 'github' }`).
- Sessions, routing (`squad_route`), and fan-out (`spawnParallel`) all create Copilot CLI sessions.
  There is no model-agnostic adapter: every agent turn requires a Copilot-entitled GitHub identity.
- Its state model (`.squad/agents/*/charter.md`, `team.md`, `routing.md`, `decisions.md`,
  history files) is file-based and maps cleanly onto Postgres tables.

## Decision

**Hybrid.** Do not embed the SDK runtime in the control plane for v1. Adopt Squad's *shape*:

- Charters, team and routing live in `.squad/` using Squad's layout, so a team can point Squad or
  Copilot at the repo unchanged.
- The control plane runs agents in-process with an `AgentRuntime` interface
  (`apps/web/src/server/agents/runtime.ts`): charter as system prompt, per-agent tool allowlist,
  model via TanStack AI adapters (Anthropic/OpenAI with BYO key) or a deterministic stub.
- Memory (`history.md`) and decisions (`decisions.md`) live in Postgres per org, with markdown
  export/import.
- The same charters ship as GitHub Copilot custom agents in `.github/agents/*.agent.md` for use
  inside GitHub (issue #34).

## Consequences

- No Copilot entitlement or GitHub token is needed to run the kit; stub mode works offline.
- A future `CopilotSdkRuntime` can implement `AgentRuntime` once headless, service-account
  Copilot auth is supported. That would be a new ADR.
- Follow-up work (done in Phase 3): charters (#30), DB memory (#31), runtime wiring (#32),
  decision log (#33), Copilot defs (#34), feedback and compaction (#35).

## Alternatives considered

- **Go (embed SDK):** blocked on per-user Copilot CLI auth inside a server container; contributors
  without Copilot could not run chat.
- **Copilot-only (no control-plane runtime):** loses the web UI, approvals and org-scoped memory.

## Amendment (2026-11-08)

The spike evidence above is unchanged. It described `@bradygaster/squad-sdk@1.1.0` as it behaved when the whole runtime, including `CopilotClient`, was started. That is not how the control plane uses the package now.

Commit `4b24ab1638c1dcd782ec7fe2af4241c3cd39ca74` is on `main`. That commit pinned 1.1.0 and loaded `UsageLedger` and `ContextUtilizationTracker` by file URL. This working tree does not. The follow-up is local: it is not a new pushed commit and it is not deployed.

- The dependency is pinned to `@bradygaster/squad-sdk@1.1.0` exactly. npm `latest` on 08-11-2026 was still `1.1.0`. `preview` and `insider` were `2.0.0-preview.3`. No stable `2.0.0` was published. `HarnessAdapter` is not in the 1.1.0 package and is not imported. Moving to that preview to gain an export would be a provider and runtime change, and it is not taken.
- SOC turns stay on `LlmAgentRuntime` and TanStack AI `chat()`. The model is Azure OpenAI or an OpenAI-compatible endpoint (ADR 0004). The adopted imports are `@bradygaster/squad-sdk/builders`, `/memory`, `/storage` (`InMemoryStorageProvider` only) and `/runtime/cost-tracker`.
- `UsageLedger` and `ContextUtilizationTracker` are in the 1.1.0 dist and are not package exports. Production does not import them by file URL. A test walks the four supported subpaths and the files they import. None of those specifiers resolve to `@github/copilot-sdk`, `./client`, `./backend`, `usage-ledger.js`, or `context-utilization.js`. The client-boundary test is not imported from `src/`. The SDK default ledger path `log/usage.jsonl` is not written. Observed tokens are rows in `agent_usage`. When `BUDGET_USD_PER_MILLION_TOKENS` is unset, `estimated_cost_micros` is null and `CostTracker` is not called. Storing 0 would claim the call was free. A finished call with no token count stores null tokens and null micros, and the next budget check refuses even with no spend cap. A direct ledger write of explicit zeroes stays a real count. A finished turn that reports 0/0 and already has assistant text is stored as null tokens instead. A run claims its input estimate under a per-org lock before the call. One observed row is kept per run, and `CostTracker` totals are kept per organisation. A cost that does not fit in a Postgres integer is stored as null micros. Context refusal is local `assessContextWindow` at 0.8, the same default the unexported tracker documents. The tracker is not called.
- Capacity is a per-run claim (`slot_held`, `slot_released` in migration `0006_slot_claim`). Reconcile returns only a slot that row held. It does not set inflight from the count of running rows. `withTimeout` reports a timeout only for the timer abort. The owning process polls `cancel_requested_at` every 500 ms and aborts the live model call with reason `cancelled`. That is not a timeout. A specialist shares the turn controller, so cancelling the child also stops the parent stream. A failed poll retries and does not abort a healthy turn. The specialist `chat()` promise is raced with abort. Run replay redacts secrets, including a tool error. The decision summary is the truncation of that redacted text. Sample arrays in that replay follow `RETENTION_SAMPLES_DAYS`, and the cleared sample is absent from the org bundle. An org member can open one run on the Agents page. Another organisation cannot. `RUN_LEDGER=legacy` writes no replay row. The page was not clicked in a browser on this pass.
- The SOC module graph does not import `@github/copilot-sdk`, `@bradygaster/squad-sdk/client`, or `@bradygaster/squad-sdk/backend`. pnpm still installs `@github/copilot-sdk` because 1.1.0 depends on it. Installing it does not start a Copilot session.
- A Copilot seat is not required for a Crosswire chat turn. Copilot custom agents under `.github/agents/` remain optional and still need a Copilot licence for that product.
- The sentence "every agent turn requires a Copilot-entitled GitHub identity" is historical spike evidence. It is not the control-plane rule.
- A constructor-only `SquadClient` test, with an empty environment and `useLoggedInUser: false`, stays disconnected and does not call `connect()` or `createSession()`. That is not live customer-model compatibility. No provider key and no GitHub token were present, and those calls were not made. SOC turns were not moved onto `SquadClient`.

`loadConfig` refusing a missing charter was not executed. Crosswire's own charter loader fails closed.
