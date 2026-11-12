import type { ReactNode } from 'react'
import { HeadContent, Link, Outlet, Scripts, createRootRoute, useRouterState } from '@tanstack/react-router'
import { useEffect } from 'react'
import tokensCss from '../styles/tokens.css?url'
import { fetchAppConfig } from '../fns/app-config'
import { setDisplayTimeZone } from '../components/format'

/** Runs before paint: applies the saved theme (or the OS preference) so pages never flash. */
const THEME_BOOT = `(function(){try{var t=localStorage.getItem('cw-theme');if(t!=='light'&&t!=='dark'){t=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}document.documentElement.dataset.theme=t}catch(e){}})()`

const FAVICON = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path d="M3 9c8 0 9 14 26 14" fill="none" stroke="#1d2533" stroke-width="3" stroke-linecap="round"/><path d="M3 23c8 0 9-14 26-14" fill="none" stroke="#2f6bf0" stroke-width="3" stroke-linecap="round"/><circle cx="16" cy="16" r="4" fill="#fff" stroke="#2f6bf0" stroke-width="3"/></svg>')}`

export const Route = createRootRoute({
  // Display time zone: the person's choice (cw-tz cookie, #161) or APP_TIMEZONE. Loader data is
  // dehydrated from the server, so the client does not refetch it during hydration. Changing the
  // choice sets the cookie and invalidates the router, which reruns this loader.
  loader: async () => {
    const cfg = await fetchAppConfig()
    setDisplayTimeZone(cfg.timeZone)
    return cfg
  },
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'Crosswire' },
      { name: 'color-scheme', content: 'light dark' },
    ],
    scripts: [{ children: THEME_BOOT }],
    links: [
      { rel: 'stylesheet', href: tokensCss },
      { rel: 'icon', href: FAVICON },
    ],
  }),
  component: RootComponent,
  notFoundComponent: () => (
    <main className="cw-center">
      <h1>We couldn't find that page</h1>
      <p className="cw-muted">The link may be old, or the item may have been removed.</p>
      <Link to="/app" className="cw-btn">
        Back to the control panel
      </Link>
    </main>
  ),
})

function RootComponent() {
  const { timeZone } = Route.useLoaderData()
  setDisplayTimeZone(timeZone)
  return (
    <RootDocument>
      <Outlet />
    </RootDocument>
  )
}

function RootDocument({ children }: { children: ReactNode }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  // Safety net for overlays that leave body pointer-events disabled across navigation.
  useEffect(() => {
    if (document.body.style.pointerEvents === 'none') document.body.style.pointerEvents = ''
  }, [pathname])
  return (
    <html lang="en-AU" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  )
}
