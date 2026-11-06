import { createFileRoute } from '@tanstack/react-router'
import { pingDb } from '../server/db/client'

/** Readiness (#63): 200 only when Postgres answers. No auth. */
export const Route = createFileRoute('/readyz')({
  server: {
    handlers: {
      GET: async () => {
        const db = await pingDb()
        return Response.json({ status: db ? 'ready' : 'not_ready', checks: { database: db ? 'ok' : 'unreachable' } }, { status: db ? 200 : 503, headers: { 'Cache-Control': 'no-store' } })
      },
    },
  },
})
