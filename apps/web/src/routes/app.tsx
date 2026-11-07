import { Link, Outlet, createFileRoute, redirect, useRouter, useRouterState } from '@tanstack/react-router'
import { useEffect, useRef } from 'react'
import { fetchSession } from '../fns/session'
import { authClient } from '../lib/auth-client'
import { Mark } from '../components/ui'
import { ThemeToggle } from '../components/ThemeToggle'
import { getDisplayTimeZone } from '../components/format'

/** Authenticated layout (#20, #23). Server-side redirect when signed out; server fns re-check every call. */
export const Route = createFileRoute('/app')({
  beforeLoad: async ({ location }) => {
    const session = await fetchSession()
    if (!session) throw redirect({ to: '/sign-in', search: { returnTo: location.href } })
    return { session }
  },
  component: AppShell,
})

const NAV_GROUPS = [
  { label: 'Overview', items: [{ to: '/app', label: 'Control panel', exact: true }] },
  {
    label: 'Watch',
    items: [
      { to: '/app/watches', label: 'Watches' },
      { to: '/app/digests', label: 'Daily digests' },
    ],
  },
  {
    label: 'Investigate',
    items: [
      { to: '/app/hunts', label: 'Hunts' },
      { to: '/app/chat', label: 'Ask an agent' },
    ],
  },
  { label: 'Act', items: [{ to: '/app/approvals', label: 'Approvals', badge: true }] },
  {
    label: 'Admin',
    items: [
      { to: '/app/agents', label: 'Agents and log' },
      { to: '/app/settings', label: 'Settings' },
    ],
  },
] as const

const ROLE_HINT: Record<string, string> = {
  owner: 'can manage people and settings, and approve actions',
  approver: 'can approve or reject actions',
  analyst: 'can investigate and ask for actions; an approver decides',
}

function AppShell() {
  const { session } = Route.useRouteContext()
  const timeZone = getDisplayTimeZone()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  // The hunt workspace manages its own columns and padding.
  const flush = /^\/app\/hunts\/[^/]+/.test(pathname)
  const chat = pathname.startsWith('/app/chat')
  const router = useRouter()
  const main = useRef<HTMLElement>(null)
  const first = useRef(true)

  // On client-side navigation, move focus to the new page's heading so screen readers announce it
  // and keyboard users start at the content (WCAG 2.4.3). Query-string changes do not move focus.
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    const h1 = main.current?.querySelector<HTMLElement>('h1')
    if (h1) {
      h1.tabIndex = -1
      h1.focus({ preventScroll: false })
    }
  }, [pathname])

  return (
    <div className="cw-shell">
      <a className="cw-skip" href="#main">
        Skip to content
      </a>
      <aside className="cw-sidebar" aria-label="Sidebar">
        <Link to="/app" className="cw-brand">
          <Mark />
          <span>
            Crosswire
            <small>Analyst workspace</small>
          </span>
        </Link>
        <nav className="cw-nav" aria-label="Main">
          {NAV_GROUPS.map((g) => (
            <div className="cw-navgroup" key={g.label} role="group" aria-labelledby={`nav-${g.label}`}>
              <div className="cw-navgroup-label" id={`nav-${g.label}`}>
                {g.label}
              </div>
              {g.items.map((n) => (
                <Link key={n.to} to={n.to} activeOptions={{ exact: 'exact' in n ? n.exact : false }}>
                  <span>{n.label}</span>
                  {'badge' in n && session.pendingApprovals > 0 && (
                    <span className="cw-badge" data-tone="warn">
                      {session.pendingApprovals}
                      <span className="cw-sr-only"> waiting</span>
                    </span>
                  )}
                </Link>
              ))}
            </div>
          ))}
        </nav>
        <div className="cw-rail-foot">
          <span>Times shown in {timeZone.replace('_', ' ')}</span>
          <a href="https://github.com/jusso-dev/crosswire/blob/main/docs/day-1-operator-playbook.md" target="_blank" rel="noreferrer noopener">
            First-day guide<span className="cw-sr-only"> (opens in a new tab)</span>
          </a>
        </div>
      </aside>
      <div className="cw-main">
        <header className="cw-header">
          <span className="cw-header-org">
            <strong>{session.org.name}</strong>
            <span className="cw-badge" data-tone={session.org.role === 'analyst' ? undefined : 'info'}>
              {session.org.role}
            </span>
            <span className="cw-sr-only">: {ROLE_HINT[session.org.role] ?? ''}</span>
          </span>
          <span className="cw-header-meta">
            <ThemeToggle />
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
        <main id="main" ref={main} className="cw-content" data-flush={flush ? '' : undefined} data-chat={chat ? '' : undefined}>
          <Outlet />
        </main>
      </div>
    </div>
  )
}
