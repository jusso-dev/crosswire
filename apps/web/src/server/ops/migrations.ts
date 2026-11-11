import { sql } from 'drizzle-orm'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { getDb } from '../db/client'

export interface JournalEntry {
  idx: number
  tag: string
  when: number
}

/**
 * Migration version signal (#69, #75, #120). Readiness compares what is applied
 * (`drizzle.__drizzle_migrations`) with what this image ships (`drizzle/meta/_journal.json`) by
 * COUNT and by the SHA-256 of the newest migration file, the same hash Drizzle stores. It does not
 * compare `when` timestamps: Drizzle skips a migration whose `when` is not above the newest stored
 * one, so a timestamp check would report ready on a schema that is missing a change.
 */
export function migrationsDir() {
  return process.env.MIGRATIONS_DIR ?? path.resolve(process.cwd(), 'drizzle')
}

export function readJournal(dir = migrationsDir()): JournalEntry[] | null {
  try {
    return (JSON.parse(readFileSync(path.join(dir, 'meta/_journal.json'), 'utf8')) as { entries: JournalEntry[] }).entries
  } catch {
    return null
  }
}

/** SHA-256 of a migration file, computed exactly as drizzle-orm's readMigrationFiles does. */
export function migrationHash(dir: string, tag: string) {
  return createHash('sha256').update(readFileSync(path.join(dir, `${tag}.sql`)).toString()).digest('hex')
}

export function expectedMigration(dir = migrationsDir()) {
  const entries = readJournal(dir)
  const last = entries?.at(-1)
  if (!entries || !last) return null
  let hash: string | null
  try {
    hash = migrationHash(dir, last.tag)
  } catch {
    hash = null
  }
  return { tag: last.tag, when: last.when, count: entries.length, hash }
}

type Row = { count: number | string; hash: string | null }

/**
 * Applied migration count, and the hash of the applied row at `position` (1-based, insert order).
 * Ordered by id, not created_at: created_at is the journal `when`, which is the value that can be
 * out of order.
 */
export async function appliedMigration(position: number): Promise<{ count: number; hashAtPosition: string | null } | null> {
  try {
    const rows = (await getDb().execute(
      sql`select (select count(*)::int from drizzle.__drizzle_migrations) as count,
                 (select hash from drizzle.__drizzle_migrations order by id asc offset ${Math.max(position - 1, 0)} limit 1) as hash`,
    )) as unknown as Row[] | { rows: Row[] }
    const r = Array.isArray(rows) ? rows[0] : rows.rows[0]
    if (!r) return null
    return { count: Number(r.count), hashAtPosition: r.hash ?? null }
  } catch {
    return null
  }
}

/**
 * Up to date when every journal entry this image ships has a row, and the row at this image's
 * newest position is this image's newest file. A skipped migration leaves the count short. A
 * replaced file changes the hash. More rows than the journal is fine: that is an older image
 * running on a newer, additive schema after a rollback.
 */
export function isUpToDate(
  expected: { count: number; hash: string | null } | null,
  applied: { count: number; hashAtPosition: string | null } | null,
) {
  if (!expected || !applied) return false
  if (applied.count < expected.count) return false
  return expected.hash === null || applied.hashAtPosition === expected.hash
}

export async function migrationStatus() {
  const expected = expectedMigration()
  const applied = expected ? await appliedMigration(expected.count) : null
  return {
    expected: expected?.tag ?? null,
    expectedCount: expected?.count ?? 0,
    appliedCount: applied?.count ?? 0,
    upToDate: isUpToDate(expected, applied),
  }
}
