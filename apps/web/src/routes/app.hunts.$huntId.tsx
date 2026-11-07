import { Link, createFileRoute, notFound, useNavigate, useRouter } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import { z } from 'zod'
import { addNote, approveKqlFn, createScheduleFn, disableScheduleFn, fetchHunt, huntReportFn, proposeKqlFn, reapproveScheduleFn, rejectKqlFn, setHuntStatusFn } from '../fns/hunts'
import { fmtTime } from '../components/format'
import { Notice, Term } from '../components/ui'
import { Freshness, ModeTag, StatusTag, TARGET_LABEL } from '../components/signals'
import { FilterChips, Inspector, ResultGrid, applyFilters, decodeFilters, decodeSort, encodeFilters, encodeSort, kqlIdentifier, kqlLiteral, sortRows, summariseEntities, type Filter, type Row, type Sort } from '../components/results'

/**
 * Hunt workspace (reference slice for the analyst design system, see design.md).
 * View state lives in the URL so reload, back/forward and shared links restore the exact view:
 *   q   selected search id      row  selected row in that search's sample
 *   f   result filters          s    result sort (shared by grid and inspector)
 *   tl  timeline filter         ev   a repeat-search run whose sample is shown
 */
const search = z.object({
  q: z.string().optional(),
  row: z.coerce.number().int().min(0).optional(),
  f: z.string().optional(),
  s: z.string().optional(),
  tl: z.enum(['all', 'searches', 'results', 'notes', 'schedules']).optional(),
  ev: z.string().optional(),
})

export const Route = createFileRoute('/app/hunts/$huntId')({
  validateSearch: search,
  loader: async ({ params }) => {
    const h = await fetchHunt({ data: { huntId: params.huntId } })
    if (!h) throw notFound()
    return h
  },
  pendingComponent: () => <p className="cw-muted" style={{ padding: 'var(--space-lg)' }}>Loading hunt…</p>,
  errorComponent: ({ error }) => (
    <div style={{ padding: 'var(--space-lg)' }}>
      <Notice tone="error" title="Could not load this hunt">
        {error instanceof Error ? error.message : String(error)}
      </Notice>
      <Link to="/app/hunts">Back to all hunts</Link>
    </div>
  ),
  notFoundComponent: () => (
    <div style={{ padding: 'var(--space-lg)' }}>
      <h1>Hunt not found</h1>
      <p className="cw-muted">It may have been removed, or it belongs to another organisation.</p>
      <Link to="/app/hunts">Back to all hunts</Link>
    </div>
  ),
  component: HuntWorkspace,
})

type Data = Awaited<ReturnType<typeof fetchHunt>> & {}
type Proposal = Data['proposals'][number]
type Summary = { mode?: string; rowCount?: number; truncated?: boolean; columns?: string[]; sample?: Row[]; durationMs?: number }

function summaryOf(p: Proposal): Summary | null {
  return (p.resultSummary as Summary | null) ?? null
}

function HuntWorkspace() {
  const data: Data = Route.useLoaderData()
  const { hunt, proposals, origin, demoMode } = data
  const sp = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState<{ kql: string; target: 'defender' | 'sentinel' } | null>(null)
  // Lives above the rail so opening the inspector (which replaces the rail) never drops a draft.
  const [note, setNote] = useState('')

  // Default selection: the first search that needs review, else the latest that ran, else the newest.
  const selected = proposals.find((p) => p.id === sp.q) ?? proposals.find((p) => p.status === 'proposed') ?? proposals.find((p) => p.status === 'run') ?? proposals[0]
  // View changes are pushed to history so Back steps through them. Every change pins the selected
  // search id, so a reload never re-points row/filters at a different default search.
  const set = (patch: Partial<z.infer<typeof search>>, opts: { replace?: boolean } = {}) =>
    navigate({ search: (prev) => ({ ...prev, q: selected?.id ?? prev.q, ...patch }), replace: opts.replace ?? false, resetScroll: false })
  const filters = decodeFilters(sp.f)
  const sort = decodeSort(sp.s)
  // A repeat-search run selected from the timeline shows its own sample in place of the original.
  const runEvent = sp.ev ? data.evidence.find((e) => e.id === sp.ev && e.type === 'scheduled_result') : undefined
  const summary = runEvent ? (runEvent.payload as Summary) : selected ? summaryOf(selected) : null
  const ordered = summary?.sample ? sortRows(applyFilters(summary.sample, filters), sort) : []
  const inspecting = summary?.sample && sp.row !== undefined && summary.sample[sp.row] ? sp.row : null

  return (
    <div className="cw-workspace" data-inspecting={inspecting !== null}>
      <div className="cw-ws-main">
        <nav aria-label="Breadcrumb">
          <ol className="cw-crumbs">
            <li>
              <Link to="/app/hunts">Hunts</Link>
            </li>
            <li aria-current="page">{hunt.title}</li>
          </ol>
        </nav>
        <header className="cw-pagehead" style={{ marginBottom: 0 }}>
          <div>
            <h1>{hunt.title}</h1>
            <p>{hunt.hypothesis || <span>No hypothesis yet. Add a note saying what you suspect, so agents can suggest searches.</span>}</p>
          </div>
          <div className="cw-pagehead-actions">
            <ExportButton huntId={hunt.id} onError={setError} />
            <button
              type="button"
              className="cw-btn"
              data-variant="ghost"
              onClick={async () => {
                await setHuntStatusFn({ data: { huntId: hunt.id, status: hunt.status === 'open' ? 'closed' : 'open' } })
                await router.invalidate()
              }}
            >
              {hunt.status === 'open' ? 'Close hunt' : 'Reopen hunt'}
            </button>
          </div>
        </header>
        <dl className="cw-ctxbar" aria-label="Hunt context">
          <div>
            <dt>Status</dt>
            <dd>
              <StatusTag status={hunt.status} />
            </dd>
          </div>
          <div>
            <dt>Origin</dt>
            <dd>
              {origin ? (
                origin.url ? (
                  <a href={origin.url} target="_blank" rel="noreferrer noopener" title={origin.title}>
                    {origin.title.length > 60 ? `${origin.title.slice(0, 60)}…` : origin.title}
                  </a>
                ) : (
                  origin.title
                )
              ) : (
                'Manual, not from a watch hit'
              )}
            </dd>
          </div>
          <div>
            <dt>Opened</dt>
            <dd>
              <time dateTime={hunt.createdAt}>{fmtTime(hunt.createdAt)}</time>
            </dd>
          </div>
          <div>
            <dt>Searches</dt>
            <dd className="num">
              {proposals.length} ({proposals.filter((p) => p.status === 'proposed').length} need review)
            </dd>
          </div>
          <div>
            <dt>Data</dt>
            <dd>{demoMode ? <ModeTag mode="demo" /> : <span>Your tenant</span>}</dd>
          </div>
        </dl>
        {demoMode && (
          <Notice tone="demo">
            No Defender or Sentinel connection is set up for this organisation, so searches return labelled demo rows. They are not findings from your environment. An owner can connect the tenant in <Link to="/app/settings">Settings</Link>.
          </Notice>
        )}
        {error && (
          <Notice tone="error" title="That did not work">
            {error}
          </Notice>
        )}

        <h2 className="cw-sr-only" id="searches-title">
          Searches
        </h2>
        {proposals.length === 0 ? (
          <div className="cw-card">
            <h3>No searches yet</h3>
            <p className="cw-empty">
              Ask Hunter in <Link to="/app/chat">chat</Link> to propose a search for this hunt, or write one below. Nothing runs until a person approves it.
            </p>
          </div>
        ) : (
          <ul className="cw-qlist" aria-label="Searches in this hunt">
            {proposals.map((p) => {
              const s = summaryOf(p)
              return (
                <li key={p.id} style={{ display: 'contents' }}>
                <button
                  type="button"
                  className="cw-qitem"
                  aria-current={p.id === selected?.id ? 'true' : undefined}
                  onClick={() => set({ q: p.id, row: undefined, f: undefined, s: undefined, ev: undefined })}
                >
                  <StatusTag status={p.status} />
                  <code title={p.kql}>{p.kql}</code>
                  <span className="cw-list-side">{TARGET_LABEL[p.target]}</span>
                  <span className="cw-qitem-meta">
                    <span>{p.rationale || 'No rationale given'}</span>
                    <span>proposed by {p.proposedByType === 'agent' ? p.proposedById : 'an analyst'}</span>
                    {p.status === 'run' && s && <span className="num">{s.rowCount ?? '?'} rows</span>}
                    {p.status === 'proposed' && <span>expires {fmtTime(p.expiresAt)}</span>}
                  </span>
                </button>
                </li>
              )
            })}
          </ul>
        )}

        {selected && (
          <SearchPanel
            key={`${selected.id}:${runEvent?.id ?? ''}`}
            p={selected}
            summary={summary}
            runAt={runEvent?.createdAt}
            onShowOriginal={runEvent ? () => set({ ev: undefined, row: undefined, f: undefined }) : undefined}
            ordered={ordered}
            filters={filters}
            sort={sort}
            row={inspecting}
            onRow={(row) => set({ row: row ?? undefined }, { replace: sp.row !== undefined && row !== null })}
            onSort={(next) => set({ s: encodeSort(next) }, { replace: true })}
            onFilters={(next) => set({ f: encodeFilters(next), row: undefined })}
            onError={setError}
            onDraft={(kql) => setDraft({ kql, target: selected.target })}
          />
        )}

        <ProposeSearch huntId={hunt.id} draft={draft} onDone={() => setDraft(null)} onError={setError} />
        <Schedules data={data} onError={setError} />
      </div>

      {inspecting !== null && summary?.sample && selected ? (
        <RowInspector
          p={selected}
          summary={summary}
          rowIndex={inspecting}
          ordered={ordered}
          filters={filters}
          onRow={(row) => set({ row: row ?? undefined }, { replace: row !== null })}
          onFilters={(next) => set({ f: encodeFilters(next), row: undefined })}
          onDraft={(kql) => {
            setDraft({ kql, target: selected.target })
            set({ row: undefined })
          }}
        />
      ) : (
        <aside className="cw-ws-rail" aria-label="Hunt evidence">
          <Entities summary={summary} onFilter={(col, value) => set({ f: encodeFilters([...filters, { col, op: 'eq', value }]), row: undefined })} />
          <Timeline
            data={data}
            filter={sp.tl ?? 'all'}
            onFilter={(tl) => set({ tl: tl === 'all' ? undefined : tl }, { replace: true })}
            onOpen={(q) => set({ q, row: undefined, f: undefined, s: undefined, ev: undefined })}
            onOpenRun={(ev, q) => set({ q, ev, row: undefined, f: undefined, s: undefined })}
          />
          <NoteForm huntId={hunt.id} note={note} setNote={setNote} onError={setError} />
        </aside>
      )}
    </div>
  )
}

function SearchPanel({
  p,
  summary,
  runAt,
  onShowOriginal,
  ordered,
  filters,
  sort,
  row,
  onRow,
  onSort,
  onFilters,
  onError,
  onDraft,
}: {
  p: Proposal
  summary: Summary | null
  runAt?: string
  onShowOriginal?: () => void
  ordered: Array<{ row: Row; index: number }>
  filters: Filter[]
  sort: Sort
  row: number | null
  onRow: (row: number | null) => void
  onSort: (s: Sort) => void
  onFilters: (f: Filter[]) => void
  onError: (e: string | null) => void
  onDraft: (kql: string) => void
}) {
  const router = useRouter()
  const [kql, setKql] = useState(p.kql)
  const [busy, setBusy] = useState(false)
  const s = summary
  const pending = p.status === 'proposed'
  const edited = pending && kql.trim() !== p.originalKql.trim()
  const visible = ordered

  return (
    <section className="cw-panel2" aria-labelledby="search-title">
      <div className="cw-panel2-head">
        <h2 id="search-title">{pending ? 'Review this search' : runAt ? 'Repeat search run' : 'Search'}</h2>
        <StatusTag status={p.status} />
        <span className="cw-muted">{TARGET_LABEL[p.target]}</span>
        {s?.mode && <ModeTag mode={s.mode} />}
        <span style={{ marginLeft: 'auto' }} className="cw-row" data-center>
          {!pending && (
            <button type="button" className="cw-btn" data-variant="ghost" data-size="sm" onClick={() => onDraft(p.kql)}>
              Edit as new search
            </button>
          )}
        </span>
      </div>
      <div className="cw-panel2-body">
        {p.rationale && <p style={{ marginBottom: 'var(--space-xs)' }}>{p.rationale}</p>}
        {pending ? (
          <>
            <p className="cw-muted">
              Nothing has run yet. Read the <Term k="kql">KQL</Term>, change it if needed, then approve to run it once. What you approve is exactly what runs.
            </p>
            <div className="cw-editor">
              <label className="cw-sr-only" htmlFor={`kql-${p.id}`}>
                Query to approve
              </label>
              <textarea id={`kql-${p.id}`} className="mono" rows={Math.min(10, Math.max(3, kql.split('\n').length + 1))} value={kql} onChange={(e) => setKql(e.target.value)} spellCheck={false} />
              <div className="cw-editor-bar">
                <span>{edited ? 'Edited from the proposal. The edited query is what will run.' : 'Unchanged from the proposal.'}</span>
                {edited && (
                  <button type="button" className="cw-linkbtn" onClick={() => setKql(p.originalKql)}>
                    Restore original
                  </button>
                )}
              </div>
            </div>
            <div className="cw-row" style={{ marginTop: 'var(--space-sm)' }}>
              <button
                type="button"
                className="cw-btn"
                disabled={busy || !kql.trim()}
                data-state={busy ? 'loading' : undefined}
                onClick={async () => {
                  setBusy(true)
                  const r = await approveKqlFn({ data: { proposalId: p.id, kql } })
                  setBusy(false)
                  onError(r.ok ? (r.status === 'failed' ? r.error : null) : r.error)
                  await router.invalidate()
                }}
              >
                {busy ? 'Running…' : 'Approve and run'}
              </button>
              <button
                type="button"
                className="cw-btn"
                data-variant="ghost"
                disabled={busy}
                onClick={async () => {
                  const r = await rejectKqlFn({ data: { proposalId: p.id } })
                  onError(r.ok ? null : r.error)
                  await router.invalidate()
                }}
              >
                Reject
              </button>
              <span className="cw-muted">Expires {fmtTime(p.expiresAt)}</span>
            </div>
          </>
        ) : (
          <pre aria-label="Query that ran">{p.kql}</pre>
        )}
        {p.error && (
          <Notice tone="error" title={p.status === 'failed' ? 'The search failed' : undefined}>
            {p.error}
          </Notice>
        )}
        {p.status === 'expired' && <Notice tone="warn">This proposal expired before anyone approved it. Use “Edit as new search” to propose it again.</Notice>}
        {p.status === 'rejected' && <p className="cw-muted">Rejected. It did not run.</p>}
      </div>

      {runAt && (
        <div className="cw-panel2-foot" style={{ borderTop: 0 }}>
          <span>
            Showing the sample from the repeat run at {fmtTime(runAt)}.{' '}
            <button type="button" className="cw-linkbtn" onClick={onShowOriginal}>
              Show the original run
            </button>
          </span>
        </div>
      )}
      {p.status === 'run' && s && (
        <>
          <div className="cw-panel2-foot" style={{ borderTop: 0, borderBottom: '1px solid var(--border)' }}>
            <dl className="cw-runstats">
              <div>
                <dt>Rows returned</dt>
                <dd className="num">
                  {s.rowCount ?? 'not recorded'}
                  {s.truncated ? ' (capped by row limit)' : ''}
                </dd>
              </div>
              <div>
                <dt>Stored sample</dt>
                <dd className="num">{s.sample?.length ?? 0} rows</dd>
              </div>
              <div>
                <dt>Ran</dt>
                <dd>{p.ranAt ? <Freshness at={p.ranAt} /> : 'not recorded'}</dd>
              </div>
              <div>
                <dt>Duration</dt>
                <dd className="num">{s.durationMs !== undefined ? `${s.durationMs} ms` : 'not recorded'}</dd>
              </div>
              <div>
                <dt>Approved by</dt>
                <dd>{p.decidedBy ? 'a person, see timeline' : 'not recorded'}</dd>
              </div>
            </dl>
          </div>
          <div className="cw-panel2-body">
            {!s.sample?.length ? (
              <p className="cw-empty">{s.rowCount === 0 ? 'The search ran and returned no rows. That is a result: nothing matched in the queried time range.' : 'Rows were returned but no sample was stored, so there is nothing to inspect here.'}</p>
            ) : (
              <>
                {(s.rowCount ?? 0) > s.sample.length && (
                  <Notice tone="info">
                    Showing a stored sample of {s.sample.length} of {s.rowCount} rows. Filters and sorting apply to this sample only. To see more, refine the search and run it again.
                  </Notice>
                )}
                <FilterChips filters={filters} onRemove={(i) => onFilters(filters.filter((_, j) => j !== i))} onClear={() => onFilters([])} />
                {visible.length === 0 ? (
                  <p className="cw-empty">No rows in the sample match these filters. Remove a filter to see rows again.</p>
                ) : (
                  <ResultGrid
                    columns={s.columns ?? Object.keys(s.sample[0] ?? {})}
                    rows={visible}
                    selected={row}
                    onSelect={onRow}
                    sort={sort}
                    onSort={onSort}
                    caption={`${visible.length} of ${s.sample.length} sample rows${filters.length ? ' match the filters' : ''}`}
                  />
                )}
              </>
            )}
          </div>
        </>
      )}
    </section>
  )
}

function RowInspector({
  p,
  summary,
  rowIndex,
  ordered,
  filters,
  onRow,
  onFilters,
  onDraft,
}: {
  p: Proposal
  summary: Summary
  rowIndex: number
  ordered: Array<{ row: Row; index: number }>
  filters: Filter[]
  onRow: (row: number | null) => void
  onFilters: (f: Filter[]) => void
  onDraft: (kql: string) => void
}) {
  const sample = summary.sample ?? []
  const visible = ordered.map((r) => r.index)
  const pos = visible.indexOf(rowIndex)
  const columns = summary.columns ?? Object.keys(sample[0] ?? {})
  return (
    <Inspector
      title={`Row ${rowIndex + 1}`}
      position={pos >= 0 ? `${pos + 1} of ${visible.length}` : ''}
      row={sample[rowIndex]!}
      columns={columns}
      onClose={() => {
        onRow(null)
        // Return focus to the row the analyst was last on (the one now shown), after the inert
        // background is released and the grid has re-rendered.
        requestAnimationFrame(() => requestAnimationFrame(() => document.querySelector<HTMLElement>(`tr[data-index="${rowIndex}"]`)?.focus()))
      }}
      onPrev={pos > 0 ? () => onRow(visible[pos - 1]!) : undefined}
      onNext={pos >= 0 && pos < visible.length - 1 ? () => onRow(visible[pos + 1]!) : undefined}
      onFilter={(col, op, value) => onFilters([...filters, { col, op, value }])}
      onAddToSearch={(col, value) => onDraft(`${p.kql.replace(/\s*\|\s*take\s+\d+\s*$/i, '')}\n| where ${kqlIdentifier(col)} == ${kqlLiteral(value)}\n| take 100`)}
      provenance={
        <dl className="cw-provenance">
          <dt>Source</dt>
          <dd>{TARGET_LABEL[p.target]}</dd>
          <dt>Data</dt>
          <dd>
            <ModeTag mode={summary.mode} />
          </dd>
          <dt>Ran</dt>
          <dd>{p.ranAt ? fmtTime(p.ranAt) : 'not recorded'}</dd>
          <dt>Proposed by</dt>
          <dd>{p.proposedByType === 'agent' ? `agent ${p.proposedById}` : 'an analyst'}</dd>
          <dt>Query</dt>
          <dd>
            <pre style={{ margin: 0 }}>{p.kql}</pre>
          </dd>
        </dl>
      }
    />
  )
}

function Entities({ summary, onFilter }: { summary: Summary | null; onFilter: (col: string, value: string) => void }) {
  const s = summary
  const { groups, timeCol } = useMemo(() => summariseEntities(s?.columns ?? Object.keys(s?.sample?.[0] ?? {}), s?.sample ?? []), [s])
  return (
    <section className="cw-rail-section" aria-labelledby="entities-title">
      <h2 id="entities-title">Entities in this result</h2>
      {!s?.sample?.length ? (
        <p className="cw-empty">Run a search to see the devices, accounts and URLs it returned.</p>
      ) : groups.length === 0 ? (
        <p className="cw-empty">No device, account, file or network columns in this result.</p>
      ) : (
        <>
          <p className="cw-muted">Counted within the {s.sample.length}-row sample. Select a value to filter the results.</p>
          <div className="cw-entities">
            {groups.map((g) => (
              <div className="cw-entity" key={g.column}>
                <h3>
                  {g.kind} <span className="mono">({g.column})</span>
                </h3>
                <ul>
                  {g.values.map((v) => (
                    <li key={v.value}>
                      <button type="button" onClick={() => onFilter(g.column, v.value)} title={timeCol && v.first ? `${timeCol}: first ${v.first}, last ${v.last}` : v.value}>
                        {v.value}
                      </button>
                      <span>{v.count}×</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  )
}

const TL_TYPES: Record<string, Array<string>> = {
  searches: ['kql_proposed', 'kql_approved', 'kql_rejected'],
  results: ['kql_result', 'kql_failed', 'scheduled_result', 'scheduled_failed'],
  notes: ['note'],
  schedules: ['schedule_created', 'schedule_disabled', 'scheduled_result', 'scheduled_failed'],
}
const EVIDENCE_LABEL: Record<string, string> = {
  note: 'Note',
  kql_proposed: 'Search proposed',
  kql_approved: 'Search approved',
  kql_rejected: 'Search rejected',
  kql_result: 'Search results',
  kql_failed: 'Search failed',
  schedule_created: 'Repeat search scheduled',
  schedule_disabled: 'Repeat search paused',
  scheduled_result: 'Repeat search results',
  scheduled_failed: 'Repeat search failed',
  incidents: 'Incidents checked',
  response_proposed: 'Action proposed',
}

function Timeline({
  data,
  filter,
  onFilter,
  onOpen,
  onOpenRun,
}: {
  data: Data
  filter: string
  onFilter: (f: 'all' | 'searches' | 'results' | 'notes' | 'schedules') => void
  onOpen: (q: string) => void
  onOpenRun: (eventId: string, proposalId: string) => void
}) {
  // A schedule is created from one proposal, so its runs map back to that search.
  const scheduleSource = new Map<string, string>()
  for (const e of data.evidence) {
    const pl = e.payload as Record<string, unknown>
    if (e.type === 'schedule_created' && typeof pl.scheduleId === 'string' && typeof pl.proposalId === 'string') scheduleSource.set(pl.scheduleId, pl.proposalId)
  }
  const items = [...data.evidence].reverse().filter((e) => filter === 'all' || TL_TYPES[filter]?.includes(e.type))
  return (
    <section className="cw-rail-section" aria-labelledby="timeline-title">
      <h2 id="timeline-title">Evidence timeline</h2>
      <div className="cw-segmented" role="group" aria-label="Show in timeline" style={{ marginBottom: 'var(--space-sm)', flexWrap: 'wrap' }}>
        {(['all', 'searches', 'results', 'notes', 'schedules'] as const).map((k) => (
          <button key={k} type="button" aria-pressed={filter === k} onClick={() => onFilter(k)}>
            {k === 'all' ? 'All' : k[0]!.toUpperCase() + k.slice(1)}
          </button>
        ))}
      </div>
      {items.length === 0 ? (
        <p className="cw-empty">Nothing here yet.</p>
      ) : (
        <ol className="cw-timeline" aria-label="Newest first">
          {items.map((e) => {
            const pl = e.payload as Record<string, unknown>
            const runOf = e.type === 'scheduled_result' && typeof pl.scheduleId === 'string' ? scheduleSource.get(pl.scheduleId) : undefined
            const proposalId = typeof pl.proposalId === 'string' ? pl.proposalId : null
            const kind = e.type.endsWith('result') ? 'result' : e.type.endsWith('failed') ? 'failed' : e.type === 'note' ? 'note' : undefined
            const label = EVIDENCE_LABEL[e.type] ?? e.type.replace(/_/g, ' ')
            return (
              <li key={e.id} data-kind={kind}>
                {runOf && Array.isArray(pl.sample) ? (
                  <button type="button" className="cw-tl-btn" onClick={() => onOpenRun(e.id, runOf)}>
                    {label}
                  </button>
                ) : proposalId ? (
                  <button type="button" className="cw-tl-btn" onClick={() => onOpen(proposalId)}>
                    {label}
                  </button>
                ) : (
                  <span className="cw-ev-label">{label}</span>
                )}
                <span className="cw-tl-time">
                  <time dateTime={e.createdAt}>{fmtTime(e.createdAt)}</time> · {e.actorType === 'agent' ? (e.actorId ?? 'agent') : e.actorType === 'user' ? 'a person' : 'Crosswire'}
                </span>
                {typeof pl.note === 'string' && <p>{pl.note}</p>}
                {typeof pl.rowCount === 'number' && (
                  <p className="cw-muted">
                    {pl.rowCount} rows · {pl.mode === 'demo' ? 'demo data' : 'live data'}
                    {typeof pl.previousRowCount === 'number' ? ` (was ${pl.previousRowCount})` : ''}
                  </p>
                )}
                {typeof pl.error === 'string' && <p className="cw-muted">{pl.error}</p>}
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}

function NoteForm({ huntId, note, setNote, onError }: { huntId: string; note: string; setNote: (n: string) => void; onError: (e: string | null) => void }) {
  const router = useRouter()
  const [saving, setSaving] = useState(false)
  return (
    <section className="cw-rail-section">
      <form
        className="cw-form"
        onSubmit={async (e) => {
          e.preventDefault()
          setSaving(true)
          try {
            await addNote({ data: { huntId, note } })
            setNote('')
            onError(null)
            await router.invalidate()
          } catch (err) {
            onError(`Note not saved: ${err instanceof Error ? err.message : String(err)}`)
          } finally {
            setSaving(false)
          }
        }}
      >
        <label>
          Add a note
          <span className="cw-help">What you found, what you ruled out, or what to check next.</span>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} required maxLength={4000} />
        </label>
        <div>
          <button className="cw-btn" data-variant="ghost" type="submit" disabled={saving || !note.trim()}>
            {saving ? 'Saving…' : 'Add note'}
          </button>
        </div>
      </form>
    </section>
  )
}

function ProposeSearch({ huntId, draft, onDone, onError }: { huntId: string; draft: { kql: string; target: 'defender' | 'sentinel' } | null; onDone: () => void; onError: (e: string | null) => void }) {
  const router = useRouter()
  const [target, setTarget] = useState<'defender' | 'sentinel'>(draft?.target ?? 'defender')
  const [kql, setKql] = useState(draft?.kql ?? '')
  const [open, setOpen] = useState(Boolean(draft))
  const [lastDraft, setLastDraft] = useState(draft)
  if (draft !== lastDraft) {
    setLastDraft(draft)
    if (draft) {
      setKql(draft.kql)
      setTarget(draft.target)
      setOpen(true)
      requestAnimationFrame(() => document.getElementById('new-kql')?.focus())
    }
  }
  return (
    <details className="cw-panel2" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary className="cw-panel2-head" style={{ cursor: 'pointer' }}>
        <h2 style={{ display: 'inline' }}>Propose a new search</h2>
        <span className="cw-muted">It will wait for review before it runs.</span>
      </summary>
      <form
        className="cw-panel2-body cw-form"
        data-wide
        onSubmit={async (e) => {
          e.preventDefault()
          const r = await proposeKqlFn({ data: { huntId, target, kql } })
          if (!r.ok) return onError(r.error)
          onError(null)
          setKql('')
          onDone()
          await router.invalidate()
        }}
      >
        <label style={{ maxWidth: 320 }}>
          Search in
          <select value={target} onChange={(e) => setTarget(e.target.value as 'defender' | 'sentinel')}>
            <option value="defender">Defender XDR (devices, email, identity)</option>
            <option value="sentinel">Sentinel (central log store)</option>
          </select>
        </label>
        <div>
          <label htmlFor="new-kql">KQL</label>
          <div className="cw-editor" style={{ marginTop: 'var(--space-2xs)' }}>
            <textarea id="new-kql" className="mono" rows={5} value={kql} onChange={(e) => setKql(e.target.value)} required spellCheck={false} placeholder="DeviceProcessEvents | where Timestamp > ago(1d) | take 100" />
            <div className="cw-editor-bar">
              <span>Keep results small with “| take 100”. Crosswire caps rows and blocks external data and management commands.</span>
            </div>
          </div>
        </div>
        <div>
          <button className="cw-btn" type="submit" disabled={!kql.trim()}>
            Propose search
          </button>
        </div>
      </form>
    </details>
  )
}

function Schedules({ data, onError }: { data: Data; onError: (e: string | null) => void }) {
  const router = useRouter()
  const ran = data.proposals.filter((p) => p.status === 'run')
  const [every, setEvery] = useState(1440)
  const [picked, setPick] = useState<string | null>(null)
  // Derived each render, so a search that ran after the page opened is selectable and submitted correctly.
  const pick = picked && ran.some((p) => p.id === picked) ? picked : (ran[0]?.id ?? '')
  return (
    <section className="cw-panel2" aria-labelledby="sched-title">
      <div className="cw-panel2-head">
        <h2 id="sched-title">Repeat searches</h2>
        <span className="cw-muted">Re-run an approved search on a schedule. Approval lasts up to 30 days.</span>
      </div>
      <div className="cw-panel2-body">
        {data.schedules.length === 0 ? (
          <p className="cw-empty">No repeat searches.</p>
        ) : (
          <div className="cw-tablewrap">
            <table className="cw-table">
              <thead>
                <tr>
                  <th scope="col">Query</th>
                  <th scope="col">Every</th>
                  <th scope="col">State</th>
                  <th scope="col">Last run</th>
                  <th scope="col">Approval until</th>
                  <th scope="col">
                    <span className="cw-sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.schedules.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <code style={{ display: 'block', maxWidth: '44ch', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={s.kql}>
                        {s.kql}
                      </code>
                      <span className="cw-muted">{TARGET_LABEL[s.target]}</span>
                    </td>
                    <td className="num">{s.intervalMinutes >= 1440 ? `${s.intervalMinutes / 1440} day` : `${s.intervalMinutes / 60} h`}</td>
                    <td>
                      {s.enabled ? <span className="cw-badge" data-tone="ok">Active</span> : <span className="cw-badge">Paused</span>}
                      {!s.enabled && s.disabledReason && <div className="cw-muted">{s.disabledReason}</div>}
                      {s.enabled && <div className="cw-muted">next {fmtTime(s.nextRunAt)}</div>}
                    </td>
                    <td>
                      {s.lastRunAt ? (
                        <>
                          <Freshness at={s.lastRunAt} /> {s.lastRowCount !== null && <span className="num">· {s.lastRowCount} rows</span>}
                        </>
                      ) : (
                        <span className="cw-muted">not run yet</span>
                      )}
                      {s.lastError && <p className="cw-field-error" style={{ marginTop: 4 }}>{s.lastError}</p>}
                    </td>
                    <td>{fmtTime(s.approvalExpiresAt)}</td>
                    <td>
                      {data.canApprove ? (
                        <button
                          type="button"
                          className="cw-btn"
                          data-variant="ghost"
                          data-size="sm"
                          onClick={async () => {
                            const r = s.enabled ? await disableScheduleFn({ data: { id: s.id } }) : await reapproveScheduleFn({ data: { id: s.id } })
                            onError(r.ok ? null : r.error)
                            await router.invalidate()
                          }}
                        >
                          {s.enabled ? 'Pause' : 'Re-approve and resume'}
                        </button>
                      ) : (
                        <span className="cw-muted">Approvers manage this</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {ran.length > 0 &&
          (data.canApprove ? (
            <div className="cw-row" style={{ marginTop: 'var(--space-sm)' }}>
              <label className="cw-grow" style={{ maxWidth: 420 }}>
                Search to repeat
                <select value={pick} onChange={(e) => setPick(e.target.value)}>
                  {ran.map((p) => (
                    <option key={p.id} value={p.id}>
                      {TARGET_LABEL[p.target]}: {p.kql.slice(0, 70)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Every
                <select aria-label="Schedule interval" value={every} onChange={(e) => setEvery(Number(e.target.value))}>
                  <option value={60}>hour</option>
                  <option value={360}>6 hours</option>
                  <option value={1440}>day</option>
                  <option value={10080}>week</option>
                </select>
              </label>
              <button
                type="button"
                className="cw-btn"
                data-variant="ghost"
                onClick={async () => {
                  const r = await createScheduleFn({ data: { proposalId: pick, intervalMinutes: every } })
                  onError(r.ok ? null : r.error)
                  await router.invalidate()
                }}
              >
                Schedule (30-day approval)
              </button>
            </div>
          ) : (
            <p className="cw-muted" style={{ marginTop: 'var(--space-sm)' }}>
              Approvers and owners can turn a search that ran into a repeat search. Your role is {data.role}.
            </p>
          ))}
      </div>
    </section>
  )
}

function ExportButton({ huntId, onError }: { huntId: string; onError: (e: string | null) => void }) {
  const [busy, setBusy] = useState(false)
  return (
    <button
      type="button"
      className="cw-btn"
      data-variant="ghost"
      disabled={busy}
      onClick={async () => {
        setBusy(true)
        try {
          const r = await huntReportFn({ data: { huntId } })
          const url = URL.createObjectURL(new Blob([r.markdown], { type: 'text/markdown' }))
          const a = document.createElement('a')
          a.href = url
          a.download = r.filename
          a.click()
          URL.revokeObjectURL(url)
        } catch (err) {
          onError(err instanceof Error ? err.message : String(err))
        } finally {
          setBusy(false)
        }
      }}
    >
      {busy ? 'Exporting…' : 'Export report'}
    </button>
  )
}
