import http from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * A tiny OpenAI-compatible chat-completions endpoint for tests. The real agent runtime (TanStack
 * AI chat loop + OpenAI-compatible adapter) talks to it, so chat tests exercise actual streaming
 * and tool calls over HTTP with no network.
 *
 * `reply(req)` decides each turn: return text to stream, or a tool call to make.
 */
export type MockRequest = { system: string; lastUser: string; lastRole: string; toolResult?: string; tools: string[]; userMessages: string[] }
export type MockReply = { text: string } | { toolCall: { name: string; args: Record<string, unknown> } } | { status: number; body: string }

export async function startMockModel(reply: (req: MockRequest) => MockReply | Promise<MockReply>) {
  const calls: MockRequest[] = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', async () => {
      if (!req.url?.includes('chat/completions')) {
        res.writeHead(404).end()
        return
      }
      const body = JSON.parse(raw || '{}') as { messages?: Array<{ role: string; content?: unknown }>; tools?: Array<{ function?: { name?: string } }> }
      const msgs = body.messages ?? []
      const text = (c: unknown) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p: { text?: string }) => p.text ?? '').join('') : '')
      const last = msgs.at(-1)
      const mreq: MockRequest = {
        system: msgs.filter((m) => m.role === 'system').map((m) => text(m.content)).join('\n'),
        lastUser: text([...msgs].reverse().find((m) => m.role === 'user')?.content),
        lastRole: last?.role ?? '',
        toolResult: last?.role === 'tool' ? text(last.content) : undefined,
        tools: (body.tools ?? []).map((t) => t.function?.name ?? ''),
        userMessages: msgs.filter((m) => m.role === 'user').map((m) => text(m.content)),
      }
      calls.push(mreq)
      const r = await reply(mreq)
      if ('status' in r) {
        res.writeHead(r.status, { 'content-type': 'application/json' }).end(r.body)
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const chunk = (d: Record<string, unknown>) => res.write(`data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', created: 1, model: 'mock', choices: [{ index: 0, ...d }] })}\n\n`)
      if ('toolCall' in r) {
        chunk({ delta: { role: 'assistant', tool_calls: [{ index: 0, id: `call_${calls.length}`, type: 'function', function: { name: r.toolCall.name, arguments: JSON.stringify(r.toolCall.args) } }] }, finish_reason: null })
        chunk({ delta: {}, finish_reason: 'tool_calls' })
      } else {
        // Stream in several deltas so tests can see real incremental streaming.
        for (const piece of r.text.match(/.{1,12}/gs) ?? ['']) chunk({ delta: { content: piece }, finish_reason: null })
        chunk({ delta: {}, finish_reason: 'stop' })
      }
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    calls,
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}

/** Env for pointing the agent runtime at the mock. */
export function mockEnv(baseUrl: string): Record<string, string> {
  return { MODEL_PROVIDER: 'openai-compatible', OPENAI_BASE_URL: baseUrl, OPENAI_API_KEY: 'test-key', OPENAI_MODEL: 'mock-model' }
}
