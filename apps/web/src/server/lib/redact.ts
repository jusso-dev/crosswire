/** Redaction helpers shared by the logger, audit logs and agent memory. */

const PATTERNS: Array<[RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [REDACTED]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_JWT]'],
  [/\b(gh[pousr]_[A-Za-z0-9]{20,})\b/g, '[REDACTED_GITHUB_TOKEN]'],
  [/\b(sk-[A-Za-z0-9_-]{16,})\b/g, '[REDACTED_API_KEY]'],
  [/\b(xox[abpr]-[A-Za-z0-9-]{10,})\b/g, '[REDACTED_TOKEN]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED_AWS_KEY]'],
  [/((?:client_secret|password|api[_-]?key|secret|token|access_token|refresh_token|code)["']?\s*[:=]\s*["']?)[^\s"'&,}]{6,}/gi, '$1[REDACTED]'],
  [/https:\/\/[a-z0-9-]+\.vault\.azure\.net\/secrets\/[^\s"']+/gi, '[REDACTED_KEYVAULT_REF]'],
  [/(sig=)[^&\s"']+/gi, '$1[REDACTED]'],
]

export function redactString(input: string): string {
  let out = input
  for (const [re, replacement] of PATTERNS) out = out.replace(re, replacement)
  return out
}

/** True when the string contains something that looks like a credential. */
export function looksSecret(input: string): boolean {
  return redactString(input) !== input
}

const SENSITIVE_KEYS = /^(authorization|cookie|set-cookie|password|secret|token|access_token|refresh_token|id_token|client_secret|api_key|apikey|x-api-key|x-identity-header)$/i

export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[TRUNCATED]'
  if (typeof value === 'string') return redactString(value)
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEYS.test(k) ? '[REDACTED]' : redactValue(v, depth + 1)
    }
    return out
  }
  return value
}

export function truncate(input: string, max = 2000): string {
  return input.length > max ? `${input.slice(0, max)}… [truncated ${input.length - max} chars]` : input
}
