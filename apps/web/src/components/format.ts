/** Display zone for every timestamp in the UI. Storage is always UTC; the server sets this from APP_TIMEZONE. */
let displayTimeZone = 'Australia/Sydney'

export function setDisplayTimeZone(tz: string) {
  displayTimeZone = tz
}

export function getDisplayTimeZone() {
  return displayTimeZone
}

export function fmtTime(iso: string | Date | null | undefined) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('en-AU', { dateStyle: 'medium', timeStyle: 'short', timeZone: displayTimeZone })
}

/** Short relative time ("5 min ago", "3 days ago"); falls back to the date after a week. */
export function fmtAgo(iso: string | Date | null | undefined, now = Date.now()) {
  if (!iso) return '—'
  const t = new Date(iso).getTime()
  const mins = Math.round((now - t) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs} h ago`
  const days = Math.round(hrs / 24)
  if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`
  return new Date(iso).toLocaleDateString('en-AU', { dateStyle: 'medium', timeZone: displayTimeZone })
}

export function statusTone(status: string): 'ok' | 'warn' | 'danger' | undefined {
  if (['approved', 'executed', 'run', 'success', 'open'].includes(status)) return 'ok'
  if (['pending', 'proposed', 'dry-run'].includes(status)) return 'warn'
  if (['rejected', 'failed', 'expired', 'failure'].includes(status)) return 'danger'
  return undefined
}
