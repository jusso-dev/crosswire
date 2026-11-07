import { Link } from '@tanstack/react-router'
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

/**
 * The Crosswire mark: two wires that cross at one junction node. Feeds come in on one wire,
 * your organisation's signal on the other; where they cross is the thing worth looking at.
 */
export function Mark({ size = 22 }: { size?: number }) {
  return (
    <svg className="cw-mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <path className="wire-a" d="M3 9c8 0 9 14 26 14" fill="none" strokeWidth="2.25" strokeLinecap="round" />
      <path className="wire-b" d="M3 23c8 0 9-14 26-14" fill="none" strokeWidth="2.25" strokeLinecap="round" />
      <circle className="node" cx="16" cy="16" r="3.4" strokeWidth="2.25" />
    </svg>
  )
}

export function Wordmark({ tagline }: { tagline?: string }) {
  return (
    <span className="cw-brand">
      <Mark />
      <span>
        Crosswire
        {tagline && <small>{tagline}</small>}
      </span>
    </span>
  )
}

/** Breadcrumb trail. The last item is the current page. */
export function Breadcrumbs({ items }: { items: Array<{ label: string; to?: string }> }) {
  return (
    <nav aria-label="Breadcrumb">
      <ol className="cw-crumbs">
        {items.map((it, i) => (
          <li key={`${it.label}-${i}`} aria-current={i === items.length - 1 ? 'page' : undefined}>
            {it.to && i < items.length - 1 ? <Link to={it.to}>{it.label}</Link> : it.label}
          </li>
        ))}
      </ol>
    </nav>
  )
}

/** Page header: one h1, one plain sentence of purpose, actions on the right. */
export function PageHead({ title, intro, actions, crumbs }: { title: ReactNode; intro?: ReactNode; actions?: ReactNode; crumbs?: Array<{ label: string; to?: string }> }) {
  return (
    <>
      {crumbs && <Breadcrumbs items={crumbs} />}
      <header className="cw-pagehead">
        <div>
          <h1>{title}</h1>
          {intro && <p>{intro}</p>}
        </div>
        {actions && <div className="cw-pagehead-actions">{actions}</div>}
      </header>
    </>
  )
}

export function SectionHead({ title, intro, action, id }: { title: ReactNode; intro?: ReactNode; action?: ReactNode; id?: string }) {
  return (
    <div className="cw-sechead">
      <h2 id={id}>{title}</h2>
      {action}
      {intro && <p>{intro}</p>}
    </div>
  )
}

/**
 * Feedback block. Tone is carried by a text label as well as colour ("Error:", "Warning:" …) so it
 * reads the same in a screen reader and in greyscale. Errors are announced (role=alert).
 */
export function Notice({ tone, title, children }: { tone: 'error' | 'warn' | 'info' | 'demo' | 'ok'; title?: string; children: ReactNode }) {
  const word = { error: 'Error', warn: 'Warning', info: 'Note', demo: 'Demo data', ok: 'Done' }[tone]
  return (
    <div className="cw-notice" data-tone={tone} role={tone === 'error' ? 'alert' : undefined}>
      <span className="cw-notice-icon" aria-hidden="true" />
      <div>
        <p className="cw-notice-title">
          <span className="cw-sr-only">{word}: </span>
          {title ?? (tone === 'demo' ? 'Demo data' : undefined)}
        </p>
        <div className="cw-notice-body">{children}</div>
      </div>
    </div>
  )
}

/** Glossary for the jargon a non-specialist will meet. */
export const GLOSSARY = {
  kql: 'KQL (Kusto Query Language) is the search language Microsoft Defender and Sentinel use to look through security logs.',
  dryRun: 'A dry run shows exactly what would happen, step by step, without changing anything in your tenant.',
  executor: 'An executor is the switch that lets Crosswire carry out an approved action in Microsoft. They are off unless your admin turns them on.',
  blastRadius: 'How much an action would affect: the number of devices, users and incidents it touches.',
  watch: 'Something you want to hear about: a product, vendor, CVE number or keyword. Crosswire checks threat feeds for it every hour.',
  hit: 'A hit is a threat-feed item that mentions one of your watches.',
  hunt: 'A hunt is a case file for investigating a hunch. It keeps the queries, results and notes together.',
  cve: 'A CVE is the public ID for a known software flaw, for example CVE-2026-12345.',
  kev: "CISA's Known Exploited Vulnerabilities list: flaws attackers are actively using right now.",
  defender: 'Microsoft Defender XDR: security data from your laptops, servers, email and identities.',
  sentinel: "Microsoft Sentinel: your organisation's central security log store.",
  approver: 'Someone allowed to approve or reject actions. Analysts can ask; approvers decide.',
} as const

/**
 * Inline glossary term. A real button toggles a definition that stays until dismissed: Escape
 * (from anywhere), clicking outside, focus moving away, or the button again (WCAG 1.4.13). The
 * definition is fixed-positioned and clamped to the viewport, so no panel can clip it.
 */
export function Term({ k, children }: { k: keyof typeof GLOSSARY; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null)
  const id = useId()
  const ref = useRef<HTMLSpanElement>(null)
  const btn = useRef<HTMLButtonElement>(null)

  useLayoutEffect(() => {
    if (!open || !btn.current) return
    const place = () => {
      const r = btn.current!.getBoundingClientRect()
      const width = Math.min(300, window.innerWidth - 16)
      const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8))
      const below = r.bottom + 6
      const top = below + 120 > window.innerHeight && r.top > 140 ? Math.max(8, r.top - 6 - 120) : below
      setPos({ left, top, width })
    }
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
        if (ref.current?.contains(document.activeElement)) btn.current?.focus()
      }
    }
    const onFocus = (e: FocusEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    document.addEventListener('focusin', onFocus)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('focusin', onFocus)
    }
  }, [open])

  return (
    <span className="cw-term" ref={ref}>
      <button ref={btn} type="button" className="cw-term-btn" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
        {children}
      </button>
      <span id={id} role="note" className="cw-term-tip" hidden={!open} style={pos ? { position: 'fixed', left: pos.left, top: pos.top, width: pos.width, maxWidth: 'none' } : undefined}>
        {GLOSSARY[k]}
      </span>
    </span>
  )
}

/** Horizontally scrollable table region. Focusable so keyboard users can scroll it. */
export function TableWrap({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="cw-tablewrap" role="region" aria-label={label} tabIndex={0}>
      {children}
    </div>
  )
}

/** Count inside a label, read once by screen readers ("Open, 3"). */
export function Count({ n }: { n: number }) {
  return <span className="cw-count-pill num">{n}</span>
}
