import { useRouter } from '@tanstack/react-router'
import { useId, useState, type ReactNode } from 'react'
import { useAction } from '../../components/action'
import { Notice } from '../../components/ui'

export function Section({ id, title, intro, children }: { id: string; title: string; intro: string; children: ReactNode }) {
  return (
    <section id={id} className="cw-panel2 cw-anchor" aria-labelledby={`${id}-title`}>
      <div className="cw-panel2-head cw-stack-tight">
        <h2 id={`${id}-title`}>{title}</h2>
        <p className="cw-muted cw-m0">{intro}</p>
      </div>
      <div className="cw-panel2-body">{children}</div>
    </section>
  )
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: (props: { id: string; 'aria-describedby'?: string }) => ReactNode }) {
  const id = useId()
  const hintId = useId()
  return (
    <div className="cw-field">
      <label htmlFor={id}>{label}</label>
      {hint && (
        <p id={hintId} className="cw-help cw-m0">
          {hint}
        </p>
      )}
      {children({ id, 'aria-describedby': hint ? hintId : undefined })}
    </div>
  )
}

function refused(r: unknown) {
  return typeof r === 'object' && r !== null && 'ok' in r && (r as { ok: unknown }).ok === false
}

/**
 * Submit state for a settings form, built on `useAction`: one request at a time, `busy` names the
 * pressed control, errors are plain words, and a polite success message. After a successful save
 * the form is reset, so typed secrets do not stay in the page, and the loader data is refreshed.
 */
export function useSave() {
  const router = useRouter()
  const { run, busy, error, setError } = useAction()
  const [done, setDone] = useState<string | null>(null)
  const save = async (label: string, fn: () => Promise<unknown>, okMsg: string, form?: HTMLFormElement | null) => {
    setDone(null)
    const r = await run(label, async () => (await fn()) ?? { ok: true })
    if (r === undefined || refused(r)) return false
    form?.reset()
    setDone(okMsg)
    await router.invalidate()
    return true
  }
  const feedback = (
    <>
      {error && (
        <Notice tone="error" title="Not saved">
          {error}
        </Notice>
      )}
      <p className="cw-help" role="status">
        {done ?? ''}
      </p>
    </>
  )
  return { busy, save, error, setError, feedback }
}

export const ROLE_LABEL: Record<string, string> = { owner: 'Owner', approver: 'Approver', analyst: 'Analyst' }
