import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { Wordmark } from '../components/ui'

const MESSAGES: Record<string, string> = {
  unknown_tenant: 'Your Microsoft Entra tenant is not connected to this Crosswire installation. Ask an administrator to add your tenant (docs/auth.md).',
  UNKNOWN_TENANT: 'Your Microsoft Entra tenant is not connected to this Crosswire installation. Ask an administrator to add your tenant (docs/auth.md).',
  access_denied: 'Sign-in was cancelled or consent was not granted.',
  consent_required: 'Your administrator needs to grant consent for the Crosswire app in Entra ID.',
  invalid_code: 'The sign-in link expired. Try again.',
  email_not_found: 'Your Microsoft account did not provide an email address.',
}

/** Readable SSO failure page (#19); never shows stack traces or raw provider payloads. */
export const Route = createFileRoute('/auth-error')({
  validateSearch: z.object({ error: z.string().optional(), error_description: z.string().optional() }),
  component: AuthError,
})

function AuthError() {
  {
    const { error } = Route.useSearch()
    const message = (error && MESSAGES[error]) ?? 'Sign-in failed. Try again, or contact your administrator.'
    return (
      <main className="cw-center">
        <Wordmark />
        <h1 style={{ marginTop: 'var(--space-xl)' }}>We couldn't sign you in</h1>
        <p>{message}</p>
        {error && <p className="cw-muted">If you contact your administrator, quote this code: {error.replace(/[^\w-]/g, '').slice(0, 64)}</p>}
        <a href="/sign-in" className="cw-btn">
          Back to sign-in
        </a>
      </main>
    )
  }
}
