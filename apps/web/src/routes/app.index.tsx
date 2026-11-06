import { Link, createFileRoute } from '@tanstack/react-router'
import { fetchDashboard } from '../fns/dashboard'
import { fmtTime } from '../components/format'

export const Route = createFileRoute('/app/')({
  loader: () => fetchDashboard(),
  pendingComponent: () => <p className="cw-muted">Loading dashboard…</p>,
  errorComponent: ({ error }) => <p className="cw-error">Could not load the dashboard: {error instanceof Error ? error.message : String(error)}</p>,
  component: Dashboard,
})

function Panel({ title, count, empty, cta }: { title: string; count: number; empty: string; cta: { to: string; label: string } }) {
  return (
    <section className="cw-card" aria-labelledby={`panel-${title}`}>
      <h3 id={`panel-${title}`}>{title}</h3>
      {count > 0 ? <div className="cw-count">{count}</div> : <p className="cw-empty">{empty}</p>}
      <Link to={cta.to}>{cta.label}</Link>
    </section>
  )
}

function Dashboard() {
  const d = Route.useLoaderData()
  return (
    <>
      <h1>Dashboard</h1>
      <div className="cw-grid">
        <Panel title="Hunts" count={d.hunts} empty="No hunt cases yet. Start one from a watch hit or ask Hunter in chat." cta={{ to: '/app/hunts', label: 'Open hunts' }} />
        <Panel
          title="Watches"
          count={d.watches}
          empty="No watchlist entries yet. Add keywords, CVEs, vendors or tags to get daily matches from pwn.watch and CISA KEV."
          cta={{ to: '/app/watches', label: d.watchHits > 0 ? `${d.watchHits} watch hits` : 'Manage watches' }}
        />
        <Panel
          title="Agents"
          count={d.recentAgentActions}
          empty="No agent activity yet. Pick Lead, Hunter, Intel, Responder or Scribe in chat."
          cta={{ to: '/app/chat', label: d.lastAgentAction ? `Last action ${fmtTime(d.lastAgentAction)}` : 'Open chat' }}
        />
        <Panel title="Approvals" count={d.approvals} empty="No pending approvals. Gated response proposals appear here for an approver." cta={{ to: '/app/approvals', label: 'Approval inbox' }} />
      </div>
    </>
  )
}
