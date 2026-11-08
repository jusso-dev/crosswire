# CW-SDK-001. Pin Squad SDK 1.1.0 and prove runtime use

- **Priority:** P0. First.
- **Class:** adopt
- **Status:** Local draft. Not a GitHub issue. Not authorised to implement by the 08-11-2026 planning handoff.
- **Depends on:** nothing in this set.
- **Blocks:** CW-SDK-002, 003, 004, 005, 006, 007, 010.

## Outcome

`apps/web` depends on `@bradygaster/squad-sdk` at exactly `1.1.0`. A test calls builders, `LocalMemoryStore`, and `CostTracker` and fails if those calls are mocked. The SOC chat graph does not import the Copilot client.

## Components

- `apps/web/package.json`, `pnpm-lock.yaml`
- New `apps/web/src/server/agents/squad-sdk.ts`: the only module allowed to import the adopted subpaths
- `apps/web/test/squad-sdk-runtime.test.ts`
- No change to `runtime.ts` behaviour in this ticket beyond a comment pointing at the boundary module, if a comment is needed for the import test. Prefer the test reading the module graph.

## API

Imports, all at 1.1.0:

- `@bradygaster/squad-sdk/builders`: `defineSquad`, `defineAgent`, `defineRouting`, `defineSkill`, `defineBudget`, `BuilderValidationError`
- `@bradygaster/squad-sdk/memory`: `LocalMemoryStore`
- `@bradygaster/squad-sdk/storage`: `InMemoryStorageProvider` only. Do not construct `FSStorageProvider` or `SQLiteStorageProvider`. The storage barrel loads their modules. `sql.js` stays unloaded unless something calls SQLite `init()`.
- `@bradygaster/squad-sdk/runtime/cost-tracker`: `CostTracker`

Forbidden in the SOC graph (`runtime.ts`, `model.ts`, `tools.ts`, `memory.ts`, `handler.ts`, and their transitive imports, except a future ADR):

- `@bradygaster/squad-sdk/client`
- `@bradygaster/squad-sdk/backend`
- `@github/copilot-sdk`
- `@bradygaster/squad-sdk` root barrel, so a later barrel change cannot pull the client in unnoticed

## Data, UI, jobs

None. No schema. No UI. No worker.

## Acceptance tests

The eight checks in section 6 of `docs/plans/2026-11-08-squad-sdk-adoption.md`. Also:

- `node -e` or the test prints `LocalMemoryStore` and `CostTracker` as functions from the installed package, not from a local reimplementation.
- Lockfile version is `1.1.0`, not `2.0.0-preview.3`.
- `pnpm test` for this file passes on Node matching `engines` (`>=24 <27`).

## Threat

A floating tag or a preview import would execute experimental harness code or a different memory classifier. The exact pin and the forbidden-import test are the control.

## Rollout

Dependency and tests only. Chat behaviour stays. Rollback is reverting the commit. Safe because no feature flag depends on the package yet.

## Out of scope

Calling the model through `SquadClient`. Installing the CLI globally. Preview `HarnessAdapter`.
