import { createAuthClient } from 'better-auth/react'

/** Browser auth client. Same-origin; cookies are httpOnly and set by the server. */
export const authClient = createAuthClient()
