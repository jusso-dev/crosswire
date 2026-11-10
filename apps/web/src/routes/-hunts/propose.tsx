import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from '@tanstack/react-router'
import { proposeKqlFn } from '../../fns/hunts'
import { Notice } from '../../components/ui'
import { useAction } from '../../components/action'
import { Disclosure } from './disclosure'

export type Draft = { kql: string; target: 'defender' | 'sentinel' }

/**
 * Propose a new search. A draft (from "Edit as new search" or a row pivot) opens the form and fills
 * it, in an effect keyed on that draft (#166), never from the render body. When the analyst has
 * already typed a query, the draft is offered instead of replacing their text.
 */
export function ProposeSearch({ huntId, draft, onDone }: { huntId: string; draft: Draft | null; onDone: () => void }) {
  const router = useRouter()
  const { run, busy, error } = useAction()
  const [target, setTarget] = useState<'defender' | 'sentinel'>(draft?.target ?? 'defender')
  const [kql, setKql] = useState(draft?.kql ?? '')
  const [open, setOpen] = useState(Boolean(draft))
  const [held, setHeld] = useState<Draft | null>(null)
  // True once the analyst has typed text of their own into the field.
  const typed = useRef(false)
  const applied = useRef<Draft | null>(draft)

  const applyDraft = useCallback((d: Draft) => {
    setKql(d.kql)
    setTarget(d.target)
    setHeld(null)
    typed.current = false
  }, [])

  useEffect(() => {
    if (!draft || applied.current === draft) return
    applied.current = draft
    // One explicit "draft this" request per draft object; a re-render never re-applies it.
    if (typed.current) setHeld(draft)
    else applyDraft(draft)
    setOpen(true)
    const frame = requestAnimationFrame(() => document.getElementById('new-kql')?.focus())
    return () => cancelAnimationFrame(frame)
  }, [draft, applyDraft])

  return (
    <Disclosure title="Propose a new search" open={open} onToggle={setOpen} extra={<span className="cw-muted">It will wait for review before it runs.</span>}>
      <form
        className="cw-panel2-body cw-form"
        data-wide
        onSubmit={(e) => {
          e.preventDefault()
          void run('propose', async () => {
            const r = await proposeKqlFn({ data: { huntId, target, kql } })
            if (r.ok) {
              setKql('')
              setHeld(null)
              typed.current = false
              onDone()
              await router.invalidate()
            }
            return r
          })
        }}
      >
        <label className="cw-maxw-320">
          Search in
          <select value={target} onChange={(e) => setTarget(e.target.value as 'defender' | 'sentinel')}>
            <option value="defender">Defender XDR (devices, email, identity)</option>
            <option value="sentinel">Sentinel (central log store)</option>
          </select>
        </label>
        <div>
          <label htmlFor="new-kql">KQL</label>
          <div className="cw-editor cw-mt-2xs">
            <textarea
              id="new-kql"
              className="mono"
              rows={5}
              value={kql}
              onChange={(e) => {
                typed.current = e.target.value.trim() !== ''
                setKql(e.target.value)
              }}
              required
              spellCheck={false}
              placeholder="DeviceProcessEvents | where Timestamp > ago(1d) | take 100"
            />
            <div className="cw-editor-bar">
              <span>Keep results small with “| take 100”. Crosswire caps rows and blocks external data and management commands.</span>
            </div>
          </div>
        </div>
        {held && (
          <Notice tone="info" title="Your query was kept">
            A new draft is ready, but you had already typed a query, so it was not replaced.{' '}
            <button type="button" className="cw-linkbtn" onClick={() => applyDraft(held)}>
              Use the new draft
            </button>{' '}
            <button type="button" className="cw-linkbtn" onClick={() => setHeld(null)}>
              Keep mine
            </button>
          </Notice>
        )}
        {error && (
          <Notice tone="error" title="Search not proposed">
            {error}
          </Notice>
        )}
        <div>
          <button className="cw-btn" type="submit" disabled={busy !== null || !kql.trim()} aria-busy={busy !== null || undefined}>
            {busy ? 'Proposing…' : 'Propose search'}
          </button>
        </div>
      </form>
    </Disclosure>
  )
}
