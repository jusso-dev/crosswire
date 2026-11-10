// Deterministic OpenAI-compatible model for chat e2e (MODEL_PROVIDER=openai-compatible,
// OPENAI_BASE_URL=http://127.0.0.1:18099/v1). Streams a fixed markdown answer with a table in
// paced chunks, and calls search_intel once when the agent is offered it. Usage: node mock-model.mjs
import http from 'node:http'

const PORT = Number(process.env.MOCK_MODEL_PORT ?? 18099)
const DELAY = Number(process.env.MOCK_MODEL_DELAY_MS ?? 20)
// Handshake: after GATE_AFTER words the stream pauses until POST /__release?key=<id> (or a 20 s
// safety timeout), so a test can observe the partial reply deterministically on any runner speed.
// Holds are keyed by a per-test id (#147): put `[t:<id>]` in the chat message and release with that
// id, so two tests holding replies at the same time never release each other. A message without a
// marker uses the key `default`. POST /__release with no key releases every hold.
const GATE_AFTER = Number(process.env.MOCK_MODEL_GATE_AFTER ?? 6)
/** key -> resolvers of streams waiting at the gate */
const holds = new Map()

function waitForRelease(key) {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(t)
      const list = holds.get(key) ?? []
      const rest = list.filter((r) => r !== done)
      if (rest.length) holds.set(key, rest)
      else holds.delete(key)
      resolve()
    }
    const t = setTimeout(done, 20_000)
    holds.set(key, [...(holds.get(key) ?? []), done])
  })
}

function releaseNow(key) {
  const keys = key ? [key] : [...holds.keys()]
  let n = 0
  for (const k of keys) {
    for (const done of [...(holds.get(k) ?? [])]) {
      done()
      n++
    }
  }
  return n
}

/** Release held streams. Waits up to 3 s for a hold to appear, so a test that releases just as the
 * stream reaches the gate does not race it. */
async function release(key) {
  for (let i = 0; i < 30; i++) {
    const n = releaseNow(key)
    if (n > 0) return n
    await new Promise((r) => setTimeout(r, 100))
  }
  return 0
}

/** The hold key: the last `[t:<id>]` marker anywhere in the conversation sent, or `default`. */
export function holdKey(messages = []) {
  const all = [...JSON.stringify(messages).matchAll(/\[t:([\w-]{1,64})\]/g)]
  return all.at(-1)?.[1] ?? 'default'
}

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
    const url = new URL(req.url ?? '/', 'http://mock')
    if (url.pathname === '/__health') return res.writeHead(200, { 'content-type': 'text/plain' }).end('ok')
    if (url.pathname === '/__release' && req.method === 'POST') {
      void release(url.searchParams.get('key')).then((released) =>
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ released: released > 0, count: released })),
      )
      return
    }
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', async () => {
      if (!url.pathname.includes('chat/completions')) return res.writeHead(404).end()
      const body = JSON.parse(raw || '{}')
      const last = body.messages?.at(-1)
      const tools = (body.tools ?? []).map((t) => t.function?.name)
      const key = holdKey(body.messages)
      if (process.env.MOCK_MODEL_DEBUG) console.log(`mock: request key=${key} tools=${tools.join(',')} last=${last?.role}`)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const send = (d, extra = {}) => res.write(`data: ${JSON.stringify({ id: 'm', object: 'chat.completion.chunk', created: 1, model: 'mock', choices: [{ index: 0, ...d }], ...extra })}\n\n`)
      // Report token usage on the final chunk, as real providers do. Without it Crosswire's budget
      // check fails closed and pauses agent replies for the org until midnight UTC.
      const usage = { usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 } }
      if (tools.includes('search_intel') && last?.role !== 'tool') {
        send({ delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'search_intel', arguments: '{"query":"fortinet"}' } }] }, finish_reason: null })
        send({ delta: {}, finish_reason: 'tool_calls' }, usage)
      } else {
        // Stop early if the client goes away (Stop button). The request object is already
        // finished at this point, so watch the response's close event, not req.destroyed.
        let gone = false
        res.on('close', () => (gone = true))
        const words = ANSWER.match(/\S+\s*/g)
        for (const [i, w] of words.entries()) {
          if (gone) break
          if (i === GATE_AFTER) await waitForRelease(key)
          send({ delta: { content: w }, finish_reason: null })
          await new Promise((r) => setTimeout(r, DELAY))
        }
        send({ delta: {}, finish_reason: 'stop' }, usage)
      }
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  .listen(PORT, '127.0.0.1', () => console.log(`mock model on ${PORT}`))
