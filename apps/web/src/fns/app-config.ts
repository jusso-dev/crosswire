import { createServerFn } from '@tanstack/react-start'

/** Public, non-secret display settings the UI needs before sign-in (time zone for every timestamp). */
export const fetchAppConfig = createServerFn({ method: 'GET' }).handler(async () => {
  const { env } = await import('../server/env')
  return { timeZone: env().APP_TIMEZONE }
})
