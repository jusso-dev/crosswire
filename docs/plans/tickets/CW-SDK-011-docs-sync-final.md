# CW-SDK-011. Documentation synchronisation (final step, not now)

- **Priority:** Last. Do not start until CW-SDK-001 through CW-SDK-010 are implemented and their tests have been run.
- **Class:** adapt docs to verified code. Not an implementation ticket.
- **Status:** Pending. Implementation of the SDK work is unapproved and incomplete as of 08-11-2026. This ticket does not authorise that implementation, a deploy, a paid seat, an external ticket, or a Kelpie change.
- **Depends on:** CW-SDK-001 through CW-SDK-010, each verified in the tree.
- **Blocks:** nothing. It is the last step.

## Why it is pending

The Squad SDK is not installed. `LlmAgentRuntime` is still the only chat runtime. Memory has no quarantine or promotion columns. There is no `agent_runs` table, no token ledger, no egress filter, and no content hash on approvals. Writing the design docs now would describe the plan as if it had shipped. Justin’s instruction is to synchronise documentation only after that work is complete and verified.

No file listed below was edited for this ticket. `bash docs/design/render.sh` was not run. The existing PDF was not regenerated and was not inspected in this pass.

## What to edit, only at the final stage

Inspect the paths and the project’s doc conventions again before editing. Then update only what the verified code and tests support:

| Path | Duty |
| --- | --- |
| `design.md` | Architecture matches the code that landed. |
| `docs/design/analyst-workspace-design.html` | Unbranded design source. Keep components, data flows, deployment boundaries, and security practices already in the file. Add the verified SDK boundary. Do not add branding. Do not delete useful detail. |
| `docs/design/analyst-workspace-design.pdf` | Replace only by regenerating from the HTML. |
| `docs/design/render.sh` | Use this script. Do not hand-build the PDF another way. |
| `docs/adr/0002-squad-sdk-embed.md` | Record the pin and the import boundary that merged. Supersede the “every turn needs a Copilot seat” sentence. Keep the spike history. |
| `docs/adr/0004-chat-model-azure-openai.md` | Keep Crosswire-hosted agents and the customer model. State provider options that the code actually supports. |
| `docs/agents.md` | Roster, charter load, memory trust, runs, budgets, and egress match the code. Remove the claim that the server reads `.squad/team.md` and `.squad/routing.md` as the runtime source, if that is still false, or describe the generator if CW-SDK-004 landed. |

`README.md` is in scope only where it still says every customer needs Copilot for the product runtime. Copilot custom agents in `.github/agents/` stay optional and still need a Copilot licence for that GitHub product.

## Render, only at the final stage

From the repo root, after the HTML edit:

```sh
bash docs/design/render.sh
```

The script reads `docs/design/analyst-workspace-design.html` and writes `docs/design/analyst-workspace-design.pdf` with headless Chrome (`CHROME` overrides the binary). Then inspect the PDF text, links, and consistency with the HTML and ADRs. A screenshot of the HTML is not that check.

## Reconciliation rules

Label each item implemented, verified, planned, deferred, or unresolved:

- Exact pinned SDK version and the import boundary that tests prove.
- Provider and host options. No claim that every Crosswire run needs a Copilot seat. No claim that preview hosts are supported unless that code is present.
- Stable `1.1.0` versus preview `2.0.0-preview.3`. `HarnessAdapter` stays experimental and deferred unless a later ADR adopted it.
- Memory trust, quarantine, promotion, supersession, tombstones, and injection tests that actually pass.
- Run ids, parent linkage, model, charter, policy, and tool versions, events, and recovery.
- One enforced config source.
- Token, context, and cost budgets, and the shared concurrency breaker.
- Source-aware egress and provider rules.
- Propose-only agents, human approval, no self-approval, content-bound approvals, separate response credentials, atomic execution claims, org isolation, evidence retention, and rollback.

If a ticket was not merged, the doc says planned or unresolved. It does not say shipped.

## Acceptance, when the gate opens

1. The implementation diff for CW-SDK-001 through CW-SDK-010 is in the tree, and the named tests passed in that session.
2. Every path in the table above was re-read before edit.
3. The HTML remains unbranded and still contains the prior architecture detail.
4. `bash docs/design/render.sh` exits 0 and prints `Wrote` plus the PDF path.
5. The PDF text matches the HTML on the SDK pin, the provider boundary, and the security controls that are actually present.
6. ADR 0002 and ADR 0004 do not contradict `model.ts` or the SDK import test.
7. `docs/agents.md` does not describe team or routing markdown as a runtime source unless the code loads them.
8. The write-up lists implemented, verified, planned, deferred, and unresolved items separately.

## Out of scope

Starting this ticket during planning. Rendering now. Kelpie. Deployment. Production migration. External tickets. New threads. Changing model, effort, or defaults.
