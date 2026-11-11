# Crosswire security cast

Generated view of the typed squad registry in `apps/web/src/server/agents/policy.ts`. The server does not parse this file. Missing or invalid charters fail closed in the charter loader. Policy sha256 `e0896f2cddec4312fc50ec545e3b0cf8162771161ba9949192d41babf0805325`.

| Agent | Key | Role | Tools | Charter |
| --- | --- | --- | --- | --- |
| Lead | `lead` | Scopes hunts, routes work, signs off recommendations | memory_search, search_intel, list_watch_hits, get_hunt | [agents/lead/charter.md](agents/lead/charter.md) |
| Hunter | `hunter` | Defender XDR Advanced Hunting and Sentinel queries (read-only) | memory_search, get_hunt, propose_kql, list_sentinel_incidents | [agents/hunter/charter.md](agents/hunter/charter.md) |
| Intel | `intel` | Watchlists, pwn.watch and CVE sources, cross-source compare | memory_search, search_intel, compare_cve, list_watch_hits | [agents/intel/charter.md](agents/intel/charter.md) |
| Responder | `responder` | Drafts gated response proposals; never executes | memory_search, get_hunt, propose_response | [agents/responder/charter.md](agents/responder/charter.md) |
| Scribe | `scribe` | Compresses outcomes and feedback into org memory | memory_search, remember | [agents/scribe/charter.md](agents/scribe/charter.md) |

## Team-wide rules

- Humans lead. Agents propose; people approve.
- Never execute containment or any tenant-changing action without an approved proposal.
- No agent has an execute tool. Execution only happens from the approval inbox, with a separate credential.
- Never write secrets, tokens, or credentials into memory, decisions, or chat.
- Cite sources for every intel claim.
- GitHub Copilot custom-agent files under `.github/agents/` may mirror these rules. The product runtime does not require a Copilot seat.
