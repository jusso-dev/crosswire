import { useEffect, useId, useRef, type ReactNode } from 'react'

/**
 * Confirmation for anything that changes data or a tenant. A native modal <dialog>, so:
 * - focus is held inside it and the page behind is inert;
 * - Escape cancels (unless a request is running);
 * - the global shortcut guard (`dialog[open]`) sees it, so no shortcut fires while it is open.
 * Focus lands on Cancel, never on the destructive choice, and returns to whatever opened it.
 * The body must name the target ("Remove the watch Fortinet?"), not just the verb.
 */
export function ConfirmDialog({
  open,
  tone = 'accent',
  title,
  body,
  confirmLabel,
  cancelLabel = 'Cancel',
  busy = false,
  error,
  onCancel,
  onConfirm,
  children,
}: {
  open: boolean
  tone?: 'accent' | 'danger'
  title: string
  body: ReactNode
  confirmLabel: string
  cancelLabel?: string
  busy?: boolean
  error?: string | null
  onCancel: () => void
  onConfirm: () => void
  children?: ReactNode
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  const opener = useRef<HTMLElement | null>(null)
  const titleId = useId()
  const bodyId = useId()

  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      if (typeof d.showModal === 'function') d.showModal()
      else d.setAttribute('open', '')
      cancel.current?.focus()
    } else if (!open && d.open) {
      d.close()
    }
  }, [open])

  // Return focus to the control that opened the dialog once it closes or unmounts.
  useEffect(() => {
    if (open) return
    const el = opener.current
    opener.current = null
    if (el && el.isConnected) el.focus()
  }, [open])

  return (
    <dialog
      ref={ref}
      className="cw-dialog cw-confirm"
      data-tone={tone}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      onCancel={(e) => {
        e.preventDefault()
        if (!busy) onCancel()
      }}
    >
      <div className="cw-confirm-inner">
        <p id={titleId} className="cw-confirm-title">
          {title}
        </p>
        <div id={bodyId} className="cw-confirm-body">
          {body}
        </div>
        {children}
        {error && (
          <p className="cw-confirm-error" role="alert">
            {error}
          </p>
        )}
        <div className="cw-row cw-confirm-actions">
          <button ref={cancel} type="button" className="cw-btn" data-variant="ghost" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </button>
          <button type="button" className="cw-btn" data-variant={tone === 'danger' ? 'danger' : undefined} onClick={onConfirm} disabled={busy} aria-busy={busy || undefined}>
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  )
}
