# Chat model: Azure OpenAI

Crosswire hosts its agents (Lead, Hunter, Intel, Responder, Scribe): charters, tools, org memory,
the decision log and approvals all live in Crosswire ([ADR 0004](adr/0004-chat-model-azure-openai.md)).
The model only answers. Replies stream token by token to the chat.

Recommended: **Azure OpenAI in your own subscription, signed in with Entra ID**. No API key is
stored anywhere, prompts stay inside your Azure boundary under your Azure OpenAI terms, and no
GitHub account is needed.

## 1. Create the model deployment

1. Azure portal → create an **Azure OpenAI** resource (or an Azure AI Foundry resource) in your region.
2. Deploy a chat model that supports tool calling, for example `gpt-4.1`. Note the **deployment name**.
3. Note the resource **endpoint**, for example `https://contoso-ai.openai.azure.com`.

## 2. Let Crosswire sign in (keyless)

Grant the Crosswire managed identity the **Cognitive Services OpenAI User** role on that resource.
The Bicep does this for you when the resource is in the same resource group:

```sh
az deployment group create -g <rg> -f infra/azure/main.bicep -p infra/azure/main.bicepparam \
  -p ... azureOpenAiEndpoint=https://contoso-ai.openai.azure.com \
        azureOpenAiDeployment=gpt-4.1 azureOpenAiResourceName=contoso-ai
```

If the resource lives elsewhere, leave `azureOpenAiResourceName` empty and assign the role yourself:

```sh
az role assignment create --assignee <identityClientId output> \
  --role "Cognitive Services OpenAI User" --scope <Azure OpenAI resource id>
```

Role assignments can take a few minutes to apply. Until then chat shows a 401 or 403 error.

## Environment variables

| Variable | Value |
| --- | --- |
| `MODEL_PROVIDER` | `azure` (Bicep sets this when an endpoint is given; `off` disables chat) |
| `AZURE_OPENAI_ENDPOINT` | Resource endpoint (host only) |
| `AZURE_OPENAI_DEPLOYMENT` | Chat deployment name |
| `AZURE_CLIENT_ID` | User-assigned identity client ID (Bicep sets it) |
| `AZURE_OPENAI_API_KEY` | Optional. Only if you cannot use Entra ID; store it in Key Vault |
| `AZURE_OPENAI_API_VERSION` | Optional. The v1 API needs none |

### Local development

- Keyless: `az login` with an account that has the role, set `MODEL_PROVIDER=azure` and the two
  `AZURE_OPENAI_*` values. `DefaultAzureCredential` picks up your Azure CLI login.
- Or any OpenAI-compatible endpoint (OpenAI, a gateway, a local server):
  `MODEL_PROVIDER=openai-compatible`, `OPENAI_BASE_URL`, `OPENAI_MODEL`, `OPENAI_API_KEY`.

## Safety

- Each agent is offered only its own Crosswire tools (`AGENT_TOOLS`). No tool executes KQL or a
  response action (`EXECUTION_TOOL_NAMES` stays empty; tested). Agents propose; people approve.
- Every turn and tool call writes a decision-log row. `AGENT_TIMEOUT_MS` stops a turn that hangs.
- Model credentials never reach the browser. The UI only sees the provider and deployment name.

## Troubleshooting

| You see | Fix |
| --- | --- |
| "Chat is not set up" | Set `MODEL_PROVIDER=azure`, `AZURE_OPENAI_ENDPOINT` and `AZURE_OPENAI_DEPLOYMENT`. |
| 401 or 403 from the model | Assign Cognitive Services OpenAI User to the app identity and wait a few minutes. |
| 404 from the model | Check the deployment name and that the endpoint is the resource host. |
| Replies stop after 90 s | Raise `AGENT_TIMEOUT_MS`, or use a faster deployment. |
