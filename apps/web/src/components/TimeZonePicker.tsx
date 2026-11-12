import { useRouter } from '@tanstack/react-router'
import { useEffect, useId, useMemo, useState } from 'react'
import { allTimeZones, TIME_ZONE_COOKIE, timeZoneLabel } from '../shared/timezone'

/** The empty value means "no preference": follow the organisation default (APP_TIMEZONE). */
const DEFAULT = ''

function browserTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null
  } catch {
    return null
  }
}

function saveChoice(tz: string) {
  const secure = location.protocol === 'https:' ? '; secure' : ''
  document.cookie =
    tz === DEFAULT ? `${TIME_ZONE_COOKIE}=; path=/; max-age=0; samesite=lax${secure}` : `${TIME_ZONE_COOKIE}=${encodeURIComponent(tz)}; path=/; max-age=31536000; samesite=lax${secure}`
}

/**
 * Display time zone choice (#161), per browser, beside the theme select so it is visible at every
 * width. UTC is always the second option. The browser's own zone and the full IANA list are added
 * after hydration, because the server cannot know them. The choice is a cookie so the next server
 * render is already right; changing it reloads route data so every time on the page is redrawn.
 */
export function TimeZonePicker({ preference, defaultTimeZone }: { preference: string | null; defaultTimeZone: string }) {
  const router = useRouter()
  const [extra, setExtra] = useState<{ device: string | null; all: string[] }>({ device: null, all: [] })
  const [saving, setSaving] = useState(false)
  const hintId = useId()
  useEffect(() => {
    // Browser-only lists, read once after hydration.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setExtra({ device: browserTimeZone(), all: allTimeZones() })
  }, [])
  const value = preference ?? DEFAULT
  const pinned = new Set([DEFAULT, 'UTC', extra.device, preference].filter((z): z is string => z !== null))
  // About 400 zones: label them once, not on every header render.
  const rest = useMemo(() => extra.all.map((z) => [z, timeZoneLabel(z)] as const), [extra.all]).filter(([z]) => !pinned.has(z))
  return (
    <label className="cw-theme cw-tzpick">
      <span>Time zone</span>
      <select
        value={value}
        disabled={saving}
        aria-describedby={hintId}
        onChange={async (e) => {
          saveChoice(e.target.value)
          setSaving(true)
          try {
            await router.invalidate()
          } finally {
            setSaving(false)
          }
        }}
      >
        <option value={DEFAULT}>Organisation default: {timeZoneLabel(defaultTimeZone)}</option>
        <option value="UTC">UTC</option>
        {extra.device && extra.device !== 'UTC' && <option value={extra.device}>This device: {timeZoneLabel(extra.device)}</option>}
        {preference && preference !== 'UTC' && preference !== extra.device && <option value={preference}>{timeZoneLabel(preference)}</option>}
        {rest.length > 0 && (
          <optgroup label="All time zones">
            {rest.map(([z, label]) => (
              <option key={z} value={z}>
                {label}
              </option>
            ))}
          </optgroup>
        )}
      </select>
      <span id={hintId} className="cw-sr-only">
        Changes how times are shown for you in this browser. Daily digests and the hits chart still use the organisation day.
      </span>
    </label>
  )
}
