import { createHash } from 'node:crypto'

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as object).sort()) out[key] = sortValue((value as Record<string, unknown>)[key])
    return out
  }
  return value
}

/** Stable JSON for content hashes. Key order does not change the digest. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value))
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}
