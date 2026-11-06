import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { z } from 'zod'
import { authClient } from '../lib/auth-client'
import { fetchAuthConfig, fetchSession } from '../fns/session'

function safeReturnTo(value: unknown) {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\') ? value : '/app'
}

export const Route = createFileRoute('/sign-in')({
  validateSearch: z.object({ returnTo: z.string().optional(), error: z.string().optional() }),
  beforeLoad: async ({ search }) => {
    if (await fetchSession()) throw redirect({ href: safeReturnTo(search.returnTo) })
  },
  loader: () => fetchAuthConfig(),
  component: SignIn,
})

function SignIn() {
  const config = Route.useLoaderData()
  const { returnTo, error: initialError } = Route.useSearch()
  const navigate = useNavigate()
  const [mode, setMode] = useState<'in' | 'up'>('in')
  const [error, setError] = useState<string | null>(initialError ? 'Sign-in failed. Try again or contact your administrator.' : null)
  const [busy, setBusy] = useState(false)
  const target = safeReturnTo(returnTo)

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    const email = String(form.get('email') ?? '')
    const password = String(form.get('password') ?? '')
    setBusy(true)
    setError(null)
    const res =
      mode === 'in'
        ? await authClient.signIn.email({ email, password })
        : await authClient.signUp.email({ email, password, name: String(form.get('name') ?? '') || email.split('@')[0]! })
    setBusy(false)
    // Generic message: no user enumeration.
    if (res.error) return setError(mode === 'in' ? 'Invalid email or password.' : (res.error.message ?? 'Could not create the account.'))
    await navigate({ href: target })
  }

  return (
    <main className="cw-content" style={{ maxWidth: 420, margin: '10vh auto' }}>
      <h1>Crosswire</h1>
      <p className="cw-muted">Open-source SOC kit. Sign in to continue.</p>
      {config.entra && (
        <p>
          <button
            className="cw-btn"
            type="button"
            onClick={() => authClient.signIn.social({ provider: 'microsoft', callbackURL: target, errorCallbackURL: '/auth-error' })}
          >
            Sign in with Microsoft
          </button>
        </p>
      )}
      {config.emailPassword && (
        <form className="cw-form" onSubmit={onSubmit} aria-label={mode === 'in' ? 'Sign in' : 'Create account'}>
          {mode === 'up' && (
            <label>
              Name
              <input name="name" autoComplete="name" />
            </label>
          )}
          <label>
            Email
            <input name="email" type="email" required autoComplete="email" />
          </label>
          <label>
            Password
            <input name="password" type="password" required minLength={12} autoComplete={mode === 'in' ? 'current-password' : 'new-password'} />
          </label>
          {error && (
            <p className="cw-error" role="alert">
              {error}
            </p>
          )}
          <div className="cw-row">
            <button className="cw-btn" type="submit" disabled={busy}>
              {mode === 'in' ? 'Sign in' : 'Create account'}
            </button>
            <button className="cw-btn" data-variant="ghost" type="button" onClick={() => setMode(mode === 'in' ? 'up' : 'in')}>
              {mode === 'in' ? 'Create an account' : 'I have an account'}
            </button>
          </div>
        </form>
      )}
      {!config.emailPassword && !config.entra && <p className="cw-error">No sign-in method is configured. See docs/auth.md.</p>}
    </main>
  )
}
