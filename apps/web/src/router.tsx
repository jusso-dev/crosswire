// Must stay the first import: it configures zod before any route module builds a schema.
import './zod-config'
import { createRouter } from '@tanstack/react-router'
import { getGlobalStartContext } from '@tanstack/react-start'
import { routeTree } from './routeTree.gen'

/**
 * Per-request CSP nonce from the request middleware in src/start.ts. Server only: on the client
 * getGlobalStartContext() returns undefined and the router reads the nonce back from the
 * `csp-nonce` meta tag it rendered. It throws if called before the global middleware has run.
 */
function cspNonce(): string | undefined {
  try {
    const ctx = getGlobalStartContext() as { cspNonce?: unknown } | undefined
    return typeof ctx?.cspNonce === 'string' ? ctx.cspNonce : undefined
  } catch {
    return undefined
  }
}

export function getRouter() {
  const nonce = cspNonce()
  return createRouter({
    routeTree,
    scrollRestoration: true,
    defaultPreload: 'intent',
    ...(nonce ? { ssr: { nonce } } : {}),
  })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
