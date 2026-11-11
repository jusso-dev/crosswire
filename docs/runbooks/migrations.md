# Runbook: production database migrations (#69)

**Pattern: one-shot migration runner before traffic shifts** (recorded in [ADR 0004](../adr/0004-migrations-and-release.md)).

| Where | How migrations run |
| --- | --- |
| Azure | Container Apps Job `<prefix>-web-migrate` (Bicep). The deploy workflow updates its image, starts it, waits for `Succeeded`, then updates web and worker. The job runs as the database owner, then `scripts/app-db-role.mjs` keeps the app role current (see below). |
| Compose (dev and prod) | `migrate` service (`restart: "no"`); `web` waits for `service_completed_successfully`. |
| Single container (dev only) | `MIGRATE_ON_START=true` runs migrations before `node server.mjs`. |
| From a checkout | `pnpm db:migrate` (reads `.env`). |

## Safety properties

- **Multi-replica race:** the runner takes a Postgres advisory lock (`pg_advisory_lock`) so concurrent
  runners serialise; the second finds nothing to apply.
- **No half-migrated schema:** Drizzle applies all pending migrations in one transaction. A failure
  rolls back the whole batch.
- **No traffic on a stale schema:** `/readyz` returns 503 (`checks.migrations: "pending"`) until the
  applied migrations match the image's `drizzle/meta/_journal.json`: every journal entry has a row
  in `drizzle.__drizzle_migrations`, and the row at the image's newest position has the same
  SHA-256 as the image's newest migration file. It does not compare timestamps (#120). New revisions
  only receive traffic once ready. An older image on a newer schema (after a rollback) stays ready.

## Journal `when` values (#120)

Drizzle applies a migration only when its journal `when` is **above** the newest `created_at`
already stored in `drizzle.__drizzle_migrations`. A migration with a lower `when` is skipped, and
the migrator still exits 0. `/readyz` then reports not ready, because the applied count is short.

Two existing entries were written with `when` values ahead of the clock: `0006_slot_claim`
(`1794400000000`, 11-11-2026 12:26 UTC) and `0007_hunt_playbooks` (`1794500000000`, 12-11-2026
16:13 UTC). Production already stores them, so never lower them.

Rules:

- **Until 12-11-2026 16:13 UTC:** after `pnpm db:generate`, open `apps/web/drizzle/meta/_journal.json`
  and set the new entry's `when` by hand to **one more than the previous entry** (for the next
  migration, `1794500000001`). After that time, the generated value is already higher.
- Never edit a `when` to a time in the future, and never lower an existing one.
- `apps/web/test/migrations-journal.test.ts` fails when the `when` values are not strictly
  increasing, or when the newest is more than a day ahead of the clock (the two entries above, and
  an entry pinned to one more than the entry before it, are allowed).

## Verify the applied version

- `GET /readyz` → `"migration": "0007_hunt_playbooks"` (the latest tag this image ships, and only
  `ready` when it is applied). Used by `scripts/smoke.sh <url> <tag>`.
- `pnpm db:status` → `{ expected, expectedCount, appliedCount, upToDate }` (exit 1 when not up to date).
- Logs: `migrations applied {"latest":"…"}` from the migrate job.

## Database roles (#135)

| Role | Used by | Rights |
| --- | --- | --- |
| Owner (`crosswireadmin`, Key Vault `database-url`) | Migration job only | Owns the schema; runs DDL |
| App (`crosswire_app`, Key Vault `database-url-app`) | Web and worker | `SELECT, INSERT, UPDATE, DELETE` on tables in `public`; read `drizzle.__drizzle_migrations`; no DDL |

The app role cannot update `audit_events` (retention still deletes rows past `RETENTION_AUDIT_DAYS`),
and cannot update or delete `response_events` or `agent_run_events`. Those go only when their parent
row is deleted (foreign key cascade). After migrations, the job runs `node scripts/app-db-role.mjs`,
which creates the role or updates its password from `APP_DATABASE_URL`, and grants again. It is
idempotent. Tables created by later migrations get the same grants through default privileges.

## When a migration fails

1. The deploy workflow stops **before** updating web/worker; the previous revision keeps serving.
2. Read the job logs: `az containerapp job execution list -n <prefix>-web-migrate -g <rg>` then
   Log Analytics `ContainerAppConsoleLogs_CL | where ContainerJobName_s endswith "-migrate"`.
3. Fix forward (new commit with a corrected migration) and redeploy. Because the batch was
   transactional, nothing partial needs cleaning up.

If a migration **succeeded** but the new app is broken:

- Additive migrations (new tables/columns, the norm here): roll back the app revision
  ([rollback runbook](rollback.md)); the old app ignores the new columns.
- Destructive migrations (drop/rename): app-only rollback is unsafe. Fix forward, or restore the
  database ([backup and restore](backup-restore.md)). Destructive changes must ship as
  expand → migrate data → contract across two releases.

## Appendix: emergency SQL (last resort)

Only with a fresh backup and a second person: connect with `psql "$DATABASE_URL"`, inspect
`drizzle.__drizzle_migrations`, and apply the specific file from `apps/web/drizzle/`. Record what you
ran on the incident. This is not the normal path.
