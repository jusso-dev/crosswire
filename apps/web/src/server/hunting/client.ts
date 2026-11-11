import { env } from '../env'
import { assertAllowedRequest, clampRows, clampTimeout, assertSafeKql } from './safety'
import { tokenBroker } from './broker'
import { getConnector, HuntingNotConfiguredError } from './broker'
import { demoAdvancedHunting, demoSentinelIncidents, demoSentinelQuery } from './fixtures'
import { readCappedText } from '../ti/http'

export interface QueryResult {
  mode: 'live' | 'demo'
  columns: string[]
  rows: Array<Record<string, unknown>>
  rowCount: number
  truncated: boolean
  durationMs: number
}

export type FetchLike = typeof fetch

/**
 * Largest response body the hunting client reads (#200). The body is counted as it arrives and the
 * read stops once this is passed, so a huge result set is never buffered whole. 1,000 rows is the
 * most a search keeps, so a legitimate result is far below this.
 */
export const HARD_RESPONSE_BYTES = 32 * 1024 * 1024

/** Microsoft answered, but not with a full result. The message is written for the analyst. */
export class HuntingResultError extends Error {}

/**
 * Where a search runs right now (#189): demo fixtures, or the tenant, app registration and
 * workspace in the saved connector. A schedule stores this when a person approves it and stops
 * when it no longer matches.
 */
export interface HuntingContext {
  mode: 'live' | 'demo'
  tenantId: string | null
  clientId: string | null
  sentinelWorkspaceId: string | null
}

export async function huntingContext(orgId: string): Promise<HuntingContext> {
  const c = await getConnector(orgId)
  if (!c && env().HUNTING_DEMO_MODE) return { mode: 'demo', tenantId: null, clientId: null, sentinelWorkspaceId: null }
  return { mode: 'live', tenantId: c?.tenantId ?? null, clientId: c?.clientId ?? null, sentinelWorkspaceId: c?.sentinelWorkspaceId ?? null }
}

export function sameHuntingContext(a: HuntingContext, b: HuntingContext) {
  return a.mode === b.mode && a.tenantId === b.tenantId && a.clientId === b.clientId && a.sentinelWorkspaceId === b.sentinelWorkspaceId
}

/**
 * HuntingGraphClient (#45, #49): the only HTTP path hunting code may use. Every request is checked
 * against the read-only allowlist before a token is even requested; there is no generic
 * `request(url)` escape hatch. Response executors use a separate client (server/response/).
 */
export class HuntingClient {
  constructor(private readonly fetchImpl: FetchLike = fetch) {}

  private async call(orgId: string, method: 'GET' | 'POST', url: string, scope: string, body: unknown, timeoutMs: number) {
    assertAllowedRequest(method, url)
    const token = await tokenBroker().acquire({ orgId, scope })
    const res = await this.fetchImpl(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    let text: string
    try {
      text = await readCappedText(res, HARD_RESPONSE_BYTES)
    } catch (err) {
      if (/larger than/.test(err instanceof Error ? err.message : '')) {
        throw new HuntingResultError(`The result is larger than ${HARD_RESPONSE_BYTES / 1024 / 1024} MB, so Crosswire stopped reading it. Add a take or summarize to the query and run it again.`)
      }
      throw err
    }
    let json: Record<string, unknown> = {}
    try {
      const parsed: unknown = JSON.parse(text)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) json = parsed as Record<string, unknown>
    } catch {
      if (res.ok) throw new HuntingResultError('Microsoft returned a result Crosswire could not read. Nothing was recorded as a hit or a miss. Try again.')
    }
    if (!res.ok) throw new Error(translateError(res.status, json))
    // A 200 can still carry a top-level error: Log Analytics returns PartialError when a limit cut
    // the result short. A partial result must never read as "no hits", so it fails the search.
    if (json.error) throw new HuntingResultError(`Microsoft returned only part of the result, so the search is recorded as failed rather than as no hits. Narrow the query and run it again. ${errorDetail(json)}`.trim())
    return json
  }

  private async isDemo(orgId: string) {
    return (await huntingContext(orgId)).mode === 'demo'
  }

  async runAdvancedHunting(input: { orgId: string; kql: string; maxRows?: number; timeoutMs?: number }): Promise<QueryResult> {
    const kql = assertSafeKql(input.kql)
    const maxRows = clampRows(input.maxRows)
    const timeoutMs = clampTimeout(input.timeoutMs)
    const started = Date.now()
    if (await this.isDemo(input.orgId)) return cap(demoAdvancedHunting(kql), maxRows, 'demo', started)
    const json = await this.call(input.orgId, 'POST', 'https://graph.microsoft.com/v1.0/security/runHuntingQuery', 'https://graph.microsoft.com/.default', { Query: kql, Timespan: 'P30D' }, timeoutMs)
    // A missing results list is an unreadable answer, never zero rows (#200).
    if (!Array.isArray(json.results)) throw unreadable()
    const schema = Array.isArray(json.schema) ? (json.schema as Array<{ name?: string; Name?: string }>) : []
    return cap({ columns: schema.map((c) => c.name ?? c.Name ?? ''), rows: json.results as Array<Record<string, unknown>> }, maxRows, 'live', started)
  }

  async runSentinelKql(input: { orgId: string; kql: string; maxRows?: number; timeoutMs?: number; timespan?: string }): Promise<QueryResult> {
    const kql = assertSafeKql(input.kql)
    const maxRows = clampRows(input.maxRows)
    const timeoutMs = clampTimeout(input.timeoutMs)
    const started = Date.now()
    if (await this.isDemo(input.orgId)) return cap(demoSentinelQuery(kql), maxRows, 'demo', started)
    const c = await getConnector(input.orgId)
    if (!c?.sentinelWorkspaceId) throw new HuntingNotConfiguredError(input.orgId)
    const json = await this.call(
      input.orgId,
      'POST',
      `https://api.loganalytics.io/v1/workspaces/${c.sentinelWorkspaceId}/query`,
      'https://api.loganalytics.io/.default',
      { query: kql, timespan: input.timespan ?? 'P7D' },
      timeoutMs,
    )
    const table = (Array.isArray(json.tables) ? json.tables[0] : undefined) as { columns?: unknown; rows?: unknown } | undefined
    // A missing table, column list or row list is an unreadable answer, never zero rows (#200).
    if (!table || !Array.isArray(table.columns) || !Array.isArray(table.rows)) throw unreadable()
    const columns = (table.columns as Array<{ name: string }>).map((col) => col.name)
    const rows = (table.rows as unknown[][]).map((r) => Object.fromEntries(columns.map((name, i) => [name, r[i]])))
    return cap({ columns, rows }, maxRows, 'live', started)
  }

  async listSentinelIncidents(input: { orgId: string; top?: number }) {
    const top = Math.min(clampRows(input.top ?? 20), 50)
    if (await this.isDemo(input.orgId)) return { mode: 'demo' as const, incidents: demoSentinelIncidents().slice(0, top) }
    const c = await getConnector(input.orgId)
    if (!c?.sentinelSubscriptionId || !c.sentinelResourceGroup || !c.sentinelWorkspaceName) throw new HuntingNotConfiguredError(input.orgId)
    const url =
      `https://management.azure.com/subscriptions/${encodeURIComponent(c.sentinelSubscriptionId)}/resourceGroups/${encodeURIComponent(c.sentinelResourceGroup)}` +
      `/providers/Microsoft.OperationalInsights/workspaces/${encodeURIComponent(c.sentinelWorkspaceName)}/providers/Microsoft.SecurityInsights/incidents` +
      `?api-version=2024-03-01&$top=${top}&$orderby=properties/createdTimeUtc desc`
    const json = await this.call(input.orgId, 'GET', url, 'https://management.azure.com/.default', undefined, clampTimeout())
    if (!Array.isArray(json.value)) throw unreadable()
    const value = json.value as Array<{ name: string; properties: Record<string, unknown> }>
    return {
      mode: 'live' as const,
      incidents: value.map((v) => ({
        id: v.name,
        number: v.properties.incidentNumber,
        title: v.properties.title,
        severity: v.properties.severity,
        status: v.properties.status,
        createdTimeUtc: v.properties.createdTimeUtc,
      })),
    }
  }
}

function cap(r: { columns: string[]; rows: Array<Record<string, unknown>> }, maxRows: number, mode: 'live' | 'demo', started: number): QueryResult {
  return { mode, columns: r.columns, rows: r.rows.slice(0, maxRows), rowCount: r.rows.length, truncated: r.rows.length > maxRows, durationMs: Date.now() - started }
}

const unreadable = () => new HuntingResultError('Microsoft returned a result without the expected rows, so Crosswire cannot tell whether anything matched. Nothing was recorded as a hit or a miss. Try again.')

/**
 * Microsoft's error code and a short message. Shown to the analyst and stored on the search, so the
 * message is kept short and free of request ids; the screen falls back to a generic sentence for
 * long or id-bearing text (#129).
 */
function errorParts(json: Record<string, unknown>) {
  const err = (json.error ?? {}) as { code?: string; message?: string }
  const message = err.message ? String(err.message).replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '(id removed)').replace(/\s+/g, ' ').trim() : ''
  return { code: err.code ? String(err.code).slice(0, 40) : '', detail: message.length > 110 ? `${message.slice(0, 110)}…` : message }
}

/** "(code: message)" for an error on a successful response, or empty when there is none. */
function errorDetail(json: Record<string, unknown>) {
  const { code, detail } = errorParts(json)
  if (!code && !detail) return ''
  return `(${code}${code && detail ? ': ' : ''}${detail})`
}

function translateError(status: number, json: Record<string, unknown>) {
  const hint =
    status === 401
      ? 'The app registration token was rejected. Check client ID/secret and tenant.'
      : status === 403
        ? 'Permission denied. Check admin consent for ThreatHunting.Read.All / Log Analytics Reader / Microsoft Sentinel Reader (docs/hunting.md).'
        : status === 400
          ? 'The query was rejected. Check the KQL syntax and table names.'
          : status === 429
            ? 'Microsoft throttled the request. Wait and try again.'
            : 'Microsoft API error.'
  const { code, detail } = errorParts(json)
  return `${hint} (HTTP ${status}${code ? `, ${code}` : ''}${detail ? `: ${detail}` : ''})`
}

let client: HuntingClient | undefined
export function huntingClient() {
  client ??= new HuntingClient()
  return client
}
export function setHuntingClient(c: HuntingClient) {
  client = c
}
