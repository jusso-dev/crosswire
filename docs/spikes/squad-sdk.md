# Spike: `@bradygaster/squad-sdk` (issue #29)

Date: 2026-11-07. Time-boxed to package inspection; outcome recorded in ADR 0002.

## Repro

```sh
mkdir /tmp/squad-spike && cd /tmp/squad-spike
npm pack @bradygaster/squad-sdk@1.1.0 @github/copilot-sdk
tar -xzf bradygaster-squad-sdk-1.1.0.tgz
npm view @bradygaster/squad-sdk license dependencies
# license: MIT; dependencies: @github/copilot-sdk ^1.0.19, vscode-jsonrpc
grep -n "Copilot CLI" package/README.md  # copilot-sdk: "programmatic control of GitHub Copilot CLI via JSON-RPC"
```

## Findings

| Question | Answer |
| --- | --- |
| Create a squad, load charters, append history without Copilot CLI? | File-level state yes (plain markdown); agent *execution* no, it needs a Copilot CLI session. |
| Run from Node in Docker? | Node yes, but each session needs a Copilot-entitled GitHub user login. Not suitable for a shared server identity in v1. |
| Overlap with Copilot custom agents / Agentic Workflows? | Same audience and similar charter concepts. Crosswire ships both `.squad/` and `.github/agents/`. |
| Licence | MIT, compatible. |

## Follow-ups

See ADR 0002 consequences.
