import { fmtAgo, fmtTime } from './format'
import { statusWord } from '../shared/labels'

/**
 * State primitives. Each axis has its own shape so they never blur together:
 * severity = glyph + word, freshness = clock + age, data mode = DEMO/LIVE tag, status = outlined tag.
 * Missing values say so: unknown is not safe and missing is not zero.
 */

const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const
export type Severity = (typeof SEVERITIES)[number] | 'unknown'

export function normaliseSeverity(raw: string | null | undefined): Severity {
  const s = (raw ?? '').toLowerCase().trim()
  return (SEVERITIES as readonly string[]).includes(s) ? (s as Severity) : 'unknown'
}

export function SeverityTag({ value }: { value: string | null | undefined }) {
  const sev = normaliseSeverity(value)
  return (
    <span className="cw-severity" data-sev={sev}>
      {sev === 'unknown' ? 'Unknown severity' : sev}
    </span>
  )
}

/**
 * Relative age, with the full time (zone included) inside the same <time> element so keyboard,
 * touch and screen reader users get it too, not only a mouse hover. Pass `now` from the loader so
 * the server and the browser render the same words. `staleAfterMs` turns it into an explicit warning.
 */
export function Freshness({ at, label, staleAfterMs, now }: { at: string | Date | null | undefined; label?: string; staleAfterMs?: number; now?: number }) {
  if (!at) {
    return (
      <span className="cw-fresh" data-state="missing">
        {label ? `${label} ` : ''}not recorded
      </span>
    )
  }
  const stale = staleAfterMs !== undefined && now !== undefined && now - new Date(at).getTime() > staleAfterMs
  const exact = fmtTime(at)
  return (
    <time className="cw-fresh" data-state={stale ? 'stale' : 'fresh'} dateTime={new Date(at).toISOString()} title={exact}>
      {stale ? 'stale · ' : ''}
      {label ? `${label} ` : ''}
      {fmtAgo(at, now)}
      <span className="cw-sr-only"> ({exact})</span>
    </time>
  )
}

/** Where results came from. Demo fixtures are labelled at the result, never only in a banner. */
export function ModeTag({ mode }: { mode: string | null | undefined }) {
  if (mode === 'live') return <span className="cw-badge" data-tone="ok">Live data</span>
  if (mode === 'dry-run')
    return (
      <span className="cw-badge" data-tone="info" title="Planned only. Nothing was sent to your tenant.">
        Dry run
      </span>
    )
  if (mode === 'demo')
    return (
      <span className="cw-badge" data-tone="demo" title="Synthetic fixture rows for development and demos. Not from your tenant.">
        Demo data
      </span>
    )
  return <span className="cw-badge">Source unknown</span>
}

const STATUS_TONE: Record<string, 'ok' | 'warn' | 'danger' | 'info' | undefined> = {
  run: 'ok',
  approved: 'info',
  executed: 'ok',
  open: 'info',
  proposed: 'warn',
  pending: 'warn',
  'dry-run': 'warn',
  failed: 'danger',
  rejected: 'danger',
  expired: undefined,
  closed: undefined,
}

export function StatusTag({ status }: { status: string }) {
  return (
    <span className="cw-badge" data-tone={STATUS_TONE[status]}>
      {statusWord(status)}
    </span>
  )
}

export const TARGET_LABEL: Record<string, string> = { defender: 'Defender XDR', sentinel: 'Sentinel' }
