/** Saved and built-in indicator playbooks. Safe to import from client routes. */

export const INDICATOR_KINDS = ['ip', 'domain', 'hash'] as const
export type IndicatorKind = (typeof INDICATOR_KINDS)[number]
export type HuntTarget = 'defender' | 'sentinel'

export type PlaybookCheck = { name: string; target: HuntTarget; kql: string }

export type PlaybookTemplate = {
  id: string
  name: string
  description: string
  indicatorKind: IndicatorKind
  checks: PlaybookCheck[]
}

export const INDICATOR_PLACEHOLDER = '{{indicator}}'

export const INDICATOR_LABEL: Record<IndicatorKind, string> = {
  ip: 'IP address',
  domain: 'domain',
  hash: 'file hash',
}

const IP_V4 = /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/

/** Compressed or full IPv6. No zone id, no dotted IPv4 tail. The charset cannot break a KQL string. */
function isIpv6(value: string) {
  if (!/^[0-9a-f:]+$/i.test(value) || value.includes(':::')) return false
  const halves = value.split('::')
  if (halves.length > 2) return false
  const groups = halves.flatMap((half) => (half === '' ? [] : half.split(':')))
  if (groups.some((group) => group.length < 1 || group.length > 4 || !/^[0-9a-f]+$/i.test(group))) return false
  if (halves.length === 1) return groups.length === 8
  return groups.length < 8
}

const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i
const HASH = /^[a-f0-9]{32}$|^[a-f0-9]{40}$|^[a-f0-9]{64}$/i

export function normaliseIndicator(kind: IndicatorKind, raw: string): string | null {
  const value = raw.trim()
  if (kind === 'ip') return IP_V4.test(value) || isIpv6(value) ? value : null
  if (kind === 'domain') return DOMAIN.test(value) ? value.toLowerCase() : null
  return HASH.test(value) ? value.toLowerCase() : null
}

export function fillIndicator(template: string, indicator: string) {
  if (!template.includes(INDICATOR_PLACEHOLDER)) throw new Error(`Query template must contain ${INDICATOR_PLACEHOLDER}.`)
  return template.split(INDICATOR_PLACEHOLDER).join(indicator)
}

const CHECK_PREFIX = 'Check: '

export function checkLabel(rationale: string, kql: string) {
  const line = rationale.split('\n')[0]?.trim() ?? ''
  if (line.startsWith(CHECK_PREFIX)) {
    const name = line.slice(CHECK_PREFIX.length).trim()
    if (name) return name
  }
  return (kql.trim().split('\n')[0]?.trim() || 'Search').slice(0, 80)
}

export function checkRationale(name: string) {
  return `${CHECK_PREFIX} ${name}`
}

export type CoverageOutcome = 'hit' | 'no-hit' | 'not-run' | 'failed' | 'unknown'

export type CoverageRow = {
  name: string
  target: string
  status: string
  outcome: CoverageOutcome
  rowCount: number | null
}

export type CoverageAnswer = 'yes' | 'no' | 'incomplete'

export const HIT_ANSWER: Record<CoverageAnswer, string> = {
  yes: 'Yes. At least one check returned rows.',
  no: 'No. Every check ran and returned no rows.',
  incomplete: 'Not fully checked. Some searches have not run, or a search failed.',
}

export const OUTCOME_LABEL: Record<CoverageOutcome, string> = {
  hit: 'Hit',
  'no-hit': 'No hit',
  'not-run': 'Not run',
  failed: 'Failed',
  unknown: 'Unknown',
}

export function coverageOf(
  proposals: Array<{ rationale: string; kql: string; target: string; status: string; resultSummary: { rowCount?: number } | null }>,
) {
  const rows: CoverageRow[] = proposals.map((proposal) => {
    const rowCount = typeof proposal.resultSummary?.rowCount === 'number' ? proposal.resultSummary.rowCount : null
    let outcome: CoverageOutcome = 'not-run'
    if (proposal.status === 'failed') outcome = 'failed'
    else if (proposal.status === 'run') outcome = rowCount === null ? 'unknown' : rowCount > 0 ? 'hit' : 'no-hit'
    return { name: checkLabel(proposal.rationale, proposal.kql), target: proposal.target, status: proposal.status, outcome, rowCount }
  })
  const hits = rows.filter((row) => row.outcome === 'hit').length
  const clean = rows.filter((row) => row.outcome === 'hit' || row.outcome === 'no-hit').length
  const answer: CoverageAnswer = hits > 0 ? 'yes' : rows.length > 0 && clean === rows.length ? 'no' : 'incomplete'
  return { answer, hits, ran: clean, total: rows.length, rows }
}

const DAYS = '30d'

export const BUILTIN_PLAYBOOKS: PlaybookTemplate[] = [
  {
    id: 'builtin:ip',
    name: 'IP address check',
    description: 'Defender network and sign-in tables, plus a Sentinel workspace search, for one IP address.',
    indicatorKind: 'ip',
    checks: [
      {
        name: 'Defender network events',
        target: 'defender',
        kql: `DeviceNetworkEvents
| where Timestamp > ago(${DAYS})
| where RemoteIP == '${INDICATOR_PLACEHOLDER}' or LocalIP == '${INDICATOR_PLACEHOLDER}'
| project Timestamp, DeviceName, ActionType, RemoteIP, RemotePort, RemoteUrl, InitiatingProcessFileName
| take 100`,
      },
      {
        name: 'Defender sign-ins',
        target: 'defender',
        kql: `IdentityLogonEvents
| where Timestamp > ago(${DAYS})
| where IPAddress == '${INDICATOR_PLACEHOLDER}'
| project Timestamp, AccountUpn, IPAddress, ActionType, Application
| take 100`,
      },
      {
        name: 'Defender device events',
        target: 'defender',
        kql: `DeviceEvents
| where Timestamp > ago(${DAYS})
| where RemoteIP == '${INDICATOR_PLACEHOLDER}'
| project Timestamp, DeviceName, ActionType, RemoteIP, InitiatingProcessFileName
| take 100`,
      },
      {
        name: 'Sentinel workspace search',
        target: 'sentinel',
        kql: `search '${INDICATOR_PLACEHOLDER}'
| where TimeGenerated > ago(${DAYS})
| take 100`,
      },
    ],
  },
  {
    id: 'builtin:domain',
    name: 'Domain check',
    description: 'Defender network, email, and link-click tables, plus a Sentinel workspace search, for one domain.',
    indicatorKind: 'domain',
    checks: [
      {
        name: 'Defender network events',
        target: 'defender',
        kql: `DeviceNetworkEvents
| where Timestamp > ago(${DAYS})
| where RemoteUrl has '${INDICATOR_PLACEHOLDER}'
| project Timestamp, DeviceName, RemoteUrl, RemoteIP, InitiatingProcessFileName
| take 100`,
      },
      {
        name: 'Defender email',
        target: 'defender',
        kql: `EmailEvents
| where Timestamp > ago(${DAYS})
| where SenderFromDomain == '${INDICATOR_PLACEHOLDER}' or RecipientEmailDomain == '${INDICATOR_PLACEHOLDER}'
| project Timestamp, SenderFromAddress, RecipientEmailAddress, Subject
| take 100`,
      },
      {
        name: 'Defender link clicks',
        target: 'defender',
        kql: `UrlClickEvents
| where Timestamp > ago(${DAYS})
| where Url has '${INDICATOR_PLACEHOLDER}'
| project Timestamp, AccountUpn, Url, ActionType
| take 100`,
      },
      {
        name: 'Sentinel workspace search',
        target: 'sentinel',
        kql: `search '${INDICATOR_PLACEHOLDER}'
| where TimeGenerated > ago(${DAYS})
| take 100`,
      },
    ],
  },
  {
    id: 'builtin:hash',
    name: 'File hash check',
    description: 'Defender file, process, and image-load tables, plus a Sentinel workspace search, for one MD5, SHA1, or SHA256.',
    indicatorKind: 'hash',
    checks: [
      {
        name: 'Defender file events',
        target: 'defender',
        kql: `DeviceFileEvents
| where Timestamp > ago(${DAYS})
| where SHA256 == '${INDICATOR_PLACEHOLDER}' or SHA1 == '${INDICATOR_PLACEHOLDER}' or MD5 == '${INDICATOR_PLACEHOLDER}'
| project Timestamp, DeviceName, FileName, FolderPath, SHA256, ActionType
| take 100`,
      },
      {
        name: 'Defender process events',
        target: 'defender',
        kql: `DeviceProcessEvents
| where Timestamp > ago(${DAYS})
| where SHA256 == '${INDICATOR_PLACEHOLDER}' or SHA1 == '${INDICATOR_PLACEHOLDER}' or MD5 == '${INDICATOR_PLACEHOLDER}'
| project Timestamp, DeviceName, FileName, ProcessCommandLine, SHA256, AccountName
| take 100`,
      },
      {
        name: 'Defender image loads',
        target: 'defender',
        kql: `DeviceImageLoadEvents
| where Timestamp > ago(${DAYS})
| where SHA256 == '${INDICATOR_PLACEHOLDER}' or SHA1 == '${INDICATOR_PLACEHOLDER}' or MD5 == '${INDICATOR_PLACEHOLDER}'
| project Timestamp, DeviceName, FileName, FolderPath, SHA256, InitiatingProcessFileName
| take 100`,
      },
      {
        name: 'Sentinel workspace search',
        target: 'sentinel',
        kql: `search '${INDICATOR_PLACEHOLDER}'
| where TimeGenerated > ago(${DAYS})
| take 100`,
      },
    ],
  },
]

export function builtinPlaybook(id: string) {
  return BUILTIN_PLAYBOOKS.find((playbook) => playbook.id === id) ?? null
}
