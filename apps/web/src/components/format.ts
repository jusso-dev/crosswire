/** Display zone for every timestamp in the UI. Storage is always UTC; the server sets this from APP_TIMEZONE. */
let displayTimeZone = 'Australia/Sydney'

export function setDisplayTimeZone(tz: string) {
  displayTimeZone = tz
}

export function getDisplayTimeZone() {
  return displayTimeZone
}

/** Shown when a value is missing. House style has no em dashes. */
export const EMPTY_VALUE = 'Not recorded'

/** Date and time with the zone name ("8 Nov 2026, 1:30 am AEDT"), so a screenshot is never ambiguous. */
export function fmtTime(iso: string | Date | null | undefined) {
  if (!iso) return EMPTY_VALUE
  return new Date(iso).toLocaleString('en-AU', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short', timeZone: displayTimeZone })
}

/** Date and time to the second, with the zone name. Use for audit trails, events and run steps. */
export function fmtTimeExact(iso: string | Date | null | undefined) {
  if (!iso) return EMPTY_VALUE
  return new Date(iso).toLocaleString('en-AU', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short', timeZone: displayTimeZone })
}

/** Short relative time ("5 min ago", "3 days ago"); falls back to the date after a week. */
export function fmtAgo(iso: string | Date | null | undefined, now = Date.now()) {
  if (!iso) return EMPTY_VALUE
  const t = new Date(iso).getTime()
  // Round down, so 59.5 minutes reads "59 min ago", never "60 min ago".
  const mins = Math.floor((now - t) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs} h ago`
  const days = Math.floor(hrs / 24)
  if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`
  return new Date(iso).toLocaleDateString('en-AU', { dateStyle: 'medium', timeZone: displayTimeZone })
}

/** "1 row", "3 rows", "1 day", "2 days". Pass the plural form when it is not just "s". */
export function plural(n: number, one: string, many = `${one}s`) {
  return `${n.toLocaleString('en-AU')} ${n === 1 ? one : many}`
}

/** Turn a stored key ("graph_containment", "dry-run") into plain words ("graph containment"). Every separator, not just the first. */
export function humanise(key: string) {
  return key.replaceAll('_', ' ').replaceAll('-', ' ')
}

/** Model spend is priced in US dollars. Always say so. */
export function fmtUsd(micros: number, digits = 2) {
  return `US$${(micros / 1_000_000).toFixed(digits)}`
}

/** Midnight UTC, the daily budget reset, in the display zone ("11:00 am AEDT"). */
export function utcMidnightLocal(now = new Date()) {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1))
  return next.toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit', timeZoneName: 'short', timeZone: displayTimeZone })
}
