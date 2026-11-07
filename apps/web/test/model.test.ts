import { afterEach, describe, expect, it, vi } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { chat } from '@tanstack/ai'
import { resetEnvForTests } from '../src/server/env'
import { azureBaseUrl, createModelAdapter, modelConfigured, modelDescription, ModelNotConfiguredError } from '../src/server/agents/model'

const saved = { ...process.env }
afterEach(() => {
  process.env = { ...saved }
  resetEnvForTests()
  vi.restoreAllMocks()
})

function setEnv(vars: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  resetEnvForTests()
}

describe('chat model configuration (ADR 0004)', () => {
  it('is off by default and refuses to build an adapter', () => {
    setEnv({ MODEL_PROVIDER: undefined })
    expect(modelConfigured()).toBe(false)
    expect(modelDescription().provider).toBe('Not configured')
    expect(() => createModelAdapter('lead')).toThrow(ModelNotConfiguredError)
  })

  it('normalises Azure endpoints to the v1 route', () => {
    expect(azureBaseUrl('https://contoso.openai.azure.com')).toBe('https://contoso.openai.azure.com/openai/v1')
    expect(azureBaseUrl('https://contoso.openai.azure.com/')).toBe('https://contoso.openai.azure.com/openai/v1')
    expect(azureBaseUrl('https://contoso.openai.azure.com/openai/v1')).toBe('https://contoso.openai.azure.com/openai/v1')
  })

  it('describes keyless Azure as Entra ID and never exposes the key', () => {
    setEnv({ MODEL_PROVIDER: 'azure', AZURE_OPENAI_ENDPOINT: 'https://contoso.openai.azure.com', AZURE_OPENAI_DEPLOYMENT: 'gpt-chat', AZURE_OPENAI_API_KEY: undefined })
    expect(modelConfigured()).toBe(true)
    expect(modelDescription()).toEqual({ provider: 'Azure OpenAI', model: 'gpt-chat', auth: 'Entra ID' })
    setEnv({ AZURE_OPENAI_API_KEY: 'secret-key-value' })
    expect(JSON.stringify(modelDescription())).not.toContain('secret-key-value')
  })

  it('calls Azure OpenAI with an Entra bearer token (no api-key) and the deployment name', async () => {
    const seen: Array<{ url: string; auth?: string; apiKey?: string; model?: string }> = []
    const server = http.createServer((req, res) => {
      let raw = ''
      req.on('data', (c) => (raw += c))
      req.on('end', () => {
        seen.push({ url: req.url ?? '', auth: req.headers.authorization, apiKey: req.headers['api-key'] as string | undefined, model: JSON.parse(raw || '{}').model })
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        const ev = (o: Record<string, unknown>) => res.write(`event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`)
        ev({ type: 'response.created', response: { id: 'r1', model: 'gpt-chat', status: 'in_progress', output: [] } })
        ev({ type: 'response.output_text.delta', item_id: 'm1', output_index: 0, content_index: 0, delta: 'hello' })
        ev({ type: 'response.completed', response: { id: 'r1', model: 'gpt-chat', status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } })
        res.end()
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as AddressInfo).port
    try {
      setEnv({ MODEL_PROVIDER: 'azure', AZURE_OPENAI_ENDPOINT: `http://127.0.0.1:${port}`, AZURE_OPENAI_DEPLOYMENT: 'gpt-chat', AZURE_OPENAI_API_KEY: undefined })
      // Stand in for DefaultAzureCredential: the managed identity in Azure, `az login` locally.
      const identity = await import('@azure/identity')
      vi.spyOn(identity.DefaultAzureCredential.prototype, 'getToken').mockResolvedValue({ token: 'entra-token-123', expiresOnTimestamp: Date.now() + 3_600_000 })
      const text = await chat({ adapter: createModelAdapter('lead'), messages: [{ role: 'user', content: 'hi' }], threadId: 't-model-test', stream: false })
      expect(String(typeof text === 'string' ? text : (text as { text?: string }).text)).toContain('hello')
      expect(seen[0]!.url).toMatch(/^\/openai\/v1\/responses/)
      expect(seen[0]!.auth).toBe('Bearer entra-token-123')
      expect(seen[0]!.apiKey).toBeUndefined()
      expect(seen[0]!.model).toBe('gpt-chat')
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })
})
