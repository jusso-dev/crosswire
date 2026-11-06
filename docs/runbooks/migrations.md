# Runbook: production database migrations (#69)

**Pattern: one-shot migration runner before traffic shifts** (recorded in [ADR 0004](../adr/0004-migrations-and-release.md)).

| Where | How migrations run |
| --- | --- |
| Azure | Container Apps Job `<prefix>-web-migrate` (Bicep). The deploy workflow updates its image, starts it, waits for `Succeeded`, then updates web and worker. |
| Compose (dev and prod) | `migrate` service (`restart: "no"`); `web` waits for `service_completed_successfully`. |
| Single container (dev only) | `MIGRATE_ON_START=true` runs migrations before `node server.mjs`. |
| From a checkout | `pnpm db:migrate` (reads `.env`). |

## Safety properties

- **Multi-replica race:** the runner takes a Postgres advisory lock (`pg_advisory_lock`) so concurrent
  runners serialise; the second finds nothing to apply.
- **No half-migrated schema:** Drizzle applies all pending migrations in one transaction. A failure
  rolls back the whole batch.
- **No traffic on a stale schema:** `/readyz` returns 503 (`checks.migrations: "pending"`) until the
  applied migrations match the image's `drizzle/meta/_journal.json`. New revisions only receive
  traffic once ready.

## Verify the applied version

- `GET /readyz` → `"migration": "0002_phase8_bootstrap"` (the latest tag this image ships, and only
  `ready` when it is applied). Used by `scripts/smoke.sh <url> <tag>`.
- `pnpm db:status` → `{ expected, appliedCount, upToDate }` (exit 1 when not up to date).
- Logs: `migrations applied {"latest":"…"}` from the migrate job.

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
