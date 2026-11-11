import { useId, type ReactNode } from 'react'

/**
 * A panel with a heading that opens and closes it (#167 item 2). The heading stays a real heading
 * for screen reader navigation, and the button inside it carries the state, which a heading inside
 * <summary> cannot do in every browser.
 */
export function Disclosure({
  title,
  open,
  onToggle,
  extra,
  children,
  level = 2,
  className = 'cw-panel2',
}: {
  title: string
  open: boolean
  onToggle: (open: boolean) => void
  extra?: ReactNode
  children: ReactNode
  level?: 2 | 3
  className?: string
}) {
  const bodyId = useId()
  const H = level === 2 ? 'h2' : 'h3'
  return (
    <section className={className}>
      <div className="cw-panel2-head">
        <H className="cw-disclosure-h">
          <button type="button" className="cw-disclosure" aria-expanded={open} aria-controls={bodyId} onClick={() => onToggle(!open)}>
            {title}
          </button>
        </H>
        {extra}
      </div>
      <div id={bodyId} hidden={!open}>
        {children}
      </div>
    </section>
  )
}
