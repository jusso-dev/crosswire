# 0004. Chat agents hosted by Crosswire, model on Azure OpenAI

- **Status:** Accepted
- **Date:** 2026-11-07
- **Refines:** [ADR 0002](0002-squad-sdk-embed.md). Charters, tools, memory and Copilot custom agents are unchanged.

## Context

Chat needed a production model path and ChatGPT-style streaming. The first target customer runs
Microsoft 365 E5 and does not use GitHub. Three options were weighed:

1. **Crosswire hosts the agents; Azure OpenAI is the model.**
2. GitHub Copilot SDK runtime in front of a model. A prototype worked, including with a customer
   model and no GitHub account, but it adds a bundled GitHub runtime, experimental options and a
   session per turn, for no benefit to a customer without GitHub.
3. Azure AI Foundry persistent agents. Agents and threads would live in the customer's Azure.
   Charters and tools would be defined twice, history and memory would split across two systems,
   and every customer would need Azure.

## Decision

Option 1. Crosswire keeps the parts that carry its safety rules (org isolation, per-agent tool
allowlists, propose-only tools, decision log, org memory) and runs the tool loop with TanStack AI
`chat()`. The model is Azure OpenAI via the TanStack Azure adapter, signed in with **Entra ID**
(`DefaultAzureCredential`: the container's user-assigned managed identity in Azure, `az login`
locally), so no model key is stored. An API key is supported only as a fallback. Any
OpenAI-compatible endpoint also works, for development and non-Azure customers.

The Copilot SDK prototype and the earlier no-key stub model are removed. With no model configured,
chat shows a setup message.

## Consequences

- Chat needs a model deployment. Tests run the real runtime against a local mock endpoint.
- The app identity needs the Cognitive Services OpenAI User role on the Azure OpenAI resource.
- Foundry persistent agents or a Teams bot can be added later behind the same `AgentRuntime`
  interface without changing the chat UI.

## SDK boundary (2026-11-08)

This decision stands. SOC turns were not moved onto `SquadClient` or a Copilot session.

`@bradygaster/squad-sdk@1.1.0` is installed and called for the typed cast (`defineAgent`, `defineRouting`, `defineSkill`, `defineSquad`), memory `classify()` / `write()`, `CostTracker`, and the unexported `UsageLedger` and `ContextUtilizationTracker`. Those calls do not choose the chat provider. `model.ts` still has Azure and OpenAI-compatible only. Provider fallback does not switch vendor and does not select Copilot.

TanStack AI 1.2.0 `chat()` has no dedicated output-cap field. The runtime passes `modelOptions.max_tokens` (accepted by `tsc` as `{ max_tokens: number }` when `stream` is a literal) and also stops the stream after `BUDGET_MAX_OUTPUT_TOKENS * 4` characters.

Preview `2.0.0-preview.3` and `HarnessAdapter` are deferred. The 1.1.0 package has no `./backend` export. A Copilot seat is not required for the adopted calls. The earlier prototype that completed with a customer model and no GitHub account was not re-run in this change.
