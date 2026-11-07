import { chat } from '@tanstack/ai'
import { createModelAdapter, modelDescription } from '../agents/model'
import { runCli } from './run'

/**
 * `pnpm model:check`: one tiny real call to the configured chat model, for smoke tests after a
 * deploy. Prints the provider, deployment and auth mode, never credentials or the reply body.
 */
runCli('model:check', async () => {
  const d = modelDescription()
  const started = Date.now()
  const out = await chat({
    adapter: createModelAdapter('lead'),
    messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
    threadId: `model-check-${started}`,
    stream: false,
  })
  const text = typeof out === 'string' ? out : ((out as { text?: string }).text ?? '')
  if (!text.trim()) throw new Error('The model returned an empty reply.')
  return { ...d, ok: true, latencyMs: Date.now() - started, replyChars: text.length }
})
