import { describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { getDb } from '../src/server/db/client'
import { expectedMigration, isUpToDate, migrationStatus, readJournal, type JournalEntry } from '../src/server/ops/migrations'

/**
 * Migration journal order (#120). Drizzle applies a migration only when its `when` is above the
 * newest `created_at` already stored, so an entry that is out of order is skipped with exit 0.
 */
const DAY = 24 * 3600_000
/** Written ahead of the clock before this check existed. Production stores them; never lower them. */
const KNOWN_FUTURE = new Set(['0006_slot_claim', '0007_hunt_playbooks'])

function journalProblems(entries: JournalEntry[], now = Date.now()): string[] {
  const problems: string[] = []
  entries.forEach((e, i) => {
    if (e.idx !== i) problems.push(`${e.tag}: idx ${e.idx} at position ${i}`)
    const prev = entries[i - 1]
    if (prev && !(e.when > prev.when)) problems.push(`${e.tag}: when ${e.when} is not above ${prev.tag} (${prev.when})`)
  })
  const last = entries.at(-1)
  if (last && last.when > now + DAY && !KNOWN_FUTURE.has(last.tag)) {
    problems.push(`${last.tag}: when ${last.when} is more than a day in the future. See docs/runbooks/migrations.md.`)
  }
  return problems
}

const entry = (idx: number, tag: string, when: number): JournalEntry => ({ idx, tag, when })

describe('migration journal (#120)', () => {
  it('the shipped journal is strictly increasing and not in the future', () => {
    const entries = readJournal(path.resolve(__dirname, '../drizzle'))
    expect(entries?.length).toBeGreaterThan(0)
    expect(journalProblems(entries!)).toEqual([])
  })

  it('flags an entry that is not above the one before it', () => {
    const now = Date.UTC(2026, 10, 20)
    const bad = [entry(0, '0000_a', 100), entry(1, '0001_b', 300), entry(2, '0002_c', 200)]
    expect(journalProblems(bad, now)).toEqual([expect.stringMatching(/^0002_c: when 200 is not above 0001_b/)])
    expect(journalProblems([entry(0, '0000_a', 100), entry(1, '0001_b', 100)], now)).toHaveLength(1)
  })

  it('flags a newest entry more than a day ahead of the clock, except the two known ones', () => {
    const now = Date.UTC(2026, 10, 1)
    const future = [entry(0, '0000_a', now - DAY), entry(1, '0008_new', now + 2 * DAY)]
    expect(journalProblems(future, now)).toEqual([expect.stringMatching(/^0008_new: .* future/)])
    expect(journalProblems([entry(0, '0000_a', now - DAY), entry(1, '0008_new', now + DAY / 2)], now)).toEqual([])
    expect(journalProblems([entry(0, '0000_a', now - DAY), entry(1, '0007_hunt_playbooks', now + 30 * DAY)], now)).toEqual([])
  })
})

describe('readiness compares count and hash, not timestamps (#120)', () => {
  const shipped = expectedMigration(path.resolve(__dirname, '../drizzle'))!

  it('is ready when every shipped migration is applied', async () => {
    const s = await migrationStatus()
    expect(s.upToDate).toBe(true)
    expect(s.appliedCount).toBe(shipped.count)
    expect(s.expectedCount).toBe(shipped.count)
  })

  it('is not ready when a journal entry has no applied row, whatever its timestamp', () => {
    expect(isUpToDate({ count: 9, hash: 'h9' }, { count: 8, hashAtPosition: null })).toBe(false)
  })

  it('is not ready when the applied row at the newest position is a different file', () => {
    expect(isUpToDate({ count: 8, hash: 'new' }, { count: 8, hashAtPosition: 'old' })).toBe(false)
  })

  it('stays ready for an older image on a newer schema (rollback)', () => {
    expect(isUpToDate({ count: 7, hash: 'h7' }, { count: 8, hashAtPosition: 'h7' })).toBe(true)
  })

  it('reports not ready for a journal with an entry the database has not applied', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cw-journal-'))
    mkdirSync(path.join(dir, 'meta'))
    const entries = [...readJournal(path.resolve(__dirname, '../drizzle'))!]
    // A skipped migration: its `when` is LOWER than the newest stored one, as in the #120 failure.
    entries.push({ idx: entries.length, tag: '9999_skipped', when: 1_000 })
    writeFileSync(path.join(dir, 'meta/_journal.json'), JSON.stringify({ entries }))
    writeFileSync(path.join(dir, '9999_skipped.sql'), 'select 1;')
    const prev = process.env.MIGRATIONS_DIR
    process.env.MIGRATIONS_DIR = dir
    try {
      const s = await migrationStatus()
      expect(s.expected).toBe('9999_skipped')
      expect(s.upToDate).toBe(false)
    } finally {
      if (prev === undefined) delete process.env.MIGRATIONS_DIR
      else process.env.MIGRATIONS_DIR = prev
    }
  })

  it('the hash matches what Drizzle stored for the newest migration', async () => {
    const rows = (await getDb().execute(sql`select hash from drizzle.__drizzle_migrations order by id desc limit 1`)) as unknown as
      | Array<{ hash: string }>
      | { rows: Array<{ hash: string }> }
    const r = Array.isArray(rows) ? rows[0] : rows.rows[0]
    expect(r?.hash).toBe(shipped.hash)
  })
})
