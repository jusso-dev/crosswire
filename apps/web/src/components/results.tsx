import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'

export type Row = Record<string, unknown>
export type Filter = { col: string; op: 'eq' | 'ne'; value: string }

/** Display text for a cell. Empty is shown as "empty", never as blank or zero. */
export function cellText(v: unknown): string {
  if (v === null || v === undefined || v === '') return ''
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

/** Encode filters for the URL. The operator is its own field ("eq"/"ne"), so column names may contain any character. */
export function encodeFilters(filters: Filter[]): string | undefined {
  if (!filters.length) return undefined
  return filters.map((f) => `${f.op}:${encodeURIComponent(f.col)}=${encodeURIComponent(f.value)}`).join('&')
}

export function decodeFilters(raw: string | undefined): Filter[] {
  if (!raw) return []
  return raw
    .split('&')
    .map((part) => {
      const m = /^(eq|ne):([^=]*)=(.*)$/s.exec(part)
      if (!m || !m[2]) return null
      try {
        return { op: m[1] as Filter['op'], col: decodeURIComponent(m[2]), value: decodeURIComponent(m[3]!) }
      } catch {
        return null
      }
    })
    .filter((f): f is Filter => f !== null)
}

export type Sort = { col: string; dir: 'asc' | 'desc' } | null

export function encodeSort(sort: Sort) {
  return sort ? `${sort.dir}:${encodeURIComponent(sort.col)}` : undefined
}

export function decodeSort(raw: string | undefined): Sort {
  const m = raw ? /^(asc|desc):(.+)$/.exec(raw) : null
  if (!m) return null
  try {
    return { dir: m[1] as 'asc' | 'desc', col: decodeURIComponent(m[2]!) }
  } catch {
    return null
  }
}

/** Sort rows the same way for the grid and the inspector, so next/previous follow what is on screen. */
export function sortRows(rows: Array<{ row: Row; index: number }>, sort: Sort) {
  if (!sort) return rows
  return [...rows].sort((a, b) => {
    const x = a.row[sort.col]
    const y = b.row[sort.col]
    const cmp = typeof x === 'number' && typeof y === 'number' ? x - y : cellText(x).localeCompare(cellText(y), 'en', { numeric: true })
    return sort.dir === 'asc' ? cmp : -cmp
  })
}

export function applyFilters(rows: Row[], filters: Filter[]) {
  return rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => filters.every((f) => (f.op === 'eq' ? cellText(row[f.col]) === f.value : cellText(row[f.col]) !== f.value)))
}

/** KQL literal for a "where" pivot. Strings are double-quoted with escapes (including line breaks); numbers stay bare. */
export function kqlLiteral(v: unknown): string {
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  const escaped = cellText(v)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
    // Any other control character as a Unicode escape.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
  return `"${escaped}"`
}

/** KQL identifier for a column. Plain names stay bare; anything else uses the ['name'] form. */
export function kqlIdentifier(name: string): string {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return name
  return `['${name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}']`
}

/**
 * Dense result grid over the stored sample. Click or Enter selects a row (opens the inspector);
 * j/k or arrow keys move the selection. Sorting is local to the sample and says so.
 */
export function ResultGrid({
  columns,
  rows,
  selected,
  onSelect,
  caption,
  sort,
  onSort,
}: {
  columns: string[]
  /** Already filtered and sorted (sortRows), so the grid and inspector share one order. */
  rows: Array<{ row: Row; index: number }>
  selected: number | null
  onSelect: (index: number | null) => void
  caption: string
  sort: Sort
  onSort: (sort: Sort) => void
}) {
  const [wrap, setWrap] = useState(false)
  const body = useRef<HTMLTableSectionElement>(null)
  const sorted = rows
  const setSort = onSort

  // Keep the selected row in view when it changes via keyboard or URL.
  useEffect(() => {
    if (selected === null) return
    body.current?.querySelector<HTMLTableRowElement>(`tr[data-index="${selected}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  // Position comes from the focused row, not the URL-driven `selected`, so fast repeated keys
  // never read a stale selection while navigation is still updating the URL.
  const move = (delta: number, from: number | null) => {
    if (!sorted.length) return
    const pos = sorted.findIndex((r) => r.index === (from ?? selected))
    const next = sorted[Math.min(sorted.length - 1, Math.max(0, pos === -1 ? 0 : pos + delta))]!
    onSelect(next.index)
    body.current?.querySelector<HTMLTableRowElement>(`tr[data-index="${next.index}"]`)?.focus()
  }

  const onKey = (e: KeyboardEvent<HTMLTableSectionElement>) => {
    const focused = (e.target as HTMLElement).closest<HTMLTableRowElement>('tr[data-index]')
    const from = focused ? Number(focused.dataset.index) : null
    if (e.key === 'j' || e.key === 'ArrowDown') {
      e.preventDefault()
      move(1, from)
    } else if (e.key === 'k' || e.key === 'ArrowUp') {
      e.preventDefault()
      move(-1, from)
    } else if (e.key === 'Escape' && selected !== null) {
      onSelect(null)
    }
  }

  return (
    <>
      <div className="cw-row" data-center style={{ justifyContent: 'space-between', margin: '0 0 var(--space-2xs)' }}>
        <span className="cw-muted">
          {caption}
          {sort && ` · sorted by ${sort.col} (${sort.dir === 'asc' ? 'ascending' : 'descending'}) within this sample`}
        </span>
        <span className="cw-row" data-center>
          <span className="cw-muted">
            Keys: <kbd>j</kbd>/<kbd>k</kbd> or arrows move, <kbd>Enter</kbd> opens, <kbd>Esc</kbd> closes
          </span>
          <button type="button" className="cw-btn" data-variant="ghost" data-size="sm" aria-pressed={wrap} onClick={() => setWrap(!wrap)}>
            Wrap long values
          </button>
        </span>
      </div>
      <div className="cw-tablewrap" style={{ maxHeight: '60vh' }}>
        <table className="cw-table cw-grid-table" data-wrap={wrap} aria-label={caption} aria-rowcount={sorted.length + 1}>
          <thead>
            <tr>
              <th className="num" scope="col">
                <span className="cw-sr-only">Row</span>#
              </th>
              {columns.map((c) => (
                <th key={c} scope="col" aria-sort={sort?.col === c ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                  <button
                    type="button"
                    className="cw-sortbtn"
                    data-dir={sort?.col === c ? sort.dir : undefined}
                    onClick={() => setSort(sort?.col !== c ? { col: c, dir: 'asc' } : sort.dir === 'asc' ? { col: c, dir: 'desc' } : null)}
                  >
                    {c}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody ref={body} onKeyDown={onKey}>
            {sorted.map(({ row, index }) => (
              <tr
                key={index}
                data-index={index}
                tabIndex={selected === index || (selected === null && index === sorted[0]?.index) ? 0 : -1}
                aria-selected={selected === index}
                onClick={() => onSelect(index)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    onSelect(index)
                  }
                }}
              >
                <td className="rownum">{index + 1}</td>
                {columns.map((c) => {
                  const text = cellText(row[c])
                  return (
                    <td key={c} className="cell" data-empty={text === '' ? '' : undefined} title={text.length > 28 ? text : undefined}>
                      {text === '' ? 'empty' : text}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

export function FilterChips({ filters, onRemove, onClear }: { filters: Filter[]; onRemove: (i: number) => void; onClear: () => void }) {
  if (!filters.length) return null
  return (
    <div className="cw-row" data-center style={{ margin: '0 0 var(--space-xs)' }}>
      <span className="cw-muted">Filtered:</span>
      <ul className="cw-chips" aria-label="Active filters" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {filters.map((f, i) => (
          <li key={`${f.col}-${i}`} className="cw-filterchip">
            <span>
              {f.col} {f.op === 'eq' ? '=' : '≠'} {f.value === '' ? 'empty' : f.value}
            </span>
            <button type="button" onClick={() => onRemove(i)}>
              <span aria-hidden>✕</span>
              <span className="cw-sr-only">
                Remove filter {f.col} {f.op === 'eq' ? 'equals' : 'not equal to'} {f.value}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <button type="button" className="cw-linkbtn" onClick={onClear}>
        Clear all
      </button>
    </div>
  )
}

/** Side inspector for one record: structured fields with pivots, raw JSON, and provenance. */
export function Inspector({
  title,
  row,
  columns,
  provenance,
  onClose,
  onPrev,
  onNext,
  onFilter,
  onAddToSearch,
  position,
}: {
  title: string
  row: Row
  columns: string[]
  provenance: ReactNode
  onClose: () => void
  onPrev?: () => void
  onNext?: () => void
  onFilter: (col: string, op: 'eq' | 'ne', value: string) => void
  onAddToSearch?: (col: string, value: unknown) => void
  position: string
}) {
  const [tab, setTab] = useState<'fields' | 'json'>('fields')
  const [hideEmpty, setHideEmpty] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  const fields = columns.filter((c) => !hideEmpty || cellText(row[c]) !== '')
  const copy = async (label: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(label)
      setTimeout(() => setCopied(null), 1500)
    } catch {
      setCopied('Copy failed: clipboard not available')
    }
  }
  // Narrow screens show the inspector as an overlay: move focus in, keep it in, restore it on close.
  // Wide screens keep it as a side panel next to the grid, so focus stays where the analyst is.
  const ref = useRef<HTMLElement>(null)
  const [overlay, setOverlay] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 1180px)')
    const on = () => setOverlay(mq.matches)
    on()
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  // While it is an overlay, everything else on the page is inert (no clicks, no focus), so focus
  // cannot reach covered controls at any width. Closing focus is handled by the caller (the row).
  useEffect(() => {
    if (!overlay) return
    const others = [...document.body.children].filter((el): el is HTMLElement => el instanceof HTMLElement && !el.contains(ref.current))
    const shell = ref.current?.closest('.cw-workspace')
    const siblings = shell ? [...shell.children].filter((el): el is HTMLElement => el instanceof HTMLElement && el !== ref.current) : []
    const outer = ref.current ? ancestorsSiblings(ref.current, shell as HTMLElement | null) : []
    const targets = [...others, ...siblings, ...outer]
    targets.forEach((el) => el.setAttribute('inert', ''))
    ref.current?.querySelector<HTMLElement>('h2')?.focus()
    return () => targets.forEach((el) => el.removeAttribute('inert'))
  }, [overlay])
  const trap = (e: KeyboardEvent<HTMLElement>) => {
    if (!overlay || e.key !== 'Tab' || !ref.current) return
    const items = [...ref.current.querySelectorAll<HTMLElement>('button:not([disabled]), input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])')].filter((el) => el.offsetParent !== null)
    if (!items.length) return
    const first = items[0]!
    const last = items[items.length - 1]!
    // Includes the case where focus is on the (programmatically focused) heading or outside the list.
    const inList = items.includes(document.activeElement as HTMLElement)
    if (e.shiftKey && (document.activeElement === first || !inList)) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && (document.activeElement === last || !inList)) {
      e.preventDefault()
      first.focus()
    }
  }

  return (
    <aside
      ref={ref}
      className="cw-inspector"
      aria-label={title}
      role={overlay ? 'dialog' : undefined}
      aria-modal={overlay ? true : undefined}
      onKeyDown={(e) => {
        trap(e)
        // Same keys as the grid, so analysts can step through rows from either side.
        const typing = (e.target as HTMLElement).closest('input, textarea, select')
        if (e.key === 'Escape') onClose()
        else if (!typing && (e.key === 'j' || e.key === 'ArrowDown') && onNext) {
          e.preventDefault()
          onNext()
        } else if (!typing && (e.key === 'k' || e.key === 'ArrowUp') && onPrev) {
          e.preventDefault()
          onPrev()
        }
      }}
    >
      <div className="cw-inspector-head">
        <h2 tabIndex={-1}>{title}</h2>
        <span className="cw-muted num">{position}</span>
        <button type="button" className="cw-iconbtn" onClick={onPrev} disabled={!onPrev}>
          <span aria-hidden>↑</span>
          <span className="cw-sr-only">Previous row</span>
        </button>
        <button type="button" className="cw-iconbtn" onClick={onNext} disabled={!onNext}>
          <span aria-hidden>↓</span>
          <span className="cw-sr-only">Next row</span>
        </button>
        <button type="button" className="cw-iconbtn" onClick={onClose}>
          <span aria-hidden>✕</span>
          <span className="cw-sr-only">Close inspector</span>
        </button>
      </div>
      <div className="cw-inspector-body">
        <div className="cw-row" data-center style={{ justifyContent: 'space-between' }}>
          <div className="cw-segmented" role="group" aria-label="View">
            <button type="button" aria-pressed={tab === 'fields'} onClick={() => setTab('fields')}>
              Fields
            </button>
            <button type="button" aria-pressed={tab === 'json'} onClick={() => setTab('json')}>
              Raw JSON
            </button>
          </div>
          {tab === 'fields' ? (
            <label className="cw-check" style={{ fontSize: 'var(--text-caption)' }}>
              <input type="checkbox" checked={hideEmpty} onChange={(e) => setHideEmpty(e.target.checked)} /> Hide empty fields
            </label>
          ) : (
            <button type="button" className="cw-btn" data-variant="ghost" data-size="sm" onClick={() => copy('JSON copied', JSON.stringify(row, null, 2))}>
              Copy JSON
            </button>
          )}
        </div>
        <p className="cw-muted" role="status" aria-live="polite" style={{ minHeight: '1.2em', margin: 0 }}>
          {copied ?? ''}
        </p>
        {tab === 'fields' ? (
          <table className="cw-fields">
            <tbody>
              {fields.map((c) => {
                const text = cellText(row[c])
                return (
                  <tr key={c}>
                    <th scope="row">{c}</th>
                    <td>
                      {text === '' ? <span className="cw-muted">empty</span> : text}
                      <div className="cw-fieldact">
                        <button type="button" className="cw-linkbtn" onClick={() => onFilter(c, 'eq', text)}>
                          Show only<span className="cw-sr-only"> rows where {c} is {text || 'empty'}</span>
                        </button>
                        <button type="button" className="cw-linkbtn" onClick={() => onFilter(c, 'ne', text)}>
                          Filter out<span className="cw-sr-only"> rows where {c} is {text || 'empty'}</span>
                        </button>
                        <button type="button" className="cw-linkbtn" onClick={() => copy(`Copied ${c}`, text)}>
                          Copy<span className="cw-sr-only"> {c}</span>
                        </button>
                        {onAddToSearch && text !== '' && (
                          <button type="button" className="cw-linkbtn" onClick={() => onAddToSearch(c, row[c])}>
                            Add to new search<span className="cw-sr-only"> filtered on {c}</span>
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        ) : (
          <pre aria-label="Raw record">{JSON.stringify(row, null, 2)}</pre>
        )}
        <section>
          <h3>Provenance</h3>
          {provenance}
        </section>
      </div>
    </aside>
  )
}

/** Values that look like entities, summarised from the sample. Counts are within the sample only. */
const ENTITY_COLUMNS: Array<{ kind: string; match: RegExp }> = [
  { kind: 'Devices', match: /^(DeviceName|Computer|HostName|DeviceId)$/i },
  { kind: 'Accounts', match: /^(Account|AccountName|AccountUpn|UserPrincipalName|InitiatingProcessAccountName)$/i },
  { kind: 'Processes and files', match: /^(FileName|InitiatingProcessFileName|ProcessName|SHA1|SHA256)$/i },
  { kind: 'Network', match: /^(RemoteUrl|RemoteIP|IPAddress|Url|DomainName)$/i },
]
const TIME_COLUMNS = /^(Timestamp|TimeGenerated|EventTime)$/i

export function summariseEntities(columns: string[], rows: Row[]) {
  const timeCol = columns.find((c) => TIME_COLUMNS.test(c))
  const groups: Array<{ kind: string; column: string; values: Array<{ value: string; count: number; first?: string; last?: string }> }> = []
  for (const { kind, match } of ENTITY_COLUMNS) {
    for (const column of columns.filter((c) => match.test(c))) {
      const map = new Map<string, { count: number; first?: string; last?: string }>()
      for (const r of rows) {
        const v = cellText(r[column])
        if (!v) continue
        const t = timeCol ? cellText(r[timeCol]) : undefined
        const cur = map.get(v) ?? { count: 0 }
        cur.count++
        if (t) {
          if (!cur.first || t < cur.first) cur.first = t
          if (!cur.last || t > cur.last) cur.last = t
        }
        map.set(v, cur)
      }
      if (map.size)
        groups.push({
          kind,
          column,
          values: [...map.entries()]
            .map(([value, s]) => ({ value, ...s }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 8),
        })
    }
  }
  return { groups, timeCol }
}

/** Siblings of every ancestor between `el` and the document body, except the chain itself. */
function ancestorsSiblings(el: HTMLElement, stopAt: HTMLElement | null) {
  const out: HTMLElement[] = []
  let node: HTMLElement | null = stopAt ?? el
  while (node && node.parentElement && node !== document.body) {
    for (const sib of node.parentElement.children) if (sib !== node && sib instanceof HTMLElement && !sib.contains(el)) out.push(sib)
    node = node.parentElement
  }
  return out
}
