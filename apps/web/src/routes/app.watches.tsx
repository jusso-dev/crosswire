import { Link, createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import { useId, useState } from 'react'
import { z } from 'zod'
import { createWatch, fetchWatches, removeWatch } from '../fns/watches'
import { fmtTime, plural } from '../components/format'
import { Notice, PageHead, TableWrap, Term, SkeletonPage } from '../components/ui'
import { plainMessage } from '../shared/messages'
import { Freshness } from '../components/signals'
import { pageTitle } from '../components/errors'
import { ConfirmDialog } from '../components/confirm'
import { useAction } from '../components/action'
import { safeHref } from '../shared/links'

/**
 * Watches: what to listen for (left) and what matched (right). Hit filters live in the URL so
 * back/forward and reload keep the analyst's place.
 */
export const Route = createFileRoute('/app/watches')({
  validateSearch: z.object({ q: z.string().optional(), entry: z.string().optional(), day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), source: z.enum(['pwn.watch', 'cisa-kev']).optional() }),
  loaderDeps: ({ search }) => ({ entry: search.entry, day: search.day }),
  loader: ({ deps }) => fetchWatches({ data: { entryId: deps.entry, day: deps.day } }),
  pendingComponent: () => <SkeletonPage label="Loading watches" />,
  errorComponent: ({ error }) => (
    <Notice tone="error" title="Watches did not load">
      {plainMessage(error)} Refresh the page to try again.
    </Notice>
  ),
  head: () => ({ meta: [{ title: pageTitle('Watches') }] }),
  component: Watches,
})

const TYPES = [
  { value: 'vendor', label: 'Vendor', hint: 'A company whose products you run, for example fortinet or citrix.' },
  { value: 'keyword', label: 'Keyword', hint: 'Any word or product name, for example vpn or exchange. Whole words, any case.' },
  { value: 'cve', label: 'CVE number', hint: 'One specific flaw, written like CVE-2026-12345.' },
  { value: 'tag', label: 'pwn.watch tag', hint: 'A topic tag such as cisa-kev or ransomware.' },
] as const
const TYPE_LABEL: Record<string, string> = Object.fromEntries(TYPES.map((t) => [t.value, t.label]))
const SOURCE_LABEL: Record<string, string> = { 'pwn.watch': 'pwn.watch', 'cisa-kev': 'CISA KEV' }
const sourceKey = (s: string) => s.replace(/^demo:/, '')

function Watches() {
  const { entries, hits, totalHits } = Route.useLoaderData()
  const sp = Route.useSearch()
  const navigate = useNavigate({ from: '/app/watches' })
  const set = (patch: Partial<typeof sp>) => navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true })
  const q = (sp.q ?? '').toLowerCase()
  const shown = hits.filter(
    (h) =>
      // The loader already scoped hits to the selected watch.
      (!sp.source || sourceKey(h.source) === sp.source) &&
      (!q || h.title.toLowerCase().includes(q) || (h.snippet ?? '').toLowerCase().includes(q) || h.cveIds.some((c) => c.toLowerCase().includes(q))),
  )
  const filtered = Boolean(sp.q || sp.entry || sp.source || sp.day)

  return (
    <>
      <PageHead
        title="Watches"
        intro={
          <>
            Tell Crosswire what you run. Every hour it reads pwn.watch and the <Term k="kev">CISA KEV</Term> list and flags any item that mentions a <Term k="watch">watch</Term>. Each match is a <Term k="hit">hit</Term>.
          </>
        }
      />
      <div className="cw-split">
        <section aria-labelledby="list-title">
          <AddWatch />
          <h2 id="list-title" className="cw-h2-compact">
            Watch list <span className="cw-muted num">({entries.length})</span>
          </h2>
          {entries.length === 0 ? (
            <p className="cw-empty">Nothing on your watch list yet. Start with your firewall, VPN and email vendors.</p>
          ) : (
            <TableWrap label="Watch list">
              <table className="cw-table">
                <thead>
                  <tr>
                    <th scope="col">Watching</th>
                    <th scope="col" className="num">Hits</th>
                    <th scope="col">
                      <span className="cw-sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((e) => {
                    const key = e.id
                    const n = e.hitCount
                    return (
                      <tr key={e.id} aria-selected={sp.entry === key}>
                        <td>
                          <span className="mono">{e.value}</span>
                          <div className="cw-muted">
                            {TYPE_LABEL[e.type] ?? e.type} · added {fmtTime(e.createdAt)}
                          </div>
                        </td>
                        <td className="num">
                          {n > 0 ? (
                            <button type="button" className="cw-linkbtn" aria-pressed={sp.entry === key} onClick={() => set({ entry: sp.entry === key ? undefined : key })}>
                              {n}
                              <span className="cw-sr-only"> {n === 1 ? 'hit' : 'hits'} for {e.value}, {sp.entry === key ? 'showing' : 'show only these'}</span>
                            </button>
                          ) : (
                            <span className="cw-muted">0</span>
                          )}
                        </td>
                        <td>
                          <RemoveWatch id={e.id} value={e.value} hitCount={e.hitCount} />
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </TableWrap>
          )}
        </section>

        <section aria-labelledby="hits-title">
          <h2 id="hits-title" className="cw-h2-compact">
            {sp.day ? `Hits on ${sp.day}` : sp.entry ? 'Hits for this watch' : 'Recent hits'} <span className="cw-muted num">({sp.entry || sp.day ? hits.length : totalHits})</span>
          </h2>
          <div className="cw-tablewrap cw-overflow-visible">
            <div className="cw-toolbar cw-attached">
              <label className="cw-search">
                <span className="cw-sr-only">Filter hits by title, summary or CVE</span>
                <input type="search" placeholder="Filter by title, summary or CVE" value={sp.q ?? ''} onChange={(e) => set({ q: e.target.value || undefined })} />
              </label>
              <label className="cw-inline">
                <span>Source</span>
                <select value={sp.source ?? ''} onChange={(e) => set({ source: (e.target.value || undefined) as typeof sp.source })}>
                  <option value="">All sources</option>
                  <option value="pwn.watch">pwn.watch</option>
                  <option value="cisa-kev">CISA KEV</option>
                </select>
              </label>
              <span className="cw-toolbar-meta num" role="status">
                {shown.length} shown{!sp.entry && !sp.day && totalHits > hits.length ? ` (newest ${hits.length} of ${totalHits})` : ''}
                {filtered && (
                  <button type="button" className="cw-linkbtn" onClick={() => set({ q: undefined, entry: undefined, source: undefined, day: undefined })}>
                    Clear filters
                  </button>
                )}
              </span>
            </div>
            {sp.entry && (
              <p className="cw-muted cw-m0 cw-pad-xs-top">
                Showing hits for <span className="mono">{entries.find((e) => e.id === sp.entry)?.value ?? 'a removed watch'}</span>.
              </p>
            )}
            <div className="cw-scroll-x" role="region" aria-label="Recent hits table" tabIndex={0}>
              {hits.length === 0 ? (
                <p className="cw-empty cw-pad">
                  No hits yet. Crosswire checks the feeds every hour, so a new watch can take up to an hour to match.
                </p>
              ) : shown.length === 0 ? (
                <p className="cw-empty cw-pad">
                  No hits match these filters.
                </p>
              ) : (
                <table className="cw-table">
                  <thead>
                    <tr>
                      <th scope="col">Item</th>
                      <th scope="col">Matched</th>
                      <th scope="col">Source</th>
                      <th scope="col">Matched at</th>
                      <th scope="col">
                        <span className="cw-sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((h) => (
                      <tr key={h.id}>
                        <td className="cw-cell-wide">
                          <ExternalTitle url={h.url} title={h.title} />
                          {h.snippet && <div className="cw-muted cw-clamp">{h.snippet}</div>}
                          {h.cveIds.length > 0 && (
                            <div className="cw-chips cw-mt-2xs">
                              {h.cveIds.slice(0, 3).map((c) => (
                                <Link key={c} className="cw-chip" to="/app/intel/$key" params={{ key: c }}>
                                  {c}
                                  <span className="cw-sr-only">, compare sources</span>
                                </Link>
                              ))}
                            </div>
                          )}
                        </td>
                        <td>
                          <span className="mono">{h.entryValue}</span>
                          <div className="cw-muted">{TYPE_LABEL[h.entryType] ?? h.entryType}</div>
                        </td>
                        <td>
                          {SOURCE_LABEL[sourceKey(h.source)] ?? h.source}
                          {h.source.startsWith('demo:') && (
                            <div>
                              <span className="cw-badge" data-tone="demo">
                                Demo
                              </span>
                            </div>
                          )}
                        </td>
                        <td>
                          <Freshness at={h.createdAt} />
                        </td>
                        <td>
                          <Link className="cw-btn" data-variant="ghost" data-size="sm" to="/app/hunts" search={{ fromHit: h.id, title: `Hunt: ${h.title.slice(0, 150)}` }}>
                            Start hunt<span className="cw-sr-only"> for {h.title.slice(0, 80)}</span>
                          </Link>
                          <Link className="cw-btn" data-variant="quiet" data-size="sm" to="/app/chat" search={{ agent: 'intel', q: `Is this relevant to us, and what should we check? "${h.title.slice(0, 300)}"${h.cveIds.length ? ` (${h.cveIds.slice(0, 3).join(', ')})` : ''}. It matched our watch on ${h.entryValue}.` }}>
                            Ask Intel<span className="cw-sr-only"> about {h.title.slice(0, 80)}</span>
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
          <p className="cw-muted">
            Sources: <a href="https://pwn.watch">pwn.watch</a> and the CISA Known Exploited Vulnerabilities catalogue.
          </p>
        </section>
      </div>
    </>
  )
}

/** A feed title, linked only when its URL is http or https. Anything else is plain text. */
function ExternalTitle({ url, title }: { url: string | null | undefined; title: string }) {
  const href = safeHref(url)
  if (!href) return <>{title}</>
  return (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {title}
      <span className="cw-sr-only"> (opens in a new tab)</span>
    </a>
  )
}

function AddWatch() {
  const router = useRouter()
  const [type, setType] = useState<(typeof TYPES)[number]['value']>('vendor')
  const [value, setValue] = useState('')
  const [saved, setSaved] = useState<string | null>(null)
  const { run, busy, error } = useAction()
  const hintId = useId()
  const errId = useId()
  return (
    <form
      className="cw-card cw-form"
      data-wide
      aria-labelledby="add-title"
      onSubmit={async (e) => {
        e.preventDefault()
        setSaved(null)
        const added = value
        const r = await run('add', () => createWatch({ data: { type, value: added } }))
        if (!r?.ok) return
        setSaved(`Added ${added}. Matches appear within the hour.`)
        setValue('')
        await router.invalidate()
      }}
    >
      <h2 id="add-title" className="cw-h2-compact cw-m0">
        Add a watch
      </h2>
      <div className="cw-row">
        <label>
          Kind
          <select value={type} onChange={(e) => setType(e.target.value as typeof type)}>
            {TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <label className="cw-grow">
          Value
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={type === 'cve' ? 'CVE-2026-12345' : type === 'tag' ? 'cisa-kev' : type === 'vendor' ? 'fortinet' : 'vpn'}
            required
            aria-invalid={error ? true : undefined}
            aria-describedby={`${hintId}${error ? ` ${errId}` : ''}`}
          />
        </label>
        <button className="cw-btn" type="submit" disabled={!value.trim() || Boolean(busy)} aria-busy={busy ? true : undefined}>
          {busy ? 'Adding…' : 'Add watch'}
        </button>
      </div>
      <p id={hintId} className="cw-help cw-m0">
        {TYPES.find((t) => t.value === type)?.hint}
      </p>
      {error && (
        <p id={errId} className="cw-field-error" role="alert">
          {error}
        </p>
      )}
      <p className="cw-help cw-m0" role="status">
        {saved ?? ''}
      </p>
    </form>
  )
}

/** Remove a watch after a confirmation that names it. Focus starts on Cancel and returns to Remove. */
function RemoveWatch({ id, value, hitCount }: { id: string; value: string; hitCount: number }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const { run, busy, error, setError } = useAction()
  return (
    <>
      <button type="button" className="cw-btn" data-variant="quiet" data-size="sm" onClick={() => setOpen(true)}>
        Remove<span className="cw-sr-only"> {value}</span>
      </button>
      <ConfirmDialog
        open={open}
        tone="danger"
        title={`Remove the watch ${value}?`}
        body={
          <p>
            Crosswire stops checking the feeds for <strong>{value}</strong>.{' '}
            {hitCount > 0 ? `Its ${plural(hitCount, 'hit')} so far stay in the list of hits.` : 'It has no hits yet.'}
          </p>
        }
        confirmLabel="Remove watch"
        busy={Boolean(busy)}
        error={error}
        onCancel={() => {
          setError(null)
          setOpen(false)
        }}
        onConfirm={async () => {
          const r = await run('remove', () => removeWatch({ data: { id } }))
          if (r === undefined) return
          if (!r.ok) return setError('This watch was not found. It may already be removed. Refresh the page.')
          setOpen(false)
          await router.invalidate()
        }}
      />
    </>
  )
}
