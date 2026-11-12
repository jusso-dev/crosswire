import { createServerFn } from '@tanstack/react-start'
import { getCookie } from '@tanstack/react-start/server'
import { isTimeZone, TIME_ZONE_COOKIE } from '../shared/timezone'

/**
 * Public, non-secret display settings the UI needs before sign-in. `timeZone` is the zone every
 * timestamp is shown in: the person's own choice (cookie, #161) when it is a valid zone, else
 * APP_TIMEZONE. `defaultTimeZone` is APP_TIMEZONE, the organisation day that digests and the hits chart use.
 */
export const fetchAppConfig = createServerFn({ method: 'GET' }).handler(async () => {
  const { env } = await import('../server/env')
  const defaultTimeZone = env().APP_TIMEZONE
  const raw = getCookie(TIME_ZONE_COOKIE)
  const preference = isTimeZone(raw) ? raw : null
  return { timeZone: preference ?? defaultTimeZone, defaultTimeZone, preference }
})
