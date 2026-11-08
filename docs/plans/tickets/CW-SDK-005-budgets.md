# CW-SDK-005. Token, context, and spend limits

- **Priority:** P0 before routine multi-agent use. After the run id exists.
- **Class:** adopt `CostTracker` and `ContextUtilizationTracker`. Adapt Postgres ledger, fail-closed concurrency, and approved fallback.
- **Depends on:** CW-SDK-001, CW-SDK-003.
- **Blocks:** nothing else in the set. CW-SDK-006 should see the same provider identity.

## Outcome

Each run records input tokens, output tokens, and an estimated cost for the org. A turn that would exceed the context budget, the output cap, the org budget, or the shared in-flight cap does not call the model. Fallback cannot switch provider by itself.

## Current evidence

- `createModelAdapter` takes `_agentKey` and ignores it. One deployment for every role.
- Providers are `azure`, `openai-compatible`, and `off` (`model.ts`).
- Lead `maxIterations(6)`, specialist `maxIterations(4)`, `AGENT_TIMEOUT_MS` default 90000.
- `DbRateLimiter` shares request counts on `app_rate_limits` and fails open on database error (`http-security.ts`). That is an HTTP limit.
- `telemetry.mjs` instruments HTTP with Azure Monitor. No agent token ledger.
- SDK `CostTracker.recordUsage` stores numbers the caller passes. It does not read a provider invoice. SDK `ContextUtilizationTracker` warns at 0.8 by default and does not block `chat()`.
- SDK `UsageLedger` writes `log/usage.jsonl` unless storage is injected.

## Components

- `model.ts`, `runtime.ts`, `handler.ts`
- `squad-sdk.ts`
- New `apps/web/src/server/agents/budget.ts`
- Schema: `agent_usage` and `org_budget`
- Env schema in `env.ts` for caps. Names are decided in implementation. Suggested: `AGENT_MAX_INPUT_TOKENS`, `AGENT_MAX_OUTPUT_TOKENS`, `ORG_AGENT_BUDGET_CENTS`, `AGENT_MAX_INFLIGHT`.

## Data

`agent_usage`: `org_id`, `run_id`, `agent_key`, `provider`, `deployment`, `input_tokens`, `output_tokens`, `estimated_cost_micros`, `created_at`.

`org_budget`: `org_id`, `period_start`, `limit_micros`, `spent_micros`. Period is calendar month in UTC unless the org record already has a timezone convention. Check `docs` before inventing a second timezone.

In-flight cap uses a Postgres advisory row or `app_rate_limits`-style counter that fails closed: database error means the turn does not start. Do not reuse the fail-open HTTP limiter for this.

## API, UI, jobs

Before `chat()`:

1. Estimate prompt size with the tracker’s model window resolver if one is configured, otherwise a conservative character-to-token estimate documented in the test.
2. If `warning` is true, still allow the call only when under the hard cap. If over the hard cap, fail the run as `failed` with a visible chat error.
3. Acquire the in-flight slot. Release it in `finally`.
4. Pass `maxTokens` or the TanStack equivalent if the installed `@tanstack/ai@1.2.0` API supports an output cap. Verify against current TanStack types during implementation. If it does not, stop the stream client-side at the cap and record `interrupted`. Do not guess a parameter name in this draft.
5. After the provider returns usage, call `CostTracker.recordUsage` and insert `agent_usage`. If the provider omits usage, record `input_tokens` as the estimate and set a boolean `usage_estimated`.
6. Optional `UsageLedger` only with a storage object that inserts into `agent_usage`. Assert the test’s cwd gains no `log/usage.jsonl`.

Fallback: a second deployment is used only when env lists it as `AGENT_FALLBACK_DEPLOYMENT` on the same `MODEL_PROVIDER`. A different provider is a hard error. The run row records `fallback=true`.

UI: settings may show spent and limit if the settings page already loads org config. Otherwise a server function is enough and the page can wait. Do not block the ticket on a new dashboard.

Job: none beyond the existing process. Budget reset is a row per period, not a cron that deletes usage.

## Acceptance tests

1. `CostTracker` summary matches the inserted `agent_usage` row for one run.
2. A prompt over the hard cap does not invoke the model adapter (mock adapter asserts zero calls).
3. Two parallel runs at `AGENT_MAX_INFLIGHT=1` : the second fails closed before the adapter.
4. Database error on the in-flight check fails closed.
5. HTTP `DbRateLimiter` still fails open. A test locks that behaviour so the new breaker is not “fixed” by changing the HTTP limiter.
6. Fallback to another deployment on the same provider is recorded. Fallback that would change `MODEL_PROVIDER` throws and does not call the adapter.
7. No `log/usage.jsonl` is created.
8. Org B’s spend is invisible to org A and does not consume org A’s budget.
9. Retries: the model adapter is invoked at most once for a failed turn in this ticket. Bounded retry, if added, is a separate explicit loop with a max of 2 and a recorded attempt count. Silent SDK or adapter retries were not verified. Do not enable them here.

## Threat

Fan-out multiplies spend. Iteration caps are not a budget. A silent provider change can move case text. Fail closed on the new breaker. Keep the HTTP limiter’s current fail-open behaviour so a database blip does not take login down, and do not pretend that limiter is the budget.

## Rollout

Caps default high enough that today’s tests pass, and a fixture org uses a tiny cap. Production values are an operator setting, not a constant buried in chat. Rollback removes the pre-check and leaves the usage rows.

## Out of scope

Per-role model profiles beyond an unused `_agentKey` hook. HydraFusion or Copilot model ids. Changing Azure Monitor HTTP telemetry.
