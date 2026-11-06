import { createAnthropicChat } from '@tanstack/ai-anthropic'
import { createOpenaiChat } from '@tanstack/ai-openai'
import { fakeText, type FakeResponseStep } from '@tanstack/ai/testing'
import { AGENT_LABELS, type AgentKey } from '../../shared/agents'
import { env } from '../env'

/**
 * Model adapters. `stub` (default) needs no key: a deterministic, clearly labelled fake model that
 * still reflects the selected charter, so OSS contributors can exercise chat end-to-end.
 * BYO keys: MODEL_PROVIDER=anthropic|openai with ANTHROPIC_API_KEY / OPENAI_API_KEY.
 */
export function createModelAdapter(agentKey: AgentKey) {
  const e = env()
  if (e.MODEL_PROVIDER === 'anthropic' && e.ANTHROPIC_API_KEY) {
    return createAnthropicChat((e.MODEL_NAME || 'claude-sonnet-5-5') as Parameters<typeof createAnthropicChat>[0], e.ANTHROPIC_API_KEY)
  }
  if (e.MODEL_PROVIDER === 'openai' && e.OPENAI_API_KEY) {
    return createOpenaiChat((e.MODEL_NAME || 'gpt-4.1') as Parameters<typeof createOpenaiChat>[0], e.OPENAI_API_KEY)
  }
  return stubAdapter(agentKey)
}

const STUB_FOCUS: Record<AgentKey, string> = {
  lead: 'I would scope this, then route intel questions to Intel, tenant queries to Hunter and containment to Responder.',
  hunter: 'I would draft read-only KQL with a time filter and row limit, and propose it on a hunt case for your review. I never run queries myself.',
  intel: 'I would check pwn.watch and CISA KEV for this, cite each source, and note where they agree or differ.',
  responder: 'I would draft a response proposal with explicit targets and a blast radius for an approver. I never execute actions.',
  scribe: 'I would record a short, sourced fact in org memory and keep any safety notes verbatim.',
}

function lastUserText(request: { messages: Array<{ role: string; content: unknown }> }) {
  const last = [...request.messages].reverse().find((m) => m.role === 'user')
  if (!last) return ''
  return typeof last.content === 'string' ? last.content : JSON.stringify(last.content)
}

export function stubAdapter(agentKey: AgentKey) {
  const adapter = fakeText({ model: 'crosswire-stub', tokensPerSecond: 400 })
  const step: FakeResponseStep = ({ request }) => {
    const said = lastUserText(request as never).slice(0, 200)
    return {
      text:
        `[stub model, no API key configured] ${AGENT_LABELS[agentKey].name} here. ` +
        `You asked: "${said}". ${STUB_FOCUS[agentKey]} ` +
        'Set MODEL_PROVIDER and an API key in .env to get real answers.',
    }
  }
  // Each chat() call consumes one step; queue plenty so multi-iteration loops never run dry.
  adapter.setResponses(Array.from({ length: 16 }, () => step))
  return adapter
}
