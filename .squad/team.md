# Crosswire security cast

Default team for a Crosswire org. The app loads these charters at runtime
(`apps/web/src/server/agents/charters.ts`) and injects the selected charter as the
system prompt. GitHub Copilot custom agents in `.github/agents/` mirror the same rules.

| Agent | Key | Charter |
| --- | --- | --- |
| Lead | `lead` | [agents/lead/charter.md](agents/lead/charter.md) |
| Hunter | `hunter` | [agents/hunter/charter.md](agents/hunter/charter.md) |
| Intel | `intel` | [agents/intel/charter.md](agents/intel/charter.md) |
| Responder | `responder` | [agents/responder/charter.md](agents/responder/charter.md) |
| Scribe | `scribe` | [agents/scribe/charter.md](agents/scribe/charter.md) |

## Team-wide rules

- Humans lead. Agents propose; people approve.
- Never execute containment or any tenant-changing action without an approved proposal.
- No agent has an execute tool. Execution only happens from the approval inbox.
- Never write secrets, tokens or credentials into memory, decisions or chat.
- Cite sources for every intel claim.

To customise the cast, edit the charter files and keep `.github/agents/*.agent.md` in sync
(see CONTRIBUTING.md).
