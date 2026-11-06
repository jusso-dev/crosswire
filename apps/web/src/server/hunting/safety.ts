import { env } from '../env'

export const MAX_KQL_LENGTH = 10_000
export const HARD_ROW_CAP = 1000
export const HARD_TIMEOUT_MS = 120_000

export class UnsafeQueryError extends Error {}

/**
 * Operators/functions blocked in hunting KQL (#49). Hunting is read-only, but these can pull
 * external data, call out of the workspace, or are management/export commands.
 */
const BLOCKED: Array<[RegExp, string]> = [
  [/\bexternaldata\b/i, 'externaldata'],
  [/\bexternal_table\s*\(/i, 'external_table()'],
  [/\bevaluate\s+http_request/i, 'evaluate http_request'],
  [/\bevaluate\s+(python|r)\s*\(/i, 'evaluate python/R plugins'],
  [/\bevaluate\s+sql_request/i, 'evaluate sql_request'],
  [/(^|\n|;)\s*\.\w+/, 'management commands (.set/.drop/.export …)'],
  [/\bcluster\s*\(/i, 'cluster() cross-cluster queries'],
]

/** Validate KQL before it can run. Returns the trimmed query or throws UnsafeQueryError. */
export function assertSafeKql(kql: string): string {
  const q = kql.trim()
  if (!q) throw new UnsafeQueryError('Query is empty.')
  if (q.length > MAX_KQL_LENGTH) throw new UnsafeQueryError(`Query is longer than ${MAX_KQL_LENGTH} characters.`)
  // Scan the raw text, comments and string literals included: stripping `//` comments would let a
  // URL inside a string literal hide the rest of the line. False positives are acceptable here.
  for (const [re, label] of BLOCKED) {
    if (re.test(q)) throw new UnsafeQueryError(`Blocked in hunting queries: ${label}.`)
  }
  return q
}

/** Clamp row caps and timeouts: absurd caller values never exceed the hard limits. */
export function clampRows(requested?: number): number {
  const fallback = env().HUNTING_MAX_ROWS
  const n = Number.isFinite(requested) && requested! > 0 ? Math.floor(requested!) : fallback
  return Math.min(n, HARD_ROW_CAP)
}

export function clampTimeout(requested?: number): number {
  const fallback = env().HUNTING_TIMEOUT_MS
  const n = Number.isFinite(requested) && requested! > 0 ? Math.floor(requested!) : fallback
  return Math.min(n, HARD_TIMEOUT_MS)
}

/** Allowlist for the hunting HTTP client: exact hosts, methods and path patterns. */
export const HUNTING_ALLOWLIST: Array<{ method: 'GET' | 'POST'; host: string; path: RegExp; purpose: string }> = [
  { method: 'POST', host: 'graph.microsoft.com', path: /^\/v1\.0\/security\/runHuntingQuery$/, purpose: 'Defender XDR Advanced Hunting (read-only query)' },
  { method: 'POST', host: 'api.loganalytics.io', path: /^\/v1\/workspaces\/[0-9a-f-]{36}\/query$/i, purpose: 'Sentinel / Log Analytics KQL query' },
  {
    method: 'GET',
    host: 'management.azure.com',
    path: /^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/Microsoft\.OperationalInsights\/workspaces\/[^/]+\/providers\/Microsoft\.SecurityInsights\/incidents$/i,
    purpose: 'Sentinel incidents (list, read-only)',
  },
]

export class BlockedRequestError extends Error {}

export function assertAllowedRequest(method: string, url: string) {
  const u = new URL(url)
  if (u.protocol !== 'https:') throw new BlockedRequestError('Hunting client only allows https.')
  const ok = HUNTING_ALLOWLIST.some((r) => r.method === method.toUpperCase() && r.host === u.hostname && r.path.test(u.pathname))
  if (!ok) throw new BlockedRequestError(`Hunting client blocked ${method.toUpperCase()} ${u.hostname}${u.pathname}: not on the read-only allowlist.`)
}
