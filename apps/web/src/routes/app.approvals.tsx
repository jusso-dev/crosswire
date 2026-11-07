import { Link, Outlet, createFileRoute, useMatchRoute, useNavigate } from '@tanstack/react-router'
import { z } from 'zod'
import { fetchProposals } from '../fns/approvals'
import { fmtTime } from '../components/format'
import { Notice, Term } from '../components/ui'
import { Freshness, StatusTag } from '../components/signals'

/** Approvals inbox: Waiting / Decided / All, like an action centre's Pending vs History split. */
export const Route = createFileRoute('/app/approvals')({
  validateSearch: z.object({ view: z.enum(['waiting', 'decided', 'all']).optional() }),
  loader: () => fetchProposals(),
  pendingComponent: () => <p className="cw-muted">Loading approvals…</p>,
  errorComponent: ({ error }) => (
    <Notice tone="error" title="Could not load approvals">
      {error instanceof Error ? error.message : String(error)}
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
  if (matchRoute({ to: '/app/approvals/$id', fuzzy: true })) return <Outlet />
  const waiting = proposals.filter((p) => WAITING.includes(p.status))
  const shown = view === 'all' ? proposals : view === 'waiting' ? waiting : proposals.filter((p) => !WAITING.includes(p.status))
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
      <div className="cw-tablewrap" style={{ overflow: 'visible' }}>
        <div className="cw-toolbar" style={{ borderRadius: 'var(--radius-lg) var(--radius-lg) 0 0' }}>
          <div className="cw-segmented" role="group" aria-label="Show">
            {(['waiting', 'decided', 'all'] as const).map((v) => (
              <button key={v} type="button" aria-pressed={view === v} onClick={() => navigate({ search: { view: v === 'waiting' ? undefined : v }, replace: true })}>
                {v === 'waiting' ? `Waiting (${waiting.length})` : v === 'decided' ? `Decided (${proposals.length - waiting.length})` : `All (${proposals.length})`}
              </button>
            ))}
          </div>
          <span className="cw-toolbar-meta">Nothing changes in your tenant without an approver.</span>
        </div>
        <div style={{ overflowX: 'auto' }}>
          {shown.length === 0 ? (
            <p className="cw-empty" style={{ padding: 'var(--space-md)' }}>
              {view === 'waiting' ? 'Nothing is waiting for a decision. When Responder or an analyst proposes an action, it appears here.' : 'No actions in this view.'}
            </p>
          ) : (
            <table className="cw-table">
              <thead>
                <tr>
                  <th scope="col">Action</th>
                  <th scope="col">Type</th>
                  <th scope="col" className="num">Devices</th>
                  <th scope="col" className="num">Users</th>
                  <th scope="col">Asked by</th>
                  <th scope="col">Status</th>
                  <th scope="col">Created</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((p) => (
                  <tr key={p.id}>
                    <td style={{ maxWidth: '56ch' }}>
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
                    <td title={fmtTime(p.createdAt)}>
                      <Freshness at={p.createdAt} />
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
