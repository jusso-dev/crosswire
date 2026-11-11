import { useRouter } from '@tanstack/react-router'
import { useId, useState, type FormEvent } from 'react'
import { clearDigestEmailFn, fetchDigestEmail, requestDigestEmailFn } from '../../fns/settings'
import { useAction } from '../../components/action'
import { fmtTime } from '../../components/format'
import { Notice } from '../../components/ui'
import { Field } from './shared'

type DigestEmailData = Extract<Awaited<ReturnType<typeof fetchDigestEmail>>, { allowed: true }>

/** Digest email address (#102): confirmed by a link sent to the new address. Owners only. */
export function DigestEmail({ data }: { data: DigestEmailData }) {
  const router = useRouter()
  const errId = useId()
  const send = useAction()
  const remove = useAction()
  const [done, setDone] = useState<string | null>(null)
  const current = data.digestEmail ?? data.signInEmail
  const busy = Boolean(send.busy || remove.busy)

  const onSend = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const form = e.currentTarget
    const email = String(new FormData(form).get('email') ?? '').trim()
    setDone(null)
    remove.setError(null)
    const r = await send.run('send', () => requestDigestEmailFn({ data: { email } }))
    if (!r?.ok) return
    form.reset()
    setDone(`Confirmation link sent to ${r.result.pending}.`)
    await router.invalidate()
  }

  const onRemove = async () => {
    setDone(null)
    send.setError(null)
    const r = await remove.run('remove', () => clearDigestEmailFn())
    if (!r?.ok) return
    setDone(`Digests go to your sign-in email, ${data.signInEmail}, again.`)
    await router.invalidate()
  }

  return (
    <>
      <p className="cw-mt0">
        Digests go to <strong>{current}</strong>
        {data.digestEmail ? ' (confirmed contact address).' : ' (your sign-in email).'}
      </p>
      {!data.digestEmail && data.signInMayBeUpn && (
        <Notice tone="warn" title="Your sign-in email may not receive mail">
          It came from your Microsoft sign-in name, which may have no mailbox. If digests do not arrive, add a contact address below.
        </Notice>
      )}
      {!data.smtp && (
        <Notice tone="info" title="Email is not set up">
          This Crosswire server has no SMTP settings, so digests are not emailed and a new address cannot be confirmed yet. Digests are still on the Daily digests page.
        </Notice>
      )}
      {data.pending && (
        <Notice tone="info" title="Waiting for confirmation">
          Check <strong>{data.pending.email}</strong> for a confirmation link. It expires in 24 hours ({fmtTime(data.pending.expiresAt)}). Open it while signed in to Crosswire as yourself.
        </Notice>
      )}
      <form className="cw-form" onSubmit={onSend} noValidate>
        <Field label={data.digestEmail || data.pending ? 'New digest email address' : 'Digest email address'} hint="We email a confirmation link to this address. Digests only go there after you open the link.">
          {(p) => (
            <input
              {...p}
              name="email"
              type="email"
              autoComplete="email"
              inputMode="email"
              maxLength={254}
              required
              aria-invalid={send.error ? true : undefined}
              aria-describedby={[p['aria-describedby'], send.error ? errId : undefined].filter(Boolean).join(' ') || undefined}
            />
          )}
        </Field>
        {send.error && (
          <p id={errId} className="cw-field-error" role="alert">
            {send.error}
          </p>
        )}
        <div className="cw-row">
          <button className="cw-btn" type="submit" disabled={busy} aria-busy={Boolean(send.busy) || undefined}>
            {send.busy ? 'Sending…' : 'Send confirmation link'}
          </button>
          {(data.digestEmail || data.pending) && (
            <button type="button" className="cw-btn" data-variant="ghost" disabled={busy} aria-busy={Boolean(remove.busy) || undefined} onClick={() => void onRemove()}>
              {remove.busy ? 'Working…' : 'Remove'}
              <span className="cw-sr-only"> digest address and use your sign-in email</span>
            </button>
          )}
        </div>
        {remove.error && (
          <Notice tone="error" title="Not removed">
            {remove.error}
          </Notice>
        )}
        <p className="cw-help cw-m0" role="status">
          {done ?? ''}
        </p>
      </form>
    </>
  )
}
