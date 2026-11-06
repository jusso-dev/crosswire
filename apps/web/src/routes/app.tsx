import { Link, Outlet, createFileRoute, redirect, useRouter } from '@tanstack/react-router'
import { fetchSession } from '../fns/session'
import { authClient } from '../lib/auth-client'

/** Authenticated layout (#20, #23). Server-side redirect when signed out; server fns re-check every call. */
export const Route = createFileRoute('/app')({
  beforeLoad: async ({ location }) => {
    const session = await fetchSession()
    if (!session) throw redirect({ to: '/sign-in', search: { returnTo: location.href } })
    return { session }
  },
  component: AppShell,
})

const NAV = [
  { to: '/app', label: 'Dashboard', exact: true },
  { to: '/app/chat', label: 'Chat' },
  { to: '/app/approvals', label: 'Approvals', badge: true },
  { to: '/app/hunts', label: 'Hunts' },
  { to: '/app/watches', label: 'Watches' },
  { to: '/app/digests', label: 'Digests' },
  { to: '/app/agents', label: 'Agents' },
  { to: '/app/settings', label: 'Settings' },
] as const

function AppShell() {
  const { session } = Route.useRouteContext()
  const router = useRouter()
  return (
    <div className="cw-shell">
      <aside className="cw-sidebar">
        <div className="cw-brand">Crosswire</div>
        <nav className="cw-nav" aria-label="Main">
          {NAV.map((n) => (
            <Link key={n.to} to={n.to} activeOptions={{ exact: 'exact' in n ? n.exact : false }}>
              <span>{n.label}</span>
              {'badge' in n && session.pendingApprovals > 0 && (
                <span className="cw-badge" data-tone="warn" aria-label={`${session.pendingApprovals} pending approvals`}>
                  {session.pendingApprovals}
                </span>
              )}
            </Link>
          ))}
        </nav>
      </aside>
      <div className="cw-main">
        <header className="cw-header">
          <span>
            <strong>{session.org.name}</strong> <span className="cw-badge">{session.org.role}</span>
          </span>
          <span className="cw-row" style={{ alignItems: 'center' }}>
            <span>{session.user.email}</span>
            <button
              className="cw-btn"
              data-variant="ghost"
              type="button"
              onClick={async () => {
                await authClient.signOut()
                await router.navigate({ to: '/sign-in' })
              }}
            >
              Sign out
            </button>
          </span>
        </header>
        <main className="cw-content">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
