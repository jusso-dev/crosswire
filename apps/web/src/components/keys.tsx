import type { KeyboardEvent } from 'react'

/** True while the person is typing, so single-key shortcuts must not fire. */
export function isTyping(target: EventTarget | null) {
  const el = target as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
}

/**
 * j/k (and arrows) move focus between rows of a list or table body; Enter opens the row's first link.
 * Rows are elements marked data-row. Nothing here approves, rejects or runs anything.
 */
export function listKeys<T extends HTMLElement>(e: KeyboardEvent<T>) {
  if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return
  const rows = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[data-row]'))
  if (!rows.length) return
  const current = (e.target as HTMLElement).closest<HTMLElement>('[data-row]')
  const i = current ? rows.indexOf(current) : -1
  const focusRow = (n: number) => {
    const row = rows[Math.max(0, Math.min(rows.length - 1, n))]!
    const link = row.querySelector<HTMLElement>('a, button')
    ;(link ?? row).focus()
  }
  if (e.key === 'j' || e.key === 'ArrowDown') {
    e.preventDefault()
    focusRow(i + 1)
  } else if (e.key === 'k' || e.key === 'ArrowUp') {
    e.preventDefault()
    focusRow(i - 1)
  }
}
