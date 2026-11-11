/**
 * What the sign-in page says after Better Auth answers. Pure, so it can be tested without a browser.
 *
 * Better Auth 1.7.18 (api/routes/sign-up.mjs): with this app's settings (autoSignIn on, no email
 * verification) a duplicate address throws USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL (HTTP 422). With
 * verification on or autoSignIn off it instead returns a synthetic user with `token: null`, exactly
 * like a new address that has no session yet. Both must read the same, so neither tells a visitor
 * whether an address is registered. Only password rules get a specific message.
 */

export const SIGN_UP_NEUTRAL = "If this address can be used, you can now sign in. Otherwise, try signing in or ask your organisation's owner."
export const SIGN_IN_FAILED = 'Invalid email or password.'
export const TOO_MANY = 'Too many attempts. Wait a minute, then try again.'
export const MIN_PASSWORD = 12

export interface AuthError {
  code?: string
  message?: string
  status?: number
}

export type AuthOutcome = { kind: 'signed-in' } | { kind: 'message'; text: string; field?: 'password' | 'email' }

/** Sign-up result: a session means go in; anything else is either a password rule or the neutral message. */
export function signUpOutcome(res: { data?: { token?: string | null } | null; error?: AuthError | null }): AuthOutcome {
  const e = res.error
  if (!e) return res.data?.token ? { kind: 'signed-in' } : { kind: 'message', text: SIGN_UP_NEUTRAL }
  if (e.status === 429) return { kind: 'message', text: TOO_MANY }
  switch (e.code) {
    case 'PASSWORD_TOO_SHORT':
      return { kind: 'message', text: `Use at least ${MIN_PASSWORD} characters for your password.`, field: 'password' }
    case 'PASSWORD_TOO_LONG':
      return { kind: 'message', text: 'Use 128 characters or fewer for your password.', field: 'password' }
    case 'INVALID_EMAIL':
      return { kind: 'message', text: 'Enter an email address, for example name@example.com.', field: 'email' }
    // Says only that the domain belongs to a Microsoft tenant, not whether the address is registered (#203).
    case 'DOMAIN_USES_ENTRA':
      return { kind: 'message', text: 'Addresses in this domain sign in with Microsoft. Use "Sign in with Microsoft" instead.', field: 'email' }
    default:
      // Already registered, could not create, or anything unexpected: one neutral sentence.
      return { kind: 'message', text: SIGN_UP_NEUTRAL }
  }
}

/** Sign-in result: one generic failure, so a wrong password and an unknown address read the same. */
export function signInOutcome(res: { error?: AuthError | null }): AuthOutcome {
  const e = res.error
  if (!e) return { kind: 'signed-in' }
  if (e.status === 429) return { kind: 'message', text: TOO_MANY }
  return { kind: 'message', text: SIGN_IN_FAILED }
}
