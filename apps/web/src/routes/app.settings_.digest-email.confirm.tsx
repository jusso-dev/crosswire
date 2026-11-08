import { Link, createFileRoute, useRouter } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import { confirmDigestEmailFn, previewDigestEmailFn } from '../fns/settings'
import { Notice, PageHead } from '../components/ui'

/**
 * Confirm a digest email address (#102). The /app layout guard sends signed-out visitors to sign
 * in with this URL as returnTo. Opening the link only shows what will change; the signed-in owner
 * confirms with a button, so mail scanners that fetch links cannot confirm on their behalf.
 */
export const Route = createFileRoute('/app/settings_/digest-email/confirm')({
  validateSearch: z.object({ token: z.string().max(200).optional() }),
  loaderDeps: ({ search }) => ({ token: search.token ?? '' }),
  loader: ({ deps }) => previewDigestEmailFn({ data: { token: deps.token } }),
  // The token is in the URL: never send it on as a Referer.
  head: () => ({ meta: [{ title: 'Confirm digest email · Crosswire' }, { name: 'referrer', content: 'no-referrer' }] }),
  pendingComponent: () => <p className="cw-muted">Checking your link…</p>,
  errorComponent: ({ error }) => (
    <Notice tone="error" title="Could not check this link">
      {error instanceof Error ? error.message : String(error)}
    </Notice>
  ),
  component: ConfirmDigestEmail,
})

const CRUMBS = [{ label: 'Settings', to: '/app/settings' }, { label: 'Confirm digest email' }]

function ConfirmDigestEmail() {
  const preview = Route.useLoaderData()
  const { token } = Route.useSearch()
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmed, setConfirmed] = useState<string | null>(null)
  const doneRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (confirmed) doneRef.current?.focus()
  }, [confirmed])

  if (confirmed)
    return (
      <>
        <PageHead title="Digest email confirmed" crumbs={CRUMBS} />
        <div ref={doneRef} tabIndex={-1}>
          <Notice tone="ok" title="Address confirmed">
            Daily digest email for this organisation now goes to <strong>{confirmed}</strong>.
          </Notice>
        </div>
        <p>
          <Link to="/app/settings" hash="digest-email">
            Back to Settings
          </Link>
        </p>
      </>
    )

  if (preview.status !== 'ready')
    return (
      <>
        <PageHead title="Confirm digest email" crumbs={CRUMBS} />
        <Notice tone="error" title={preview.status === 'expired' ? 'Link expired' : 'Link not valid'}>
          {preview.message}
        </Notice>
        <p>
          <Link to="/app/settings" hash="digest-email">
            Go to Settings
          </Link>
        </p>
      </>
    )

  const confirm = async () => {
    setBusy(true)
    setError(null)
    try {
      const r = await confirmDigestEmailFn({ data: { token: token ?? '' } })
      if (r.ok) {
        setConfirmed(r.result.email)
        // The token is now spent; refresh cached loaders (Settings shows the new address).
        void router.invalidate()
      } else setError(r.error)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <PageHead title="Confirm digest email" crumbs={CRUMBS} />
      <p>
        Send the daily digest email for <strong>{preview.orgName}</strong> to <strong>{preview.email}</strong>?
      </p>
      <p className="cw-muted">Your sign-in email does not change. You can switch back to it in Settings at any time.</p>
      {error && (
        <Notice tone="error" title="Not confirmed">
          {error}
        </Notice>
      )}
      <div className="cw-row">
        <button type="button" className="cw-btn" disabled={busy} onClick={confirm}>
          {busy ? 'Confirming…' : 'Confirm address'}
        </button>
        <Link className="cw-btn" data-variant="ghost" to="/app/settings" hash="digest-email">
          Cancel
        </Link>
      </div>
    </>
  )
}
