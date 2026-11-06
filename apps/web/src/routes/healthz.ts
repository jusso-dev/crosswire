import { createFileRoute } from '@tanstack/react-router'

/** Liveness (#63): process is up. No DB, no auth. */
export const Route = createFileRoute('/healthz')({
  server: { handlers: { GET: () => Response.json({ status: 'ok' }, { headers: { 'Cache-Control': 'no-store' } }) } },
})
