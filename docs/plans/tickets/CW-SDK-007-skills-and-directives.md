# CW-SDK-007. Reviewed SOC skills and org directives

- **Priority:** P1.
- **Class:** adopt `defineSkill` for shape. Adapt contents to SOC runbooks. Directives are a new reviewed record, not `agent_decisions`.
- **Depends on:** CW-SDK-002, CW-SDK-004.
- **Blocks:** CW-SDK-008.

## Outcome

A skill is a versioned runbook with an evidence requirement and an allowlist of existing tool names. It enters a prompt only when approved and only for agents that already have those tools. Org directives are approved text loaded for every agent, separate from the activity log.

## Current evidence

- No `SKILL.md` registry and no `defineSkill` call.
- `systemPromptFor` loads one agent’s memory, not a shared directive table.
- `agent_decisions` is an activity ledger (`decisions.ts`).
- `memory_search` can see other agents’ rows and is a tool the model may skip.

## Components

- `registry.ts` skills array
- Schema: `org_directives`, `agent_skills` (or files under `.squad/skills/` that are generated and hashed, plus Postgres approval state)
- `runtime.ts` prompt assembly
- Agents UI list, read-only, beside the memory panel

## Data

Skill: `name`, `description`, `body`, `content_sha256`, `evidence_required` (text), `allowed_tools` (subset of that agent’s tools), `confidence` (whatever union `defineSkill` accepts in 1.1.0; read the type at implementation and test it), `status` `draft|approved`, `approved_by`.

Directive: `org_id`, `body`, `content_sha256`, `status`, `supersedes_id`, `tombstoned_at`, `approved_by`.

Postgres holds approval. A markdown export is a view.

## API, UI, jobs

- Startup `defineSkill` on each approved skill. Unknown tool name fails startup the same way as CW-SDK-004.
- Prompt includes approved directives and the skills selected for that agent. Drafts are excluded.
- Creating a directive does not approve it. Approver is not the author (same rule as memory promotion).
- No marketplace install. No scanner-as-sandbox.

## Acceptance tests

1. `defineSkill` throws on an empty name.
2. A skill that names a tool outside `AGENT_TOOLS[agent]` fails the registry check.
3. Draft skill text is absent from `systemPromptFor`.
4. Approved directive appears for hunter and for scribe in the same org.
5. A directive from org A is absent for org B.
6. Superseded directive is absent. The new body is present.
7. `searchDecisions` results are not concatenated into the system prompt by `systemPromptFor`.

## Threat

A skill is prompt text. Unapproved or tampered bodies must not load. Hash check at prompt build: file bytes must match `content_sha256` or the run fails closed.

## Rollout

Empty approved set means prompts gain nothing. Rollback ignores the tables. No migration of old decisions into directives.

## Out of scope

Plugin marketplace. Confidence that auto-promotes. Loading `.copilot/skills/` from disk as authority.
