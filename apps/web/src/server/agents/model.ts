import { DefaultAzureCredential, getBearerTokenProvider } from '@azure/identity'
import { createAzureOpenaiText } from '@tanstack/ai-openai'
import { openaiCompatibleText } from '@tanstack/ai-openai/compatible'
import type { AgentKey } from '../../shared/agents'
import { env, type Env } from '../env'

/**
 * Model access for Crosswire's agents (ADR 0004). Crosswire hosts the agents (charters, tools,
 * memory, approvals); the model only answers.
 *
 * - `azure` (default target): Azure OpenAI in the customer's subscription. Signs in with Entra
 *   (managed identity in Azure, `az login` locally) via DefaultAzureCredential, or an API key.
 * - `openai-compatible`: any OpenAI-compatible endpoint (OpenAI, a gateway, a local server).
 * - `off`: chat shows a setup message.
 */

export class ModelNotConfiguredError extends Error {
  constructor() {
    super('Chat is not configured. Set MODEL_PROVIDER=azure with AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_DEPLOYMENT (see docs/chat-model.md).')
  }
}

export function modelConfigured(e: Env = env()) {
  if (e.MODEL_PROVIDER === 'azure') return Boolean(e.AZURE_OPENAI_ENDPOINT && e.AZURE_OPENAI_DEPLOYMENT)
  if (e.MODEL_PROVIDER === 'openai-compatible') return Boolean(e.OPENAI_BASE_URL && e.OPENAI_MODEL && e.OPENAI_API_KEY)
  return false
}

/** Non-secret description for the UI and logs. */
export function modelDescription(e: Env = env()) {
  if (e.MODEL_PROVIDER === 'azure') return { provider: 'Azure OpenAI', model: e.AZURE_OPENAI_DEPLOYMENT ?? null, auth: e.AZURE_OPENAI_API_KEY ? 'API key' : 'Entra ID' }
  if (e.MODEL_PROVIDER === 'openai-compatible') return { provider: 'OpenAI-compatible', model: e.OPENAI_MODEL ?? null, auth: 'API key' }
  return { provider: 'Not configured', model: null, auth: null }
}

const COGNITIVE_SCOPE = 'https://cognitiveservices.azure.com/.default'
let tokenProvider: (() => Promise<string>) | undefined

/** Entra token provider for Azure OpenAI. Uses the managed identity in Azure (AZURE_CLIENT_ID picks a user-assigned one). */
function entraTokenProvider() {
  tokenProvider ??= getBearerTokenProvider(new DefaultAzureCredential({ managedIdentityClientId: env().AZURE_CLIENT_ID || undefined }), COGNITIVE_SCOPE)
  return tokenProvider
}

/** Azure resource host → the v1 OpenAI-compatible route the adapter expects. */
export function azureBaseUrl(endpoint: string) {
  const host = endpoint.trim().replace(/\/+$/, '').replace(/\/openai(\/v1)?$/, '')
  return `${host}/openai/v1`
}

export function createModelAdapter(_agentKey: AgentKey) {
  const e = env()
  if (!modelConfigured(e)) throw new ModelNotConfiguredError()
  if (e.MODEL_PROVIDER === 'azure') {
    const config = {
      baseURL: azureBaseUrl(e.AZURE_OPENAI_ENDPOINT!),
      deploymentName: e.AZURE_OPENAI_DEPLOYMENT!,
      ...(e.AZURE_OPENAI_API_VERSION ? { apiVersion: e.AZURE_OPENAI_API_VERSION } : {}),
    }
    if (e.AZURE_OPENAI_API_KEY) return createAzureOpenaiText(e.AZURE_OPENAI_DEPLOYMENT!, e.AZURE_OPENAI_API_KEY, config)
    // Keyless: the adapter forwards client options to the Azure client, which calls the provider per request.
    return createAzureOpenaiText(e.AZURE_OPENAI_DEPLOYMENT!, '', { ...config, azureADTokenProvider: entraTokenProvider() } as Parameters<typeof createAzureOpenaiText>[2])
  }
  return openaiCompatibleText(e.OPENAI_MODEL!, { baseURL: e.OPENAI_BASE_URL!, apiKey: e.OPENAI_API_KEY!, api: e.OPENAI_API === 'responses' ? 'responses' : 'chat-completions' })
}
