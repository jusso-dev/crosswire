import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { z } from 'zod'
import { authClient } from '../lib/auth-client'
import { fetchAuthConfig, fetchSession } from '../fns/session'
import { Wordmark } from '../components/ui'
import { pageTitle } from '../components/errors'

function safeReturnTo(value: unknown) {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\') ? value : '/app'
}

export const Route = createFileRoute('/sign-in')({
  validateSearch: z.object({ returnTo: z.string().optional(), error: z.string().optional() }),
  beforeLoad: async ({ search }) => {
    if (await fetchSession()) throw redirect({ href: safeReturnTo(search.returnTo) })
  },
  loader: () => fetchAuthConfig(),
  head: () => ({ meta: [{ title: pageTitle('Sign in') }] }),
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
    <main className="cw-auth">
      <section className="cw-auth-panel" aria-labelledby="signin-title">
        <Wordmark tagline="Analyst workspace" />
        <h1 id="signin-title">{mode === 'in' ? 'Sign in to Crosswire' : 'Create your account'}</h1>
        <p className="cw-muted cw-maxw-380">
          One place to watch threat feeds, investigate in Microsoft Defender and Sentinel, and approve every response before it happens.
        </p>
        {config.entra && (
          <p className="cw-mt-md">
            <button
              className="cw-btn cw-maxw-380"
              data-size="lg"
              data-block
              type="button"
             
              onClick={() => authClient.signIn.social({ provider: 'microsoft', callbackURL: target, errorCallbackURL: '/auth-error' })}
            >
              Sign in with Microsoft
            </button>
          </p>
        )}
        {config.entra && config.emailPassword && <div className="cw-divider">or use email</div>}
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
            <input name="password" type="password" required minLength={12} autoComplete={mode === 'in' ? 'current-password' : 'new-password'} aria-describedby="pw-help" aria-invalid={error ? true : undefined} />
            <span id="pw-help" className="cw-help">
              At least 12 characters.
            </span>
          </label>
          {error && (
            <p className="cw-field-error" role="alert">
              {error}
            </p>
          )}
          <div className="cw-row">
            <button className="cw-btn" type="submit" disabled={busy}>
              {busy ? (mode === 'in' ? 'Signing in…' : 'Creating account…') : mode === 'in' ? 'Sign in' : 'Create account'}
            </button>
            <button className="cw-btn" data-variant="ghost" type="button" onClick={() => setMode(mode === 'in' ? 'up' : 'in')}>
              {mode === 'in' ? 'Create an account' : 'I have an account'}
            </button>
          </div>
        </form>
      )}
        {!config.emailPassword && !config.entra && (
          <p className="cw-field-error" role="alert">
            No sign-in method is configured. Ask your administrator (see docs/auth.md).
          </p>
        )}
      </section>
      <WiringArt />
    </main>
  )
}

/** Tier-B hand-built SVG: three feeds cross at one junction (your org). Static; no motion. */
function WiringArt() {
  return (
    <aside className="cw-auth-art" aria-label="How Crosswire works">
      <svg viewBox="0 0 520 300" role="img" aria-label="Threat feeds and Microsoft security data crossing at your organisation">
        <text className="lbl" x="0" y="18">
          SOURCES
        </text>
        <text className="lbl" x="520" y="18" textAnchor="end">
          YOUR ORG
        </text>
        <rect className="n-src" x="0" y="40" width="132" height="34" rx="6" />
        <text className="src" x="14" y="62">
          pwn.watch
        </text>
        <rect className="n-src" x="0" y="133" width="132" height="34" rx="6" />
        <text className="src" x="14" y="155">
          CISA KEV
        </text>
        <rect className="n-src" x="0" y="226" width="132" height="34" rx="6" />
        <text className="src" x="14" y="248">
          Defender XDR
        </text>
        <path className="w" d="M132 57 C 250 57, 250 243, 380 243" />
        <path className="w" d="M132 243 C 250 243, 250 57, 380 57" />
        <path className="w-hot" d="M132 57 C 230 57, 260 150, 330 150" />
        <path className="w-hot" d="M132 150 L 330 150" />
        <path className="w-hot" d="M132 243 C 230 243, 260 150, 330 150" />
        <path className="w-hot" d="M354 150 L 440 150" />
        <circle className="n" cx="342" cy="150" r="12" />
        <circle className="core" cx="342" cy="150" r="4" />
        <rect className="n-src" x="440" y="133" width="80" height="34" rx="6" />
        <text className="src" x="480" y="155" textAnchor="middle">
          you
        </text>
        <text className="lbl" x="342" y="186" textAnchor="middle">
          CROSSWIRE
        </text>
      </svg>
      <h2>Where the feeds cross your organisation.</h2>
      <p>Crosswire matches world threat intel against what you run, lets AI agents draft the investigation, and waits for a person to approve anything that changes your tenant.</p>
    </aside>
  )
}
