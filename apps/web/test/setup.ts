import { afterAll, beforeAll } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import path from 'node:path'
import { setDb, type Db } from '../src/server/db/client'
import * as schema from '../src/server/db/schema'

/**
 * Every test file gets a fresh in-process Postgres (PGlite) with the real migrations applied, so
 * tests exercise the same SQL as production without Docker. No mocked DB.
 */
let pg: PGlite

beforeAll(async () => {
  pg = new PGlite()
  const db = drizzle(pg, { schema })
  await migrate(db, { migrationsFolder: path.resolve(__dirname, '../drizzle') })
  setDb(db as unknown as Db)
})

afterAll(async () => {
  await pg?.close()
})
