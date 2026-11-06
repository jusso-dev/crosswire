import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { env } from '../env'
import { logger } from '../lib/logger'
import { expectedMigration } from '../ops/migrations'

export const MIGRATIONS_DIR =
  process.env.MIGRATIONS_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../drizzle')

/** Arbitrary constant: the Postgres advisory lock that serialises concurrent migration runners (#69). */
const MIGRATION_LOCK_ID = 7_416_204_911

/**
 * Apply pending migrations once, safely:
 * - A session-level advisory lock serialises concurrent runners (multi-replica race).
 * - Drizzle applies all pending migrations in ONE transaction: a failure rolls back the whole batch,
 *   so the schema is never half-migrated. /readyz stays 503 until the schema matches this image.
 */
export async function runMigrations() {
  const sql = postgres(env().DATABASE_URL, { max: 1, onnotice: () => {} })
  try {
    await sql`select pg_advisory_lock(${MIGRATION_LOCK_ID})`
    try {
      await migrate(drizzle(sql), { migrationsFolder: MIGRATIONS_DIR })
    } finally {
      await sql`select pg_advisory_unlock(${MIGRATION_LOCK_ID})`
    }
  } finally {
    await sql.end({ timeout: 5 })
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations()
    .then(() => logger.info('migrations applied', { dir: MIGRATIONS_DIR, latest: expectedMigration(MIGRATIONS_DIR)?.tag ?? null }))
    .catch((err: unknown) => {
      logger.error('migration failed', { error: err instanceof Error ? err.message : String(err) })
      process.exitCode = 1
    })
}
