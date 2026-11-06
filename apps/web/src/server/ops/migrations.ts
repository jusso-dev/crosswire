import { sql } from 'drizzle-orm'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { getDb } from '../db/client'

/**
 * Migration version signal (#69, #75). Compares the latest applied migration (drizzle journal
 * `when` == `__drizzle_migrations.created_at`) with what this image ships.
 */
export function expectedMigration(dir = process.env.MIGRATIONS_DIR ?? path.resolve(process.cwd(), 'drizzle')) {
  try {
    const journal = JSON.parse(readFileSync(path.join(dir, 'meta/_journal.json'), 'utf8')) as { entries: Array<{ idx: number; tag: string; when: number }> }
    const last = journal.entries.at(-1)
    return last ? { tag: last.tag, when: last.when, count: journal.entries.length } : null
  } catch {
    return null
  }
}

export async function appliedMigration(): Promise<{ createdAt: number; count: number } | null> {
  try {
    const rows = (await getDb().execute(
      sql`select count(*)::int as count, max(created_at)::bigint as created_at from drizzle.__drizzle_migrations`,
    )) as unknown as Array<{ count: number; created_at: string | number | null }> | { rows: Array<{ count: number; created_at: string | number | null }> }
    const r = Array.isArray(rows) ? rows[0] : rows.rows[0]
    if (!r || r.created_at === null) return null
    return { createdAt: Number(r.created_at), count: Number(r.count) }
  } catch {
    return null
  }
}

export async function migrationStatus() {
  const [expected, applied] = [expectedMigration(), await appliedMigration()]
  const upToDate = Boolean(expected && applied && applied.createdAt >= expected.when)
  return { expected: expected?.tag ?? null, appliedCount: applied?.count ?? 0, upToDate }
}
