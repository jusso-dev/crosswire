// Deterministic OpenAI-compatible model for chat e2e (MODEL_PROVIDER=openai-compatible,
// OPENAI_BASE_URL=http://127.0.0.1:18099/v1). Streams a fixed markdown answer with a table in
// paced chunks, and calls search_intel once when the agent is offered it. Usage: node mock-model.mjs
import http from 'node:http'

const PORT = Number(process.env.MOCK_MODEL_PORT ?? 18099)
const DELAY = Number(process.env.MOCK_MODEL_DELAY_MS ?? 60)
export const ANSWER = `Here is what I found for **Fortinet**:

1. **CVE-2026-24858**: FortiOS SSL-VPN heap overflow, *actively exploited*.
2. Two related advisories on pwn.watch in the last week.

| Source | Severity | Exploited |
| --- | --- | --- |
| pwn.watch | High | Yes |
| CISA KEV | n/a | Yes |

Next step: open a hunt and let Hunter propose a search such as \`DeviceNetworkEvents | where RemotePort == 443\`.`

http
  .createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', async () => {
      if (!req.url?.includes('chat/completions')) return res.writeHead(404).end()
      const body = JSON.parse(raw || '{}')
      const last = body.messages?.at(-1)
      const tools = (body.tools ?? []).map((t) => t.function?.name)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const send = (d) => res.write(`data: ${JSON.stringify({ id: 'm', object: 'chat.completion.chunk', created: 1, model: 'mock', choices: [{ index: 0, ...d }] })}\n\n`)
      if (tools.includes('search_intel') && last?.role !== 'tool') {
        send({ delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'search_intel', arguments: '{"query":"fortinet"}' } }] }, finish_reason: null })
        send({ delta: {}, finish_reason: 'tool_calls' })
      } else {
        // Stop early if the client goes away (Stop button). The request object is already
        // finished at this point, so watch the response's close event, not req.destroyed.
        let gone = false
        res.on('close', () => (gone = true))
        for (const w of ANSWER.match(/\S+\s*/g)) {
          if (gone) break
          send({ delta: { content: w }, finish_reason: null })
          await new Promise((r) => setTimeout(r, DELAY))
        }
        send({ delta: {}, finish_reason: 'stop' })
      }
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  .listen(PORT, '127.0.0.1', () => console.log(`mock model on ${PORT}`))
