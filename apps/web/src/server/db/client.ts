import { drizzle } from 'drizzle-orm/postgres-js'
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'
import postgres from 'postgres'
import { env } from '../env'
import * as schema from './schema'

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>

let db: Db | undefined
let sql: ReturnType<typeof postgres> | undefined

/** Single application DB client. Tests swap it with `setDb` (PGlite). */
export function getDb(): Db {
  if (!db) {
    sql = postgres(env().DATABASE_URL, { max: 10, idle_timeout: 30, connect_timeout: 10, onnotice: () => {} })
    db = drizzle(sql, { schema }) as unknown as Db
  }
  return db
}

export function setDb(next: Db) {
  db = next
}

/** Cheap readiness probe: `select 1` with a short timeout. */
export async function pingDb(timeoutMs = 2000): Promise<boolean> {
  try {
    const conn = getDb()
    await Promise.race([
      conn.execute('select 1' as never),
      new Promise((_, reject) => setTimeout(() => reject(new Error('db ping timeout')), timeoutMs)),
    ])
    return true
  } catch {
    return false
  }
}

export async function closeDb() {
  await sql?.end({ timeout: 5 })
  sql = undefined
  db = undefined
}

export { schema }
