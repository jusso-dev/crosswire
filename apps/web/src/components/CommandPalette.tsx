import { useNavigate, useRouter } from '@tanstack/react-router'
import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { fetchPalette } from '../fns/palette'
import { OPEN_DIALOG_SELECTOR, isMacPlatform, paletteShortcut, setSingleKeyShortcuts, shouldHandleShortcut, singleKeyShortcutsOn } from './keys'

/**
 * Command palette (Cmd/Ctrl+K) and keyboard shortcuts. Built on the native <dialog> element:
 * focus moves in and returns on close, Esc closes, the page behind is inert.
 *
 * Shortcuts never approve, reject, execute or stop anything. Single keys are ignored while typing,
 * while any dialog or confirmation is open, and when the person turns them off (WCAG 2.1.4).
 * Cmd/Ctrl+K also works while typing, but never over another confirmation or dialog.
 *   ?        shortcut sheet
 *   g then x go to a page (see GO)
 *   /        focus the page search box
 *   j / k    move through lists (handled in each list)
 */

type Item = { id: string; group: string; label: string; hint?: string; to: string; params?: Record<string, string>; search?: Record<string, string> }

export const GO: Array<{ key: string; label: string; to: string }> = [
  { key: 'h', label: 'Control panel', to: '/app' },
  { key: 'w', label: 'Watches', to: '/app/watches' },
  { key: 'd', label: 'Daily digests', to: '/app/digests' },
  { key: 'u', label: 'Hunts', to: '/app/hunts' },
  { key: 'c', label: 'Ask an agent', to: '/app/chat' },
  { key: 'a', label: 'Approvals', to: '/app/approvals' },
  { key: 'r', label: 'Agent runs', to: '/app/agents' },
  { key: 's', label: 'Settings', to: '/app/settings' },
]

const PAGES: Item[] = [
  ...GO.map((g) => ({ id: `page:${g.to}`, group: 'Pages', label: g.label, hint: `g ${g.key}`, to: g.to, search: g.key === 'r' ? { view: 'runs' } : undefined })),
  { id: 'page:review', group: 'Pages', label: 'Memory waiting for review', to: '/app/agents', search: { view: 'review' } },
  { id: 'page:skills', group: 'Pages', label: 'Reviewed skills', to: '/app/agents', search: { view: 'skills' } },
  { id: 'page:log', group: 'Pages', label: 'Decision log', to: '/app/agents', search: { view: 'log' } },
]

const ACTIONS: Item[] = [
  { id: 'act:hunt', group: 'Actions', label: 'Start a new hunt', to: '/app/hunts', search: { check: '1' } },
  { id: 'act:ask', group: 'Actions', label: 'Ask an agent a question', to: '/app/chat' },
  { id: 'act:approvals', group: 'Actions', label: 'Open approvals waiting for a decision', to: '/app/approvals', search: { view: 'waiting' } },
  { id: 'act:watch', group: 'Actions', label: 'Add a watch', to: '/app/watches' },
]

/**
 * Whether this is an Apple platform. False during server render and the first client render, so
 * the markup matches; the real value arrives right after hydration.
 */
function useIsMac() {
  return useSyncExternalStore(
    () => () => {},
    () => isMacPlatform(navigator as Navigator & { userAgentData?: { platform?: string } }),
    () => false,
  )
}

/** The single-key shortcut setting, kept in localStorage and shared by every tab (#168). */
function useSingleKeyShortcuts(): [boolean, (on: boolean) => void] {
  const on = useSyncExternalStore(
    (notify) => {
      window.addEventListener('storage', notify)
      window.addEventListener('cw:shortcuts', notify)
      return () => {
        window.removeEventListener('storage', notify)
        window.removeEventListener('cw:shortcuts', notify)
      }
    },
    () => singleKeyShortcutsOn(),
    () => true,
  )
  const set = useCallback((next: boolean) => {
    setSingleKeyShortcuts(next)
    window.dispatchEvent(new Event('cw:shortcuts'))
  }, [])
  return [on, set]
}

/** Simple ranked match: every word must appear; earlier matches rank higher. */
export function matchItems<T extends { label: string; group: string }>(items: T[], query: string): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return items
  return items
    .map((item) => {
      const hay = `${item.label} ${item.group}`.toLowerCase()
      let score = 0
      for (const w of words) {
        const at = hay.indexOf(w)
        if (at === -1) return null
        score += at
      }
      return { item, score }
    })
    .filter((x): x is { item: T; score: number } => x !== null)
    .sort((a, b) => a.score - b.score)
    .map((x) => x.item)
}

export function CommandLayer() {
  const navigate = useNavigate()
  const router = useRouter()
  const palette = useRef<HTMLDialogElement>(null)
  const sheet = useRef<HTMLDialogElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const listId = useId()
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [data, setData] = useState<Awaited<ReturnType<typeof fetchPalette>> | null>(null)
  const [loadError, setLoadError] = useState(false)
  const pendingG = useRef<number | null>(null)
  const isMac = useIsMac()
  const [singleKeys, setSingleKeys] = useSingleKeyShortcuts()

  const openPalette = useCallback(() => {
    if (!palette.current || palette.current.open) return
    // Only our shortcut sheet may be replaced. Another modal owns focus until it closes (#127).
    if (Array.from(document.querySelectorAll(OPEN_DIALOG_SELECTOR)).some((dialog) => dialog !== sheet.current)) return
    sheet.current?.close()
    setQuery('')
    setActive(0)
    palette.current.showModal()
    input.current?.focus()
    setLoadError(false)
    fetchPalette()
      .then(setData)
      .catch(() => setLoadError(true))
  }, [])

  const openSheet = useCallback(() => {
    if (!sheet.current || sheet.current.open) return
    palette.current?.close()
    sheet.current.showModal()
  }, [])

  // Listen for the header buttons too.
  useEffect(() => {
    const onOpen = (e: Event) => ((e as CustomEvent).detail === 'shortcuts' ? openSheet() : openPalette())
    window.addEventListener('cw:command', onOpen)
    return () => window.removeEventListener('cw:command', onOpen)
  }, [openPalette, openSheet])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        if (palette.current?.open) palette.current.close()
        else openPalette()
        return
      }
      // Our own palette and sheet are dialogs too, so this also covers them.
      if (!singleKeyShortcutsOn() || !shouldHandleShortcut(e, document)) {
        if (pendingG.current !== null) window.clearTimeout(pendingG.current)
        pendingG.current = null
        return
      }
      if (pendingG.current !== null) {
        const target = GO.find((g) => g.key === e.key.toLowerCase())
        window.clearTimeout(pendingG.current)
        pendingG.current = null
        if (target) {
          e.preventDefault()
          void navigate({ to: target.to, search: target.key === 'r' ? { view: 'runs' } : undefined } as never)
        }
        return
      }
      if (e.key === 'g') {
        pendingG.current = window.setTimeout(() => (pendingG.current = null), 1200)
        return
      }
      if (e.key === '?') {
        e.preventDefault()
        openSheet()
        return
      }
      if (e.key === '/') {
        const box = document.querySelector<HTMLInputElement>('main [data-search], main input[type="search"]')
        if (box) {
          e.preventDefault()
          box.focus()
          box.select()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [navigate, openPalette, openSheet])

  const items = useMemo(() => {
    const dynamic: Item[] = data
      ? [
          ...data.approvals.map((a) => ({ id: `appr:${a.id}`, group: 'Approvals waiting', label: a.title, to: '/app/approvals/$id', params: { id: a.id } })),
          ...data.hunts.map((h) => ({ id: `hunt:${h.id}`, group: 'Recent hunts', label: h.title, hint: h.status, to: '/app/hunts/$huntId', params: { huntId: h.id } })),
          ...data.threads.map((t) => ({ id: `thread:${t.id}`, group: 'Conversations', label: t.title, to: '/app/chat/$threadId', params: { threadId: t.id } })),
          ...data.intel.map((k) => ({ id: `intel:${k}`, group: 'Compare intel', label: k, to: '/app/intel/$key', params: { key: k } })),
        ]
      : []
    const all = [...ACTIONS, ...PAGES, ...dynamic]
    const q = query.trim()
    // A CVE id typed in full can be compared even when it is not in the recent list.
    const cve = q.match(/^cve-\d{4}-\d{4,}$/i)
    const extra: Item[] = cve && !all.some((i) => i.label.toLowerCase() === q.toLowerCase()) ? [{ id: `intel:${q}`, group: 'Compare intel', label: q.toUpperCase(), to: '/app/intel/$key', params: { key: q.toUpperCase() } }] : []
    return [...extra, ...matchItems(all, q)].slice(0, 60)
  }, [data, query])

  // Keep the active option in view, and preload its page while the person decides (#168).
  // Focus stays in the input (aria-activedescendant), so the option itself never gets focus.
  const activeItem = items[active]
  useEffect(() => {
    if (!activeItem || !palette.current?.open) return
    document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: 'nearest' })
    void router.preloadRoute({ to: activeItem.to, params: activeItem.params, search: activeItem.search } as never).catch(() => {})
  }, [activeItem, active, listId, router])

  const go = (item: Item) => {
    palette.current?.close()
    void navigate({ to: item.to, params: item.params, search: item.search } as never)
  }

  let lastGroup = ''
  return (
    <>
      <dialog
        ref={palette}
        className="cw-dialog"
        aria-label="Command palette"
        onClick={(e) => {
          if (e.target === palette.current) palette.current.close()
        }}
      >
        <div className="cw-palette">
          <div className="cw-palette-input">
            <span aria-hidden="true">⌕</span>
            <input
              ref={input}
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-activedescendant={items[active] ? `${listId}-${active}` : undefined}
              aria-label="Search pages, hunts, conversations, approvals and intel"
              placeholder="Jump to a page, hunt, conversation or CVE"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setActive(0)
              }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) {
                  e.preventDefault()
                  setActive((a) => Math.min(items.length - 1, a + 1))
                } else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) {
                  e.preventDefault()
                  setActive((a) => Math.max(0, a - 1))
                } else if (e.key === 'Enter' && items[active]) {
                  e.preventDefault()
                  go(items[active])
                }
              }}
            />
            <kbd>Esc</kbd>
          </div>
          <ul id={listId} role="listbox" aria-label="Results" className="cw-palette-list">
            {items.length === 0 && <li className="cw-palette-group">{loadError ? 'Recent items did not load. Pages and actions still work.' : 'Nothing matches. Try a page name, a hunt title or a CVE id.'}</li>}
            {items.map((item, i) => {
              const header = item.group !== lastGroup
              lastGroup = item.group
              return (
                <li key={item.id} role="presentation">
                  {header && (
                    <div className="cw-palette-group" aria-hidden="true">
                      {item.group}
                    </div>
                  )}
                  <div
                    id={`${listId}-${i}`}
                    role="option"
                    aria-selected={i === active}
                    className="cw-palette-item"
                    onMouseMove={() => setActive(i)}
                    onClick={() => go(item)}
                  >
                    <span>{item.label}</span>
                    <span className="cw-sr-only">, {item.group}</span>
                    {item.hint && <span className="cw-muted">{item.hint}</span>}
                  </div>
                </li>
              )
            })}
          </ul>
          <div className="cw-palette-foot" aria-hidden="true">
            <span>
              <kbd>↑</kbd> <kbd>↓</kbd> move
            </span>
            <span>
              <kbd>Enter</kbd> open
            </span>
            <span>
              <kbd>?</kbd> all shortcuts
            </span>
          </div>
        </div>
      </dialog>

      <dialog
        ref={sheet}
        className="cw-dialog"
        aria-labelledby="shortcuts-title"
        onClick={(e) => {
          if (e.target === sheet.current) sheet.current.close()
        }}
      >
        <div className="cw-shortcuts">
          <div className="cw-row cw-between" data-center>
            <h2 id="shortcuts-title">Keyboard shortcuts</h2>
            <button type="button" className="cw-btn" data-variant="ghost" data-size="sm" onClick={() => sheet.current?.close()}>
              Close
            </button>
          </div>
          <p className="cw-muted">Single keys do nothing while you are typing in a box. No shortcut approves, rejects, executes or stops anything.</p>
          <label className="cw-inline cw-shortcut-toggle">
            <input type="checkbox" checked={singleKeys} onChange={(e) => setSingleKeys(e.target.checked)} />
            <span>Single-key shortcuts</span>
          </label>
          <p className="cw-help">
            {singleKeys
              ? 'On. Turn them off if you use speech input or press keys by accident. This browser remembers the choice.'
              : `Off. Only ${isMac ? '⌘ K' : 'Ctrl K'} and Esc work. This browser remembers the choice.`}
          </p>
          <h3>Anywhere</h3>
          <dl>
            <dt>{isMac ? <><kbd>⌘</kbd> <kbd>K</kbd></> : <><kbd>Ctrl</kbd> <kbd>K</kbd></>}</dt>
            <dd>Open the command palette</dd>
            <dt>
              <kbd>?</kbd>
            </dt>
            <dd>Show this list</dd>
            <dt>
              <kbd>/</kbd>
            </dt>
            <dd>Search on this page</dd>
            <dt>
              <kbd>Esc</kbd>
            </dt>
            <dd>Close a dialog or panel</dd>
          </dl>
          <h3>Go to</h3>
          <dl>
            {GO.map((g) => (
              <div key={g.key} className="cw-contents">
                <dt>
                  <kbd>g</kbd> <kbd>{g.key}</kbd>
                </dt>
                <dd>{g.label}</dd>
              </div>
            ))}
          </dl>
          <h3>Lists and tables</h3>
          <dl>
            <dt>
              <kbd>j</kbd> <kbd>k</kbd>
            </dt>
            <dd>Next and previous row</dd>
            <dt>
              <kbd>Enter</kbd>
            </dt>
            <dd>Open the row</dd>
          </dl>
        </div>
      </dialog>
    </>
  )
}

/** Header button that opens the palette, for people who do not use shortcuts. */
export function PaletteButton() {
  const shortcut = paletteShortcut(useIsMac())
  return (
    <button type="button" className="cw-kbdhint" onClick={() => window.dispatchEvent(new CustomEvent('cw:command', { detail: 'palette' }))} aria-keyshortcuts={shortcut.aria}>
      <span>Search or jump</span> <kbd aria-hidden="true">{shortcut.hint}</kbd>
    </button>
  )
}

export function ShortcutsButton() {
  const [singleKeys] = useSingleKeyShortcuts()
  return (
    <button type="button" className="cw-kbdhint" onClick={() => window.dispatchEvent(new CustomEvent('cw:command', { detail: 'shortcuts' }))} aria-keyshortcuts={singleKeys ? 'Shift+?' : undefined}>
      <span className="cw-sr-only">Keyboard shortcuts</span>
      <kbd aria-hidden="true">?</kbd>
    </button>
  )
}
