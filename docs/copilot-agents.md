# GitHub Copilot custom agents

Crosswire ships its security cast as GitHub Copilot custom agents in `.github/agents/`, so the
same charters work where Copilot already lives (issue #34). Format followed: Copilot custom agent
profiles (`.github/agents/<name>.agent.md`, Markdown with YAML front matter: `name`,
`description`, `tools`), per
[GitHub Docs: custom agents](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/create-custom-agents),
checked 2026-11-07. The format moves quickly; re-check that page when upgrading.

| Agent | File | Source charter |
| --- | --- | --- |
| Lead | `.github/agents/lead.agent.md` | `.squad/agents/lead/charter.md` |
| Hunter | `.github/agents/hunter.agent.md` | `.squad/agents/hunter/charter.md` |
| Intel | `.github/agents/intel.agent.md` | `.squad/agents/intel/charter.md` |
| Responder | `.github/agents/responder.agent.md` | `.squad/agents/responder/charter.md` |
| Scribe | `.github/agents/scribe.agent.md` | `.squad/agents/scribe/charter.md` |

## Enable them in your organisation

1. Fork or copy this repo (or just `.github/agents/` and `.squad/`) into a repository your team uses.
2. Make sure GitHub Copilot (Business or Enterprise) is enabled for the org and the repo, and that
   custom agents / Copilot coding agent are allowed by your org policy.
3. In Copilot Chat (github.com, VS Code or the Copilot CLI), pick the agent, for example
   `crosswire-hunter`, from the agent selector.
4. Copilot agents have **no** Crosswire control-plane tools. They produce proposals as text; an
   analyst pastes them into Crosswire (hunt case KQL, response proposal), where a human reviews and
   approves. No Cloudflare or other hosting is needed for this.

## Intended tools (not wired in v1)

When Crosswire exposes an MCP server, these agents will declare it under `tools`. Until then the
intended mapping is: Hunter → `propose_kql`, `get_hunt`, `list_sentinel_incidents`; Intel →
`search_intel`, `compare_cve`, `list_watch_hits`; Responder → `propose_response`; Scribe →
`remember`. None of them will ever get an execute tool.

## Safety

Every definition keeps the charter rule: never execute containment without an approved proposal.
When you change a charter, update the matching `.agent.md` (CONTRIBUTING.md).

## Agentic Workflows

GitHub Agentic Workflows are not used in v1. The routing and fan-out rules live in
`.squad/routing.md`; the control plane implements them (Lead orchestrate mode).
