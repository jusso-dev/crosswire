# CW-SDK-010. Versioned export and startup diagnostics

- **Priority:** P1.
- **Class:** adapt export. Adapt a Crosswire health report. Skip Squad CLI compatibility and `squad rc`.
- **Depends on:** CW-SDK-002, CW-SDK-003, CW-SDK-004 so the bundle has a schema worth freezing.
- **Blocks:** CW-SDK-011. Documentation edits are not part of this ticket.

## Outcome

An org admin can export and import a versioned bundle that round-trips provenance, decisions, safety records, and directives, with dedup. Startup prints a config report. Design docs, ADRs, `docs/agents.md`, and the analyst-workspace PDF stay unchanged here. CW-SDK-011 updates them after this ticket and CW-SDK-001 through CW-SDK-009 are implemented and verified.

## Current evidence

- `exportHistoryMarkdown` / `importHistoryMarkdown` in `memory.ts` copy bullets. Import calls `appendMemory` and drops trust. It is not a lossless snapshot.
- `fns/agents.ts` `fetchMemory` returns that markdown.
- `/healthz` and `/readyz` exist. Readiness checks the database and migrations (confirm the ready handler during implementation).
- `docs/agents.md` says the server reads `.squad/team.md` and `.squad/routing.md` at startup. `charters.ts` reads charter files only.
- `README.md` opens with “customers who already use GitHub Copilot agents”.
- ADR 0002 says every agent turn requires a Copilot-entitled GitHub identity. ADR 0004 records the customer-model prototype and the decision to keep TanStack plus Azure OpenAI.
- `docs/copilot-agents.md` correctly limits Copilot to `.github/agents/` and a Copilot licence for that product.

## Components

- `memory.ts` export/import, or a new `apps/web/src/server/agents/bundle.ts`
- `fns/agents.ts`
- `apps/web/src/server/cli/` diagnostic script next to `model-check.ts`
- `readyz.ts` includes registry failure from CW-SDK-004

Do not edit `design.md`, `docs/design/analyst-workspace-design.html`, `docs/design/analyst-workspace-design.pdf`, `docs/adr/0002-squad-sdk-embed.md`, `docs/adr/0004-chat-model-azure-openai.md`, or `docs/agents.md` in this ticket. Do not run `docs/design/render.sh`.

## Data

Bundle schema version `1` JSON:

- `exportedAt`, `sourceOrgId` (informational), `sdkVersion` `1.1.0`
- agents, charter hashes, routing hash, skills, directives, memory entries with trust, visibility, source, hashes, tombstones
- decision activity summaries (already redacted)
- safety entries included in full when they are approved or `kind=safety`

Import:

- Requires an explicit target `orgId` the caller administers
- Dedups on `content_sha256` plus kind plus agent key
- Imported memory is `trust=quarantine` unless the entry was `kind=safety` or an approved directive and the hash matches. Re-approval is required for `POLICY` class even if the file says approved, so a tampered export cannot self-approve. Safety entries from the export are inserted as safety only when the hash matches and the importer is an admin. State this rule in the test. Do not auto-trust a file that merely labels itself approved.
- Raw hunt result rows are not in the bundle.

## API, UI, jobs

Server function `exportAgentBundle` and `importAgentBundle`, admin only. The agents page gains download and upload if the current page already has export. The CLI `agents:check` prints SDK version, provider name, charter hashes, flag values, and registry errors. It prints no secrets and no memory bodies.

## Acceptance tests

1. Export then import into a second org in the test database. Safety body survives. Quarantine stays quarantine.
2. A second import does not duplicate the same hash.
3. An export edited to set `trust=approved` without a valid approval signature is imported as quarantine. This draft does not invent a signature scheme beyond the admin re-approval rule above. If the implementation adds HMAC, test the wrong key.
4. Decision summaries round-trip at their stored length, not expanded.
5. Diagnostic output contains the pinned version and zero charter bodies.
6. The diff for this ticket does not touch `design.md`, `docs/design/**`, `docs/adr/**`, or `docs/agents.md`. Those paths belong to CW-SDK-011.

## Threat

Exports are a data-leaving path. Admin only, no secrets, no raw hunt samples, quarantine on import. Diagnostics must not print memory or webhook URLs.

## Rollout

Export stays admin-only and off the default nav until tests pass. Rollback removes the server functions. Do not ship documentation claims for this ticket. CW-SDK-011 is the documentation step, and only after verification.

## Out of scope

`squad export` CLI compatibility. Git snapshot round-trip. Cross-org mesh. Phone tunnels.
