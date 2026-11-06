import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { closeDb, getDb } from '../db/client'
import { logger } from '../lib/logger'

export const MIGRATIONS_DIR =
  process.env.MIGRATIONS_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../drizzle')

export async function runMigrations() {
  // postgres-js migrator needs the concrete driver type; the shared Db type hides it.
  await migrate(getDb() as never, { migrationsFolder: MIGRATIONS_DIR })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations()
    .then(() => logger.info('migrations applied', { dir: MIGRATIONS_DIR }))
    .catch((err: unknown) => {
      logger.error('migration failed', { error: err instanceof Error ? err.message : String(err) })
      process.exitCode = 1
    })
    .finally(() => closeDb())
}
