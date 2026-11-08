# CW-SDK-009. Content-bound response approvals

- **Priority:** P1. Hardening. No approval bypass was demonstrated.
- **Class:** adapt the existing proposal row. Skip the preview durable broker.
- **Depends on:** none in the SDK set. Re-read `proposals.ts` and `rbac.ts` at implementation time.
- **Blocks:** none.

## Outcome

An approval binds a hash of the executable payload and a schema version. A changed payload, an expired proposal, or a restarted worker cannot execute a stale approval. Existing self-approval denial, separate response identity, and the atomic execution claim stay.

## Current evidence

- `rbac.ts` denies self-approval unless `RESPONSE_ALLOW_SELF_APPROVAL=true`.
- `proposals.ts` sets `expiresAt` from `RESPONSE_PROPOSAL_TTL_HOURS`, refuses execution after expiry, and claims with an update where `status` is `approved` and `execution` is null.
- Payload is redacted on write. There is no content hash.
- Rollback of an executed proposal already exists (`rollback` path around the `executed` / `failed` check).

## Components

- `apps/web/src/server/response/proposals.ts`
- `apps/web/src/server/response/rbac.ts` (keep behaviour, add tests if missing)
- `schema` for `response_proposals`: `payload_sha256`, `payload_schema_version`
- `apps/web/test/response.test.ts`

## Data

Hash is SHA-256 of the canonical JSON of the payload that will be executed, computed with the redacted stored payload so the executor and the approver see the same bytes. Schema version is an integer constant in code. Bump it when the payload shape changes. Old rows without a hash cannot execute once the flag is on. They can still be rejected.

## API, UI, jobs

`decideProposal` stores the hash it approved. `execute` recomputes the hash and refuses on mismatch. UI shows the hash prefix on the approval detail page that already exists (`app.approvals.$id`). The approver does not type the hash.

Restart: a proposal left `execution.status=in_progress` past the TTL cannot be claimed again. The existing conditional claim stays. Add a test that a second execute returns the “already started” error.

## Acceptance tests

1. Approve then mutate the stored payload: execute throws, status stays unexecuted.
2. Approve, wait past expiry (clock injected): execute throws.
3. Two concurrent executes: one claims, the other gets the already-started error.
4. Requestor cannot approve when self-approval is off.
5. Response path still uses the separate response credential configuration already documented in `docs/response.md`. The test asserts the executor is not the chat model adapter.
6. Restart fixture: `in_progress` row is not double-executed.
7. Org B cannot execute org A’s proposal.

## Threat

Binding stops a payload swap after approval. It does not expand who may execute. Dry-run remains the default.

## Rollout

Flag `APPROVAL_BINDING=on|off`. `off` preserves current execute for rows written before the column existed. `on` refuses rows with a null hash. Backfill is not automatic. Operators re-propose. Rollback sets the flag off.

## Out of scope

`HarnessAdapter` approval negotiation. Changing dry-run defaults. Live containment.
