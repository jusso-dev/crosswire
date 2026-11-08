# CW-SDK-004. One validated policy source, fail closed

- **Priority:** P0.
- **Class:** adopt builders for validation. Adapt Crosswire so missing charters and routing drift fail startup. `defineSquad` alone does not read charter files.
- **Depends on:** CW-SDK-001.
- **Blocks:** trustworthy hashes on CW-SDK-003, skills in CW-SDK-007, egress rules in CW-SDK-006.

## Outcome

One TypeScript registry produces the roster, charters’ expected paths, tool allowlists, and routing rules. Startup calls `defineSquad`. A missing, empty, or unexpected charter refuses to serve chat. `.squad/team.md` and `.squad/routing.md` are generated from that registry and tested for drift.

## Current evidence

- `AGENT_KEYS` is the roster (`shared/agents.ts`).
- `AGENT_TOOLS` is a second map (`tools.ts`).
- `loadCharters` substitutes a fallback string when a file is missing (`charters.ts`).
- `runtime.ts` does not parse `.squad/routing.md`.
- `docs/agents.md` says the server reads team and routing files at startup. It does not.
- 1.1.0 `defineAgent` requires `name` and `role` only. `charter` is an optional string. Verified in `dist/builders/index.js`.

## Components

- New `apps/web/src/server/agents/registry.ts` (typed source)
- `charters.ts`, `tools.ts`, `shared/agents.ts`, `runtime.ts`
- `.squad/team.md`, `.squad/routing.md`, `.github/agents/*.agent.md` as generated outputs
- `apps/web/test/charters-sync.test.ts` extended
- A startup check used by the server and by a CLI diagnostic (the diagnostic UI copy is CW-SDK-010)

## API and data

`buildRegistry()` returns the object passed to `defineSquad`:

- team name and the five members
- one `defineAgent` per key, `charter` set to the repo-relative path, `tools` equal to `AGENT_TOOLS[key]`
- `defineRouting` rules that match today’s selector: a direct specialist selection records reason `explicit`, Lead orchestrate records reason `orchestrate`
- `defineBudget` numbers left empty or conservative until CW-SDK-005 supplies real caps. Do not invent a spend limit in this ticket.

Fail closed:

- Charter file missing, empty, or not valid UTF-8: throw before `agentRuntime()` accepts a turn.
- Tool name in the registry that is not in `buildTools`: throw.
- Agent key in routing that is not in `AGENT_KEYS`: throw.
- `EXECUTION_TOOL_NAMES` must remain empty. Existing test stays.

Routing audit: each turn’s decision or run row includes `routeReason` and the matched rule id. That can be a column on `agent_runs` when CW-SDK-003 exists, or a `recordDecision` action in the meantime.

No new table is required if hashes are computed at startup and stored on the run row later.

`loadConfig` from the SDK: call it in a test against a temp directory. Record whether a missing charter throws `ConfigValidationError`. Crosswire’s file check runs either way. Do not switch the running app to `loadConfig` as the only gate until that test is green and the config it reads is the registry, not a second hand-edited file.

## UI and jobs

No new page. Chat startup error is the existing model-not-configured style message only if charters fail in production. Prefer process exit on boot for a missing charter so a bad image does not serve a fallback prompt. The readiness check fails when the registry fails.

Job: `pnpm` script `agents:check` runs the same function. It does not deploy.

## Acceptance tests

1. Temp dir with one charter deleted: registry check throws, and `systemPromptFor` is not called.
2. Empty charter file throws.
3. `defineSquad` of the real registry returns.
4. `defineAgent` with an empty name throws `BuilderValidationError`.
5. Drift test: `.squad/routing.md` and `.squad/team.md` match the generator output byte for byte.
6. `.github/agents/*.agent.md` still contain the charter safety rules (existing sync test).
7. A routing fixture for “orchestrate” records the rule id used.
8. Two copies of an allowlist are not hand-maintained. `AGENT_TOOLS` is derived from the registry or the test fails when they differ.

## Threat

A fallback charter plus a live tool allowlist is a fail-open policy. Refusing startup is the control. Generated markdown is not edited by hand. A pull request that changes a charter updates the hash tests.

## Rollout

The fail-closed check is safe to enable once CI fixtures include all five charters. The Docker image already copies `.squad`. A bad image should fail readiness rather than answer with the fallback prompt. Rollback is reverting the boot check. Do not ship the check and a charter deletion in one change.

## Out of scope

Letting customers add an agent by dropping a file. Skill bodies (CW-SDK-007). Response-mode engine.
