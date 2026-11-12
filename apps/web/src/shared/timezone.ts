/**
 * Display time zone preference (#161). Pure, safe in client and server code.
 *
 * The deployment default is APP_TIMEZONE. Each person can choose UTC, their browser's zone or any
 * IANA zone. The choice is a cookie, not localStorage, so the server renders the chosen zone on the
 * first paint. It is a display setting only: storage, digests and budgets stay as they are.
 */
export const TIME_ZONE_COOKIE = 'cw-tz'

export function isTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false
  try {
    new Intl.DateTimeFormat('en-AU', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/** The zone to display: a valid preference, else the deployment default. */
export function resolveTimeZone(preference: string | null | undefined, fallback: string) {
  return isTimeZone(preference) ? preference : fallback
}

/** Read the preference from a raw Cookie header. Invalid or missing values give null. */
export function timeZoneFromCookieHeader(header: string | null | undefined) {
  if (!header) return null
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k !== TIME_ZONE_COOKIE) continue
    try {
      const value = decodeURIComponent(v.join('='))
      return isTimeZone(value) ? value : null
    } catch {
      return null
    }
  }
  return null
}

/** "Australia/Perth (UTC+8)". Falls back to the plain name when the offset cannot be read. */
export function timeZoneLabel(tz: string, at = new Date()) {
  if (tz === 'UTC') return 'UTC'
  const name = tz.replaceAll('_', ' ')
  try {
    const offset = new Intl.DateTimeFormat('en-AU', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(at).find((p) => p.type === 'timeZoneName')?.value
    return offset ? `${name} (${offset.replace('GMT', 'UTC')})` : name
  } catch {
    return name
  }
}

/** Every zone this runtime knows, UTC first. Call in the browser only: server and browser lists can differ. */
export function allTimeZones() {
  const list = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : []
  return ['UTC', ...list.filter((z) => z !== 'UTC' && z !== 'Etc/UTC')]
}
