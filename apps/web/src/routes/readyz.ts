import { createFileRoute } from '@tanstack/react-router'
import { pingDb } from '../server/db/client'
import { migrationStatus } from '../server/ops/migrations'

/**
 * Readiness (#63, #69): 200 only when Postgres answers AND the schema is at the migration this
 * image ships, so a half-migrated or un-migrated database never receives traffic. Exposes only the
 * migration tag (no secrets) for post-deploy smoke tests (#75). No auth.
 */
export const Route = createFileRoute('/readyz')({
  server: {
    handlers: {
      GET: async () => {
        const db = await pingDb()
        const migrations = db ? await migrationStatus() : { expected: null, appliedCount: 0, upToDate: false }
        const ready = db && migrations.upToDate
        return Response.json(
          {
            status: ready ? 'ready' : 'not_ready',
            checks: { database: db ? 'ok' : 'unreachable', migrations: migrations.upToDate ? 'ok' : 'pending' },
            migration: migrations.expected,
          },
          { status: ready ? 200 : 503, headers: { 'Cache-Control': 'no-store' } },
        )
      },
    },
  },
})
