import { Link, Outlet, createFileRoute, useMatchRoute } from '@tanstack/react-router'
import { fetchProposals } from '../fns/approvals'
import { fmtTime, statusTone } from '../components/format'

export const Route = createFileRoute('/app/approvals')({
  loader: () => fetchProposals(),
  component: Approvals,
})

const ACTION_LABEL: Record<string, string> = { sentinel_playbook: 'Sentinel playbook', logic_app: 'Logic App', graph_containment: 'Graph containment', other: 'Other' }

function Approvals() {
  const proposals = Route.useLoaderData()
  const matchRoute = useMatchRoute()
  if (matchRoute({ to: '/app/approvals/$id', fuzzy: true })) return <Outlet />
  const pending = proposals.filter((p) => p.status === 'pending')
  return (
    <>
      <h1>Approvals</h1>
      <p className="cw-muted">
        Gated response: agents and analysts propose, an approver decides, and only approved proposals can execute. {pending.length} pending.
      </p>
      {proposals.length === 0 ? (
        <div className="cw-card">
          <h3>No proposals</h3>
          <p className="cw-empty">Response proposals from Responder or analysts appear here for approval. Nothing executes without an approver.</p>
        </div>
      ) : (
        <table className="cw-table">
          <thead>
            <tr>
              <th>Title</th>
              <th>Action</th>
              <th>Blast radius</th>
              <th>Requester</th>
              <th>Status</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {proposals.map((p) => (
              <tr key={p.id}>
                <td>
                  <Link to="/app/approvals/$id" params={{ id: p.id }}>
                    {p.title}
                  </Link>
                </td>
                <td>{ACTION_LABEL[p.actionType]}</td>
                <td>
                  {p.blastRadius.summary}
                  <div className="cw-muted">
                    {p.blastRadius.devices} devices · {p.blastRadius.users} users · {p.blastRadius.incidents} incidents
                  </div>
                </td>
                <td>{p.requesterType === 'agent' ? `agent: ${p.requesterId}` : 'analyst'}</td>
                <td>
                  <span className="cw-badge" data-tone={statusTone(p.status)}>
                    {p.status}
                  </span>
                </td>
                <td>{fmtTime(p.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  )
}
