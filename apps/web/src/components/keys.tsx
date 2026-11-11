import type { KeyboardEvent } from 'react'

/** True while the person is typing, so single-key shortcuts must not fire. */
export function isTyping(target: EventTarget | null) {
  const el = target as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || Boolean(el.isContentEditable)
}

type ShortcutEvent = Pick<globalThis.KeyboardEvent, 'metaKey' | 'ctrlKey' | 'altKey' | 'defaultPrevented' | 'target'>

/**
 * An open dialog or confirmation. A closed `<dialog role="alertdialog">` (ConfirmDialog stays
 * mounted while closed) does not count; an `alertdialog` built from another element always does.
 */
export const OPEN_DIALOG_SELECTOR = 'dialog[open], [role="alertdialog"]:not(dialog)'

/**
 * Whether a single-key shortcut (`?`, `/`, `g` then a letter) may act on this key press.
 * No while typing, with a modifier held, after another handler took the key, or while any dialog
 * or confirmation is open (a native `dialog[open]` or an ARIA `alertdialog`). Cmd/Ctrl+K is
 * handled separately and always works.
 */
export function shouldHandleShortcut(event: ShortcutEvent, doc: Pick<Document, 'querySelector'>) {
  if (event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return false
  if (isTyping(event.target)) return false
  if (doc.querySelector(OPEN_DIALOG_SELECTOR)) return false
  return true
}

/** localStorage key for the single-key shortcut setting (#168). On unless set to "off". */
export const SHORTCUTS_KEY = 'cw-shortcuts'

/** Read the single-key shortcut setting. Default on. Storage errors (private mode) also mean on. */
export function singleKeyShortcutsOn(storage: Pick<Storage, 'getItem'> | undefined = typeof window === 'undefined' ? undefined : window.localStorage) {
  try {
    return storage?.getItem(SHORTCUTS_KEY) !== 'off'
  } catch {
    return true
  }
}

export function setSingleKeyShortcuts(on: boolean, storage: Pick<Storage, 'setItem'> | undefined = typeof window === 'undefined' ? undefined : window.localStorage) {
  try {
    storage?.setItem(SHORTCUTS_KEY, on ? 'on' : 'off')
  } catch {
    // A browser that refuses storage keeps the default for this page.
  }
}

/** True on Apple platforms, where the palette shortcut is Cmd+K. Read after hydration only. */
export function isMacPlatform(nav: { platform?: string; userAgent?: string; userAgentData?: { platform?: string } } | undefined) {
  if (!nav) return false
  const p = nav.userAgentData?.platform || nav.platform || nav.userAgent || ''
  return /mac|iphone|ipad|ipod/i.test(p)
}

/** The palette shortcut for assistive technology and the visible hint, by platform (#168). */
export function paletteShortcut(mac: boolean) {
  return mac ? { aria: 'Meta+K', hint: '⌘K' } : { aria: 'Control+K', hint: 'Ctrl K' }
}

/**
 * j/k (and arrows) move focus between rows of a list or table body; Enter opens the row's first link.
 * Rows are elements marked data-row. Nothing here approves, rejects or runs anything.
 */
export function listKeys<T extends HTMLElement>(e: KeyboardEvent<T>) {
  if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return
  const singleKey = e.key === 'j' || e.key === 'k'
  if (singleKey && !singleKeyShortcutsOn()) return
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
