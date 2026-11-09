import { Link, Outlet, createFileRoute, useMatchRoute, useNavigate } from '@tanstack/react-router'
import { z } from 'zod'
import { fetchProposals } from '../fns/approvals'
import { fmtTime } from '../components/format'
import { EmptyState, Notice, Term, SkeletonPage } from '../components/ui'
import { useListKeys } from '../components/keys'
import { plainMessage } from '../shared/messages'
import { Freshness, StatusTag } from '../components/signals'

/** Approvals inbox: Waiting / Decided / All, like an action centre's Pending vs History split. */
export const Route = createFileRoute('/app/approvals')({
  validateSearch: z.object({ view: z.enum(['waiting', 'decided', 'all']).optional() }),
  loader: () => fetchProposals(),
  pendingComponent: () => <SkeletonPage label="Loading approvals" />,
  errorComponent: ({ error }) => (
    <Notice tone="error" title="Approvals did not load">
      {plainMessage(error)} Refresh the page to try again.
    </Notice>
  ),
  component: Approvals,
})

const ACTION_LABEL: Record<string, string> = { sentinel_playbook: 'Run a Sentinel playbook', logic_app: 'Run a Logic App', graph_containment: 'Isolate a device', other: 'Other' }
const WAITING = ['pending', 'approved']

function Approvals() {
  const proposals = Route.useLoaderData()
  const { view = 'waiting' } = Route.useSearch()
  const navigate = useNavigate({ from: '/app/approvals' })
  const matchRoute = useMatchRoute()
  const list = useListKeys<HTMLTableSectionElement>()
  if (matchRoute({ to: '/app/approvals/$id', fuzzy: true })) return <Outlet />
  const waiting = proposals.filter((p) => WAITING.includes(p.status))
  // Waiting items lead with the one that expires first, so the most urgent decision is on top.
  const shown = view === 'all' ? proposals : view === 'waiting' ? [...waiting].sort((a, b) => a.expiresAt.localeCompare(b.expiresAt)) : proposals.filter((p) => !WAITING.includes(p.status))
  const soon = waiting.filter((p) => p.status === 'pending' && new Date(p.expiresAt).getTime() - Date.now() < 3 * 3_600_000).length
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
      {soon > 0 && (
        <Notice tone="warn" title={`${soon} action${soon === 1 ? '' : 's'} expire within 3 hours`}>
          An action that expires cannot run. Decide it, or ask for a new one later.
        </Notice>
      )}
      <div className="cw-tablewrap cw-overflow-visible">
        <div className="cw-toolbar cw-attached">
          <div className="cw-segmented" role="group" aria-label="Show">
            {(['waiting', 'decided', 'all'] as const).map((v) => (
              <button key={v} type="button" aria-pressed={view === v} onClick={() => navigate({ search: { view: v === 'waiting' ? undefined : v }, replace: true })}>
                {v === 'waiting' ? `Waiting (${waiting.length})` : v === 'decided' ? `Decided (${proposals.length - waiting.length})` : `All (${proposals.length})`}
              </button>
            ))}
          </div>
          <span className="cw-toolbar-meta">Nothing changes in your tenant without an approver.</span>
        </div>
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
                  <th scope="col" className="num">Devices</th>
                  <th scope="col" className="num">Users</th>
                  <th scope="col">Asked by</th>
                  <th scope="col">Status</th>
                  <th scope="col">Expires</th>
                </tr>
              </thead>
              <tbody ref={list.ref} onKeyDown={list.onKeyDown}>
                {shown.map((p) => (
                  <tr key={p.id} data-row>
                    <td className="cw-cell-wide">
                      <Link to="/app/approvals/$id" params={{ id: p.id }}>
                        {p.title}
                      </Link>
                      <div className="cw-muted">{p.blastRadius.summary}</div>
                    </td>
                    <td>{ACTION_LABEL[p.actionType] ?? p.actionType}</td>
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
        </div>
      </div>
    </>
  )
}
