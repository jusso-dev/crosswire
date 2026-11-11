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
  // Cross-service and cross-resource functions (#193): adx() reaches an Azure Data Explorer cluster,
  // workspace()/app()/resource() reach other Log Analytics workspaces, apps and resources, arg()
  // reaches Azure Resource Graph.
  [/\b(adx|arg|workspace|app|resource)\s*\(/i, 'adx(), arg(), workspace(), app() and resource() cross-service queries'],
]

/**
 * `evaluate` plugins a hunting query may use (#193). Each one only reshapes rows the query already
 * has. Any other plugin is refused, so a new or unlisted plugin can never call out of the workspace.
 */
export const ALLOWED_EVALUATE_PLUGINS: readonly string[] = ['autocluster', 'bag_unpack', 'basket', 'diffpatterns', 'narrow', 'pivot']

/**
 * The query with `//` comments outside string literals removed (#193). KQL has no block comments.
 * Strings are '…' and "…" (backslash escapes, optional h/H prefix), @'…' and @"…" (doubled quote
 * escapes) and ```…```. An unterminated string runs to the end (KQL refuses such a query anyway).
 * With `blankStrings`, each string literal becomes "" so only code is left.
 */
export function stripKqlComments(q: string, blankStrings = false): string {
  let out = ''
  let i = 0
  while (i < q.length) {
    const c = q[i]!
    if (c === '/' && q[i + 1] === '/') {
      while (i < q.length && q[i] !== '\n') i++
      out += ' '
      continue
    }
    if (q.startsWith('```', i)) {
      const end = q.indexOf('```', i + 3)
      const stop = end === -1 ? q.length : end + 3
      out += blankStrings ? '""' : q.slice(i, stop)
      i = stop
      continue
    }
    if (c === '"' || c === "'") {
      const verbatim = q[i - 1] === '@'
      let j = i + 1
      while (j < q.length) {
        if (!verbatim && q[j] === '\\') j += 2
        else if (q[j] === c && verbatim && q[j + 1] === c) j += 2
        else if (q[j] === c) break
        else j++
      }
      const stop = Math.min(j + 1, q.length)
      out += blankStrings ? '""' : q.slice(i, stop)
      i = stop
      continue
    }
    out += c
    i++
  }
  return out
}

/**
 * The first `evaluate` plugin not on the allowlist, skipping `hint.x = y` parameters, or null. Runs
 * on code with string literals blanked, so the word inside a search string is not a call. Fails
 * closed: an `evaluate` with no plain plugin name after it is refused.
 */
function disallowedPlugin(code: string): string | null {
  for (const m of code.matchAll(/\bevaluate\b/gi)) {
    const rest = code.slice(m.index + m[0].length).replace(/^(\s*hint\.\w+\s*=\s*(""|[\w.]+))*\s*/i, '')
    const name = /^[A-Za-z_]\w*/.exec(rest)?.[0]
    if (!name || !ALLOWED_EVALUATE_PLUGINS.includes(name.toLowerCase())) return name ?? '(unknown)'
  }
  return null
}

/** Validate KQL before it can run. Returns the trimmed query or throws UnsafeQueryError. */
export function assertSafeKql(kql: string): string {
  const q = kql.trim()
  if (!q) throw new UnsafeQueryError('Query is empty.')
  if (q.length > MAX_KQL_LENGTH) throw new UnsafeQueryError(`Query is longer than ${MAX_KQL_LENGTH} characters.`)
  // Two passes. The raw text, comments and string literals included, so a `//` inside a string
  // literal cannot hide the rest of the line. Then the text with comments removed outside strings
  // and whitespace collapsed, so a comment and line break between a keyword and `(` cannot hide a
  // call (#193). False positives are acceptable here.
  const normalised = stripKqlComments(q).replace(/\s+/g, ' ')
  for (const [re, label] of BLOCKED) {
    if (re.test(q) || re.test(normalised)) throw new UnsafeQueryError(`Blocked in hunting queries: ${label}.`)
  }
  const plugin = disallowedPlugin(stripKqlComments(q, true))
  if (plugin) throw new UnsafeQueryError(`Blocked in hunting queries: evaluate ${plugin}. Allowed plugins: ${ALLOWED_EVALUATE_PLUGINS.join(', ')}.`)
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
