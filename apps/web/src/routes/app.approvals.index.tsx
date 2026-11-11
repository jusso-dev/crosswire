import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { z } from 'zod'
import { fetchInbox } from '../fns/approvals'
import { fmtTime, plural } from '../components/format'
import { EmptyState, Notice, Term, SkeletonPage } from '../components/ui'
import { listKeys } from '../components/keys'
import { useAction } from '../components/action'
import { plainMessage } from '../shared/messages'
import { responseActionLabel } from '../shared/labels'
import type { ResponseProposalView } from '../shared/response'
import { Freshness, StatusTag } from '../components/signals'
import { pageTitle } from '../components/errors'

/**
 * Approvals inbox: Waiting / Decided / All, like an action centre's Pending vs History split. Waiting
 * is its own uncapped query, so a pending action is always listed whatever the history size. Decided
 * and All are paged ("Load older"). Tab counts come from count(*), not from the rows shown.
 */
export const Route = createFileRoute('/app/approvals/')({
  validateSearch: z.object({ view: z.enum(['waiting', 'decided', 'all']).optional() }),
  loaderDeps: ({ search }) => ({ view: search.view ?? 'waiting' }),
  loader: ({ deps }) => fetchInbox({ data: { view: deps.view } }),
  pendingComponent: () => <SkeletonPage label="Loading approvals" />,
  errorComponent: ({ error }) => (
    <Notice tone="error" title="Approvals did not load">
      {plainMessage(error)} Refresh the page to try again.
    </Notice>
  ),
  head: () => ({ meta: [{ title: pageTitle('Approvals') }] }),
  component: Approvals,
})

function Approvals() {
  const inbox = Route.useLoaderData()
  const { view = 'waiting' } = Route.useSearch()
  const navigate = useNavigate({ from: '/app/approvals/' })
  const { counts } = inbox
  return (
    <>
      <header className="cw-pagehead">
        <div>
          <h1>Approvals</h1>
          <p>
            Actions that would change something in Microsoft wait here. An <Term k="approver">approver</Term> who did not ask for the action checks its <Term k="blastRadius">blast radius</Term>, runs a <Term k="dryRun">dry run</Term>, then decides.
          </p>
        </div>
      </header>
      {counts.expiringSoon > 0 && (
        <Notice tone="warn" title={`${plural(counts.expiringSoon, 'action')} expire${counts.expiringSoon === 1 ? 's' : ''} within 3 hours`}>
          An action that expires cannot run. Decide it, or ask for a new one later.
        </Notice>
      )}
      <div className="cw-tablewrap cw-overflow-visible">
        <div className="cw-toolbar cw-attached">
          <div className="cw-segmented" role="group" aria-label="Show">
            {(['waiting', 'decided', 'all'] as const).map((v) => (
              <button key={v} type="button" aria-pressed={view === v} onClick={() => navigate({ search: { view: v === 'waiting' ? undefined : v }, replace: true })}>
                {v === 'waiting' ? `Waiting (${counts.waiting})` : v === 'decided' ? `Decided (${counts.decided})` : `All (${counts.all})`}
              </button>
            ))}
          </div>
          <span className="cw-toolbar-meta">Nothing changes in your tenant without an approver.</span>
        </div>
        {/* Keyed by view, so older pages loaded for one tab never show under another. */}
        <ProposalList key={view} view={view} first={inbox.items} firstHasMore={inbox.hasMore} total={view === 'waiting' ? counts.waiting : view === 'decided' ? counts.decided : counts.all} />
      </div>
    </>
  )
}

function ProposalList({ view, first, firstHasMore, total }: { view: 'waiting' | 'decided' | 'all'; first: ResponseProposalView[]; firstHasMore: boolean; total: number }) {
  const [older, setOlder] = useState<{ items: ResponseProposalView[]; hasMore: boolean } | null>(null)
  const { run, busy, error } = useAction()
  // Rows loaded with "Load older" stay after a refresh of the first page; drop any that are now in it.
  const firstIds = new Set(first.map((p) => p.id))
  const shown = [...first, ...(older?.items ?? []).filter((p) => !firstIds.has(p.id))]
  const hasMore = older ? older.hasMore : firstHasMore
  const loadOlder = () =>
    run('older', async () => {
      const last = shown.at(-1)
      if (view === 'waiting' || !last) return
      const page = await fetchInbox({ data: { view, before: last.id } })
      setOlder((prev) => ({ items: [...(prev?.items ?? []), ...page.items], hasMore: page.hasMore }))
    })

  return (
    <div className="cw-scroll-x">
      {shown.length === 0 ? (
        <div className="cw-pad">
          <EmptyState
            compact
            title={view === 'waiting' ? 'Nothing is waiting for a decision' : 'No actions in this view'}
            body={view === 'waiting' ? 'When Responder or an analyst proposes an action, such as isolating a device, it appears here for an approver.' : 'Pick Waiting or All to see other actions.'}
          />
        </div>
      ) : (
        <table className="cw-table" data-list>
          <thead>
            <tr>
              <th scope="col">Action</th>
              <th scope="col">Type</th>
              <th scope="col" className="num">
                Devices
              </th>
              <th scope="col" className="num">
                Users
              </th>
              <th scope="col">Asked by</th>
              <th scope="col">Status</th>
              <th scope="col">Expires</th>
            </tr>
          </thead>
          <tbody onKeyDown={listKeys}>
            {shown.map((p) => (
              <tr key={p.id} data-row>
                <td className="cw-cell-wide">
                  <Link to="/app/approvals/$id" params={{ id: p.id }}>
                    {p.title}
                  </Link>
                  {p.rollbackOfId && (
                    <span className="cw-badge" data-tone="info">
                      Rollback
                    </span>
                  )}
                  <div className="cw-muted">{p.blastRadius.summary}</div>
                </td>
                <td>{responseActionLabel(p.actionType, p.payload)}</td>
                <td className="num">{p.blastRadius.devices}</td>
                <td className="num">{p.blastRadius.users}</td>
                <td>{p.requesterType === 'agent' ? <span className="mono">{p.requesterId}</span> : 'an analyst'}</td>
                <td>
                  <StatusTag status={p.status} />
                </td>
                <td className="cw-nowrap">
                  <time dateTime={p.expiresAt}>{fmtTime(p.expiresAt)}</time>
                  <div className="cw-muted">
                    asked <Freshness at={p.createdAt} />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {(hasMore || error) && (
        <div className="cw-pad cw-row cw-approvals-more">
          <span className="cw-muted">
            Showing the latest {shown.length.toLocaleString('en-AU')} of {total.toLocaleString('en-AU')}.
          </span>
          {hasMore && (
            <button type="button" className="cw-btn" data-variant="ghost" data-size="sm" disabled={busy !== null} onClick={() => void loadOlder()}>
              {busy ? 'Loading…' : 'Load older'}
            </button>
          )}
          {error && (
            <span className="cw-confirm-error" role="alert">
              {error}
            </span>
          )}
        </div>
      )}
    </div>
  )
}
