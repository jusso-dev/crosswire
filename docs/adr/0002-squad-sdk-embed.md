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

Verified in this tree, not yet merged:

- The dependency is pinned to `@bradygaster/squad-sdk@1.1.0` exactly. npm `latest` on 08-11-2026 was still `1.1.0`. `preview` and `insider` were `2.0.0-preview.3`. No stable `2.0.0` was published. `HarnessAdapter` is not in the 1.1.0 package and is not imported.
- SOC turns stay on `LlmAgentRuntime` and TanStack AI `chat()`. The model is Azure OpenAI or an OpenAI-compatible endpoint (ADR 0004). The adopted imports are `@bradygaster/squad-sdk/builders`, `/memory`, `/storage` (`InMemoryStorageProvider` only) and `/runtime/cost-tracker`.
- `UsageLedger` and `ContextUtilizationTracker` are in the 1.1.0 dist but are not package exports. They are loaded by file URL next to `cost-tracker`. The ledger path passed in is `memory/usage.jsonl`, not the SDK default `log/usage.jsonl`.
- The SOC module graph does not import `@github/copilot-sdk`, `@bradygaster/squad-sdk/client`, or `@bradygaster/squad-sdk/backend`. pnpm still installs `@github/copilot-sdk` because 1.1.0 depends on it. Installing it does not start a Copilot session.
- A Copilot seat is not required for a Crosswire chat turn. Copilot custom agents under `.github/agents/` remain optional and still need a Copilot licence for that product.
- The sentence "every agent turn requires a Copilot-entitled GitHub identity" is historical spike evidence. It is not the control-plane rule.

`loadConfig` refusing a missing charter was not executed. Crosswire's own charter loader fails closed. `SquadClient` BYOK was not re-run. ADR 0004 remains the evidence for a customer model without a GitHub account.
