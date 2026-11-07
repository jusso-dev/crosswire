# Changelog

All notable changes to Crosswire are documented here. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [Semantic Versioning](https://semver.org/) — see [docs/releasing.md](docs/releasing.md).

## [Unreleased]

## [0.2.0] - 2026-11-07

### Added

- Response connector (#88): a separate per-org Entra app for response, with its own token broker, `env:CROSSWIRE_RESP_<ORG>_*` secret refs and an owner-managed Sentinel playbook allowlist.
- Live Sentinel playbook (`runPlaybook`, api-version 2025-09-01) and Defender `isolate` / `unisolate` executors (#89) behind a response HTTP allowlist, Defender machine-id validation and `RESPONSE_MAX_LIVE_TARGETS`. Per-call execution results.
- Rollback as a gated proposal (#90): unisolate exactly the devices that were isolated; manual rollback proposals for playbook / Logic App runs.
- Teams and Slack webhook notifications (#91) for watch hits, pending approvals, executions and scheduled hunts.
- Scheduled hunts from human-approved KQL (#92), with 30-day approval expiry and atomic worker claims.
- Lead `delegate_parallel` tool (#93): up to 4 specialists concurrently.
- Markdown hunt report export (#94).
- Migration `0003_v2_response_notify_schedules`.

### Changed

- Dry runs report blockers (`status: blocked`) when a proposal could not execute; `execute` refuses such proposals before claiming them, so they stay approved.
- The Sentinel and Defender executors are no longer stubs. With `RESPONSE_DRY_RUN=false` and `RESPONSE_EXECUTOR_SENTINEL|GRAPH=on` they make real calls: review docs/response.md before enabling.
- Partly failed executions are recorded as `failed` with `execution.status = "partial"`.

## [0.1.0] - 2026-11-07

### Added

- Phase 0: pnpm monorepo, TanStack Start app, env validation, Docker Compose, GitHub Actions CI, community files, ADRs 0001–0004.
- Phase 1: Better Auth with `tanstackStartCookies`, local email/password, Entra ID OIDC with tenant-to-org mapping, session guards, org model, auth audit log.
- Phase 2: app shell, dashboard, TanStack AI chat over SSE, persisted threads, agent selector, approval inbox.
- Phase 3: security cast charters, in-process agent runtime (stub or BYO model), DB memory with compaction, decision log, Copilot custom agents.
- Phase 4: pwn.watch and CISA KEV ingest, watchlists, matcher, daily digest, TI compare.
- Phase 5: Defender XDR and Sentinel hunting with token broker, allowlisted read-only client and human-reviewed KQL.
- Phase 6: gated response proposals, approver RBAC, feature-flagged executors, dry run, audit and rollback notes.
- Phase 7: production Dockerfile, prod Compose, Azure Container Apps Bicep, manual-approval deploy, runbooks, probes, request logging.
- Phase 8: migration job, fail-closed response flags, bootstrap, demo fixtures, first-run checklist, security headers/CORS/rate limits, Application Insights and alerts, SBOM and CVE gate, smoke tests, release process, staging pattern, go-live checklist, Day-1 playbook, golden-path E2E.
- Later: optional SAML SSO and Cloudflare Radar enrichment (both off by default); commercial and MSSP notes.

[Unreleased]: https://github.com/jusso-dev/crosswire/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/jusso-dev/crosswire/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/jusso-dev/crosswire/releases/tag/v0.1.0
