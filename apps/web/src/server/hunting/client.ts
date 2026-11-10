import { env } from '../env'
import { assertAllowedRequest, clampRows, clampTimeout, assertSafeKql } from './safety'
import { tokenBroker } from './broker'
import { getConnector, HuntingNotConfiguredError } from './broker'
import { demoAdvancedHunting, demoSentinelIncidents, demoSentinelQuery } from './fixtures'

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
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) throw new Error(translateError(res.status, json))
    return json
  }

  private async isDemo(orgId: string) {
    if (!env().HUNTING_DEMO_MODE) return false
    return (await getConnector(orgId)) === null
  }

  async runAdvancedHunting(input: { orgId: string; kql: string; maxRows?: number; timeoutMs?: number }): Promise<QueryResult> {
    const kql = assertSafeKql(input.kql)
    const maxRows = clampRows(input.maxRows)
    const timeoutMs = clampTimeout(input.timeoutMs)
    const started = Date.now()
    if (await this.isDemo(input.orgId)) return cap(demoAdvancedHunting(kql), maxRows, 'demo', started)
    const json = await this.call(input.orgId, 'POST', 'https://graph.microsoft.com/v1.0/security/runHuntingQuery', 'https://graph.microsoft.com/.default', { Query: kql, Timespan: 'P30D' }, timeoutMs)
    const schema = (json.schema as Array<{ name?: string; Name?: string }> | undefined) ?? []
    const results = (json.results as Array<Record<string, unknown>> | undefined) ?? []
    return cap({ columns: schema.map((c) => c.name ?? c.Name ?? ''), rows: results }, maxRows, 'live', started)
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
    const table = (json.tables as Array<{ columns: Array<{ name: string }>; rows: unknown[][] }> | undefined)?.[0]
    const columns = table?.columns.map((col) => col.name) ?? []
    const rows = (table?.rows ?? []).map((r) => Object.fromEntries(columns.map((name, i) => [name, r[i]])))
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
    const value = (json.value as Array<{ name: string; properties: Record<string, unknown> }> | undefined) ?? []
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

function translateError(status: number, json: Record<string, unknown>) {
  const err = (json.error ?? {}) as { code?: string; message?: string }
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
  // Shown to the analyst and stored on the search, so keep Microsoft's detail short and free of
  // request ids; the screen falls back to a generic sentence for long or id-bearing text (#129).
  const detail = err.message ? String(err.message).replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '(id removed)').replace(/\s+/g, ' ').trim() : ''
  const code = err.code ? String(err.code).slice(0, 40) : ''
  return `${hint} (HTTP ${status}${code ? `, ${code}` : ''}${detail ? `: ${detail.length > 110 ? `${detail.slice(0, 110)}…` : detail}` : ''})`
}

let client: HuntingClient | undefined
export function huntingClient() {
  client ??= new HuntingClient()
  return client
}
export function setHuntingClient(c: HuntingClient) {
  client = c
}
