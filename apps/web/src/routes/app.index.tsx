import { Link, createFileRoute, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { fetchDashboard } from '../fns/dashboard'
import { fmtTime } from '../components/format'
import { dismissSetupFn, fetchSetup, loadDemoFn } from '../fns/setup'

export const Route = createFileRoute('/app/')({
  loader: async () => {
    const [d, setup] = await Promise.all([fetchDashboard(), fetchSetup()])
    return { ...d, setup }
  },
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

function SetupChecklist({ setup }: { setup: Awaited<ReturnType<typeof fetchSetup>> }) {
  const router = useRouter()
  const [msg, setMsg] = useState<string | null>(null)
  if (setup.dismissed || setup.complete) return null
  const done = setup.items.filter((i) => i.done).length
  return (
    <section className="cw-card" style={{ marginBottom: 16 }} aria-labelledby="setup-title">
      <h3 id="setup-title">
        First-run setup ({done}/{setup.items.length})
      </h3>
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {setup.items.map((i) => (
          <li key={i.key} style={{ marginBottom: 6 }}>
            <span aria-hidden>{i.done ? '✅' : '⬜'}</span> <a href={i.href}>{i.label}</a> <span className="cw-muted">{i.detail}</span>
          </li>
        ))}
      </ul>
      <div className="cw-row" style={{ marginTop: 8 }}>
        {setup.canLoadDemo && (
          <button
            className="cw-btn"
            data-variant="ghost"
            onClick={async () => {
              try {
                const r = await loadDemoFn()
                setMsg(r.loaded ? 'Demo data loaded. Look for [DEMO] items in Watches, Hunts and Approvals.' : 'Demo data is already loaded.')
                await router.invalidate()
              } catch (err) {
                setMsg(err instanceof Error ? err.message : String(err))
              }
            }}
          >
            Load demo data
          </button>
        )}
        {setup.isOwner && (
          <button
            className="cw-btn"
            data-variant="ghost"
            onClick={async () => {
              try {
                await dismissSetupFn()
                await router.invalidate()
              } catch (err) {
                setMsg(err instanceof Error ? err.message : String(err))
              }
            }}
          >
            Dismiss
          </button>
        )}
        <a href="https://github.com/jusso-dev/crosswire/blob/main/docs/day-1-operator-playbook.md">Day-1 operator playbook</a>
        <a href="https://github.com/jusso-dev/crosswire/blob/main/docs/go-live-checklist.md">Go-live checklist</a>
        {msg && <span className="cw-muted">{msg}</span>}
      </div>
    </section>
  )
}

function Dashboard() {
  const d = Route.useLoaderData()
  return (
    <>
      <h1>Dashboard</h1>
      {d.setup.warnings.map((w) => (
        <p key={w} className="cw-banner" role="alert">
          {w}
        </p>
      ))}
      <p className="cw-muted">
        Response safety: dry-run {d.setup.dryRun ? 'ON' : 'OFF'} · executors {Object.entries(d.setup.executors).map(([k, v]) => `${k}=${v}`).join(', ')}
      </p>
      <SetupChecklist setup={d.setup} />
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
