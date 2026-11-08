# CW-SDK-008. Incident review, shift handover, approved lessons

- **Priority:** P1.
- **Class:** adapt. Skip software sprint ceremonies and `defineCeremony` schedules that post to GitHub.
- **Depends on:** CW-SDK-007 so a lesson can become a draft directive or skill, not a live prompt.
- **Blocks:** none.

## Outcome

An analyst can record an incident review, a shift handover, and a proposed lesson. A lesson changes future prompts only after the CW-SDK-007 approval path.

## Current evidence

No `ceremonies.md` and no post-incident workflow in the agent server. Audit classification stands. Re-read `docs/day-1-operator-playbook.md` during implementation so the fields match operator language already in the repo.

## Components

- Schema: `soc_reviews` with `kind` `incident|handover|lesson`
- Server functions next to `fns/agents.ts` or a small `fns/reviews.ts`
- A section on the existing agents or hunt page. Do not add a new product area if the hunt page can hold an incident review for that hunt.

## Data

`org_id`, `kind`, `case_id` nullable, `body`, `author_id`, `created_at`, `lesson_directive_id` nullable. A lesson insert creates a draft directive. It does not set `trust=approved`.

## API, UI, jobs

Create, list, and read inside the org. No automatic “retrospective agent” turn. No model call is required to save the record.

## Acceptance tests

1. Incident review and handover are stored and listed for the org.
2. A lesson creates a draft directive whose body is absent from `systemPromptFor`.
3. After a different user approves that draft, the body appears.
4. Org isolation holds.
5. The author of the lesson cannot approve it.

## Threat

Handover text is untrusted until approved. Treat the body like feedback memory.

## Rollout

New tables only. Rollback stops reading them. Old prompts unchanged until approval.

## Out of scope

Sprint rituals. Automatic scheduling. Posting the review to Teams beyond the existing notification tools.
