# CW-SDK-006. Source-aware policy before model egress

- **Priority:** P0.
- **Class:** adapt. SDK `defineHooks({ scrubPii: true })` may describe the intent. It is not a substitute for the filter, and its scrubber was not executed in planning.
- **Depends on:** CW-SDK-004 for the policy object. Works with CW-SDK-003 so the run records which filter version ran.
- **Blocks:** none.

## Outcome

Chat text, history, and tool results pass an explicit policy before they are placed in `chat()` messages or tool returns that the model will see. Raw investigation evidence remains in Postgres for authorised users. Credential redaction on memory and decision writes stays, and is not treated as this control.

## Current evidence

- `handleChat` saves the raw user message, then `threadMessagesForModel` sends up to 40 raw messages to the runtime.
- `LlmAgentRuntime.run` passes those messages through.
- `traced` returns the full tool output to the model. `withoutSamples` affects only the decision log for `get_hunt`.
- `appendMemory` and `recordDecision` call `redactString`.
- No assertion that a secret has already left the process. This ticket prevents a class of egress. It does not describe an incident.

## Components

- New `apps/web/src/server/agents/egress.ts`
- `handler.ts`, `runtime.ts`, `tools.ts`, `lib/redact.ts`
- Registry hook description if CW-SDK-004’s `defineHooks` is in place
- Tests beside `apps/web/test/redact-logger.test.ts`

## Data

No new store for raw chat. Existing `chat_messages` remain the raw record under current org and user checks.

Optional column on `agent_runs`: `egress_policy_sha256`.

Tool results that are too sensitive to send are replaced, for the model only, with a short placeholder and a pointer such as `huntId` or `proposalId`. The hunt page still shows the stored evidence to an authorised user.

## API

`prepareModelMessages(messages, policy)` returns the array passed to `chat()`.

`prepareToolResult(toolName, output, policy)` returns what the tool function resolves to the model.

Policy contents, versioned in the registry:

- Provider must be the configured `MODEL_PROVIDER`. This function does not switch it.
- Secret-shaped strings are replaced before egress, using the existing `looksSecret` rules plus the SDK `FORBIDDEN` credential patterns where they add a shape Crosswire lacks. Differences are listed in the test so the two lists do not silently diverge.
- `get_hunt` result rows and `list_sentinel_incidents` payloads are not sent in full. Send counts, ids, and statuses. The analyst already has the hunt page.
- User message text is sent, because that is the question, after secret redaction. A message that is only a secret becomes a refusal and the run ends `failed` without a model call.
- History from another org cannot appear. The existing thread query is org and user scoped. Add a test that a second org’s message id is absent.

## UI and jobs

The chat error for a blocked secret is a fixed sentence. It does not echo the secret. No new page.

## Acceptance tests

1. A message containing a fake `api_key=` assignment is stored raw in `chat_messages` for that user and is absent from the adapter request.
2. A message that is only that secret does not call the adapter.
3. `get_hunt` fixture with 50 rows: the model tool result has a count and no row objects. The hunt read API still returns the rows.
4. Decision log remains truncated and redacted. Raw chat remains. The test names both.
5. Filter version hash on the run changes when the policy fixture changes.
6. Org isolation: org B’s message is not in org A’s prepared history.
7. `defineHooks` is not invoked as a shell or file guard. `EXECUTION_TOOL_NAMES` stays empty.

## Threat

The model provider is outside the database. Anything in the `chat()` payload leaves the tenant boundary under the customer’s model agreement. Minimise it. Keep the evidence the analyst needs inside Crosswire.

## Rollout

Flag `EGRESS_FILTER=on|off`, default `off` until tests pass, then `on`. Rollback sets `off`. Raw rows are untouched.

## Out of scope

Claiming a leak occurred. DLP product integration. Encrypting chat at rest beyond current database controls.
