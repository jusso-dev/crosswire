import type { ReactNode } from 'react'
import { HeadContent, Outlet, Scripts, createRootRoute, useRouterState } from '@tanstack/react-router'
import { useEffect } from 'react'
import tokensCss from '../styles/tokens.css?url'

export const Route = createRootRoute({
  head: () => ({
    meta: [{ charSet: 'utf-8' }, { name: 'viewport', content: 'width=device-width, initial-scale=1' }, { title: 'Crosswire' }],
    links: [{ rel: 'stylesheet', href: tokensCss }],
  }),
  component: RootComponent,
  notFoundComponent: () => (
    <main className="cw-content">
      <h1>Not found</h1>
      <p className="cw-muted">That page does not exist.</p>
      <a href="/app">Back to the dashboard</a>
    </main>
  ),
})

function RootComponent() {
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
    <html lang="en">
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
