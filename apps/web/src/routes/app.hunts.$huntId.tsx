import { Link, createFileRoute, notFound, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { z } from 'zod'
import { fetchHunt } from '../fns/hunts'
import { fmtTime, plural } from '../components/format'
import { Notice, SkeletonPage } from '../components/ui'
import { RouteError, pageTitle } from '../components/errors'
import { safeHref } from '../shared/links'
import { canApproveEveryProposal } from '../shared/kql-approval'
import { HIT_ANSWER, OUTCOME_LABEL } from '../shared/indicator-playbooks'
import { ModeTag, StatusTag, TARGET_LABEL } from '../components/signals'
import { applyFilters, decodeFilters, decodeSort, encodeFilters, encodeSort, sortRows } from '../components/results'
import { coverageFor, summaryOf, type Data, type Proposal, type Summary } from './-hunts/model'
import { personName, shownKql, type KqlEdits } from './-hunts/helpers'
import { SearchPanel, RowInspector } from './-hunts/search-panel'
import { Entities, NoteForm, Timeline } from './-hunts/rail'
import { ProposeSearch, type Draft } from './-hunts/propose'
import { Schedules } from './-hunts/schedules'
import { ApproveAllButton, CopyAnswerButton, ExportButton, HuntStatusButton } from './-hunts/actions'

/**
 * Hunt workspace (reference slice for the analyst design system, see design.md).
 * View state lives in the URL so reload, back/forward and shared links restore the exact view:
 *   q   selected search id      row  selected row in that search's sample
 *   f   result filters          s    result sort (shared by grid and inspector)
 *   tl  timeline filter         ev   a repeat-search run whose sample is shown
 * The views live in ./-hunts/ (TanStack Router ignores "-" folders); this file keeps the loader and layout.
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
  // A different hunt is a fresh page: no note, draft or edited query carries across (#125).
  remountDeps: ({ params }) => params,
  pendingComponent: () => <SkeletonPage label="Loading this hunt" />,
  errorComponent: ({ error }) => <RouteError error={error} title="This hunt did not load" />,
  notFoundComponent: () => (
    <div className="cw-pad-lg">
      <h1>Hunt not found</h1>
      <p className="cw-muted">It may have been removed, or it belongs to another organisation.</p>
      <Link to="/app/hunts">Back to all hunts</Link>
    </div>
  ),
  head: ({ loaderData }) => ({ meta: [{ title: pageTitle(loaderData?.hunt.title, 'Hunt') }] }),
  component: HuntWorkspace,
})

function CoverageSummary({ proposals }: { proposals: Proposal[] }) {
  if (!proposals.length) return null
  const coverage = coverageFor(proposals)
  return (
    <section aria-label="What was checked" className="cw-mt-sm">
      <p>
        <strong>Any hits?</strong> {HIT_ANSWER[coverage.answer]} <span className="cw-muted">{coverage.ran} of {coverage.total} checks ran.</span>
      </p>
      <ul>
        {coverage.rows.map((row, index) => (
          <li key={`${row.name}-${index}`}>
            {row.name}: {OUTCOME_LABEL[row.outcome]}
            {row.rowCount !== null ? ` (${plural(row.rowCount, 'row')})` : ''}
          </li>
        ))}
      </ul>
    </section>
  )
}

/**
 * Move focus once the URL has updated and any inert background is released. Navigation and the
 * overlay clean-up can take a few frames, so it retries briefly until focus lands.
 */
function focusWhenReady(selector: string) {
  let tries = 0
  const land = () => {
    const el = document.querySelector<HTMLElement>(selector)
    if (el && !el.closest('[inert]')) el.focus()
    if (document.activeElement !== el && ++tries < 20) requestAnimationFrame(land)
  }
  requestAnimationFrame(land)
}

function HuntWorkspace() {
  const data: Data = Route.useLoaderData()
  const { hunt, proposals, origin, demoMode, people } = data
  const sp = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const [draft, setDraft] = useState<Draft | null>(null)
  // Lives above the rail so opening the inspector (which replaces the rail) never drops a draft.
  const [note, setNote] = useState('')
  // Edited KQL per pending search. Shared so "Approve all" sends what each panel shows (#123).
  const [edits, setEdits] = useState<KqlEdits>({})

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

  /**
   * Every way of closing the inspector goes through here (#163), so focus never drops to the top of
   * the page. By default it returns to the grid row the inspector was showing (the one the analyst
   * opened or stepped to); a pivot that opens the propose form sends it there instead.
   */
  const closeInspector = (patch: Partial<z.infer<typeof search>> = {}, focus?: string) => {
    const row = inspecting
    void set({ row: undefined, ...patch })
    const target = focus ?? (row !== null ? `.cw-grid-table tr[data-index="${row}"]` : null)
    if (target) focusWhenReady(target)
  }

  const originHref = origin ? safeHref(origin.url) : undefined
  const activeSchedules = data.schedules.filter((s) => s.enabled).length

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
        <header className="cw-pagehead cw-mb0">
          <div>
            <h1>{hunt.title}</h1>
            <p>{hunt.hypothesis || <span>No hypothesis yet. Add a note saying what you suspect, so agents can suggest searches.</span>}</p>
            <CoverageSummary proposals={proposals} />
          </div>
          <div className="cw-pagehead-actions">
            <ApproveAllButton allowed={canApproveEveryProposal(data.kqlApprovalPolicy, { userId: data.userId, role: data.role }, proposals)} proposals={proposals} edits={edits} />
            {proposals.length > 0 && <CopyAnswerButton proposals={proposals} />}
            <ExportButton huntId={hunt.id} />
            <HuntStatusButton hunt={hunt} activeSchedules={activeSchedules} />
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
                originHref ? (
                  <a href={originHref} target="_blank" rel="noreferrer noopener" title={origin.title}>
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
                <li key={p.id} className="cw-contents">
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
                      <span>proposed by {p.proposedByType === 'agent' ? p.proposedById : personName(people, p.proposedById)}</span>
                      {p.status === 'proposed' && edits[p.id] !== undefined && edits[p.id]!.trim() !== p.kql.trim() && <span>edited, not yet approved</span>}
                      {p.status === 'run' && s && <span className="num">{s.rowCount === undefined ? 'rows not recorded' : plural(s.rowCount, 'row')}</span>}
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
            kql={shownKql(selected, edits)}
            onKql={(kql) => setEdits((cur) => ({ ...cur, [selected.id]: kql }))}
            people={people}
            summary={summary}
            runAt={runEvent?.createdAt}
            onShowOriginal={runEvent ? () => set({ ev: undefined, row: undefined, f: undefined }) : undefined}
            ordered={ordered}
            filters={filters}
            sort={sort}
            row={inspecting}
            onRow={(row) => (row === null ? closeInspector() : set({ row }, { replace: sp.row !== undefined }))}
            onSort={(next) => set({ s: encodeSort(next) }, { replace: true })}
            onFilters={(next) => set({ f: encodeFilters(next), row: undefined })}
            onDraft={(kql) => setDraft({ kql, target: selected.target })}
            approval={{ policy: data.kqlApprovalPolicy, canApprove: data.canApprove, userId: data.userId, role: data.role }}
          />
        )}

        <ProposeSearch huntId={hunt.id} draft={draft} onDone={() => setDraft(null)} />
        <Schedules data={data} />
      </div>

      {inspecting !== null && summary?.sample && selected ? (
        <RowInspector
          p={selected}
          people={people}
          summary={summary}
          rowIndex={inspecting}
          ordered={ordered}
          filters={filters}
          onRow={(row) => set({ row }, { replace: true })}
          onClose={() => closeInspector()}
          onFilters={(next) => closeInspector({ f: encodeFilters(next) }, '.cw-grid-table tbody tr[tabindex="0"]')}
          onDraft={(kql) => {
            setDraft({ kql, target: selected.target })
            closeInspector({}, '#new-kql')
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
          <NoteForm huntId={hunt.id} note={note} setNote={setNote} />
        </aside>
      )}
    </div>
  )
}
