import { Link, Outlet, createFileRoute, useMatchRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { z } from 'zod'
import { createHuntFn, fetchHunts } from '../fns/hunts'
import { fmtTime } from '../components/format'
import { Notice, Term } from '../components/ui'
import { Freshness, StatusTag } from '../components/signals'

/** Hunt list: one dense table with a URL-backed text filter and status filter (kept on back/forward). */
export const Route = createFileRoute('/app/hunts')({
  validateSearch: z.object({
    fromHit: z.string().optional(),
    title: z.string().optional(),
    q: z.string().optional(),
    status: z.enum(['open', 'closed', 'all']).optional(),
  }),
  loader: () => fetchHunts(),
  pendingComponent: () => <p className="cw-muted">Loading hunts…</p>,
  errorComponent: ({ error }) => (
    <Notice tone="error" title="Could not load hunts">
      {error instanceof Error ? error.message : String(error)}
    </Notice>
  ),
  component: Hunts,
})

function Hunts() {
  const hunts = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = useNavigate({ from: '/app/hunts' })
  const matchRoute = useMatchRoute()
  if (matchRoute({ to: '/app/hunts/$huntId', fuzzy: true })) return <Outlet />

  const status = search.status ?? 'open'
  const q = (search.q ?? '').toLowerCase()
  const shown = hunts.filter((h) => (status === 'all' || h.status === status) && (!q || h.title.toLowerCase().includes(q) || h.hypothesis.toLowerCase().includes(q)))
  const counts = { open: hunts.filter((h) => h.status === 'open').length, closed: hunts.filter((h) => h.status === 'closed').length, all: hunts.length }
  const set = (patch: { q?: string; status?: 'open' | 'closed' | 'all' }) => navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true })

  return (
    <>
      <header className="cw-pagehead">
        <div>
          <h1>Hunts</h1>
          <p>
            A <Term k="hunt">hunt</Term> is a case file for checking a hunch. It holds the searches, results and notes, so anyone can see what was checked and why.
          </p>
        </div>
      </header>

      <NewHunt open={Boolean(search.fromHit || search.title)} initialTitle={search.title ?? ''} fromHit={search.fromHit} />

      <div className="cw-tablewrap" style={{ overflow: 'visible' }}>
        <div className="cw-toolbar" style={{ borderRadius: 'var(--radius-lg) var(--radius-lg) 0 0' }}>
          <label className="cw-search">
            <span className="cw-sr-only">Filter hunts</span>
            <input type="search" placeholder="Filter by title or hypothesis" value={search.q ?? ''} onChange={(e) => set({ q: e.target.value || undefined })} />
          </label>
          <div className="cw-segmented" role="group" aria-label="Status">
            {(['open', 'closed', 'all'] as const).map((s) => (
              <button key={s} type="button" aria-pressed={status === s} onClick={() => set({ status: s === 'open' ? undefined : s })}>
                {s === 'all' ? 'All' : s === 'open' ? 'Open' : 'Closed'} <span className="num">({counts[s]})</span>
              </button>
            ))}
          </div>
          <span className="cw-toolbar-meta num">
            {shown.length} shown
          </span>
        </div>
        <div style={{ overflowX: 'auto' }}>
          {hunts.length === 0 ? (
            <p className="cw-empty" style={{ padding: 'var(--space-md)' }}>
              No hunts yet. Start one above, or from any watch hit on the <Link to="/app/watches">Watches</Link> page.
            </p>
          ) : shown.length === 0 ? (
            <p className="cw-empty" style={{ padding: 'var(--space-md)' }}>
              No hunts match.{' '}
              <button type="button" className="cw-linkbtn" onClick={() => set({ q: undefined, status: 'all' })}>
                Clear filters
              </button>
            </p>
          ) : (
            <table className="cw-table">
              <thead>
                <tr>
                  <th scope="col">Hunt</th>
                  <th scope="col">Status</th>
                  <th scope="col">Origin</th>
                  <th scope="col">Opened</th>
                  <th scope="col">Last activity</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((h) => (
                  <tr key={h.id}>
                    <td style={{ maxWidth: '60ch' }}>
                      <Link to="/app/hunts/$huntId" params={{ huntId: h.id }}>
                        {h.title}
                      </Link>
                      {h.hypothesis && <div className="cw-muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.hypothesis}</div>}
                    </td>
                    <td>
                      <StatusTag status={h.status} />
                    </td>
                    <td className="cw-muted">{h.fromHit ? 'Watch hit' : 'Manual'}</td>
                    <td className="num">{fmtTime(h.createdAt)}</td>
                    <td>
                      <Freshness at={h.updatedAt} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  )
}

function NewHunt({ open, initialTitle, fromHit }: { open: boolean; initialTitle: string; fromHit?: string }) {
  const navigate = useNavigate()
  const [title, setTitle] = useState(initialTitle)
  const [hypothesis, setHypothesis] = useState('')
  const [error, setError] = useState<string | null>(null)
  return (
    <details className="cw-panel2" open={open}>
      <summary className="cw-panel2-head" style={{ cursor: 'pointer' }}>
        <h2 style={{ display: 'inline' }}>Start a new hunt</h2>
        {fromHit && <span className="cw-badge" data-tone="info">From a watch hit</span>}
      </summary>
      <form
        className="cw-panel2-body cw-form"
        onSubmit={async (e) => {
          e.preventDefault()
          try {
            const h = await createHuntFn({ data: { title, hypothesis, watchHitId: fromHit } })
            await navigate({ to: '/app/hunts/$huntId', params: { huntId: h.id } })
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
          }
        }}
      >
        <label>
          Name the hunt
          <span className="cw-help">Short and specific, for example “Fortinet VPN exploitation check”.</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} />
        </label>
        <label>
          What do you suspect? (optional)
          <span className="cw-help">One or two sentences. Agents use this to suggest searches.</span>
          <textarea value={hypothesis} onChange={(e) => setHypothesis(e.target.value)} rows={3} placeholder="Attackers may be using the new FortiOS flaw against our edge firewalls." />
        </label>
        {error && (
          <Notice tone="error" title="Hunt not created">
            {error}
          </Notice>
        )}
        <div>
          <button className="cw-btn" type="submit" disabled={!title.trim()}>
            Start hunt
          </button>
        </div>
      </form>
    </details>
  )
}
