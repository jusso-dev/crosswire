import { env } from '../env'
import { redactString, redactValue } from '../lib/redact'
import { withoutSamples } from './tools'

export interface ModelMessage {
  role: 'user' | 'assistant'
  content: string
}

/**
 * Copy of chat history for the model. The database keeps the raw message.
 * Secrets are redacted. Embedded result rows are replaced with counts.
 */
export function prepareModelMessages(messages: ModelMessage[]): ModelMessage[] {
  if (env().EGRESS_FILTER === 'legacy') return messages
  return messages.map((message) => ({ role: message.role, content: prepareModelText(message.content) }))
}

export function prepareModelText(content: string) {
  const redacted = redactString(content)
  const trimmed = redacted.trim()
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      return JSON.stringify(redactValue(withoutSamples(JSON.parse(trimmed))))
    } catch {
      return redacted
    }
  }
  return redacted
}
