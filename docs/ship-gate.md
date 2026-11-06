# v1 ship gate: first successful use (#84)

Crosswire v1 is **shipped** only when all of the following evidence exists. A code merge alone does
not satisfy this gate.

| Evidence | Where | Status |
| --- | --- | --- |
| Golden-path E2E green on fixtures (`pnpm test:e2e`) | `e2e/tests/golden-path.spec.ts`; run log attached to #84 | ✅ passed locally 2026-11-07 against a production build + Postgres 17 |
| Golden path walked on the **Azure** deploy (live lab or recorded lab): SSO → watch hit → hunt proposal → dry-run approval | Notes / recording linked on #84 | ⬜ pending: requires an Azure subscription and Entra tenant |
| Go-live checklist completed for that environment | Copy of [go-live-checklist.md](go-live-checklist.md) attached to #84 | ⬜ pending |
| Smoke test green on that environment | Actions → Smoke (or Deploy) run URL | ⬜ pending |
| Dry-run ON and executors OFF on that environment | Dashboard screenshot | ⬜ pending |

No live executor run is required for v1 (dry run is enough). Epic #1's definition of done now
includes Phase 8.

## Manual live-tenant golden path (optional nightly / pre-release)

Run [the Day-1 playbook](day-1-operator-playbook.md) against the lab tenant with Entra SSO and a
read-only hunting app. Record the run (screen recording stored outside the repo, no secrets visible).
