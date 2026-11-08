# Runbook: data retention

Crosswire deletes or trims old data once a day. Four settings control it; each is a number of days,
and `0` keeps that data forever.

| Setting | Default | What is removed |
| --- | --- | --- |
| `RETENTION_CHAT_DAYS` | `365` | Chat threads not updated for this long (with their messages and feedback), then older messages in threads that are still active (with their feedback). |
| `RETENTION_DECISIONS_DAYS` | `365` | Decision log rows (`agent_decisions`, **Agents → Decision log**) older than this. |
| `RETENTION_SAMPLES_DAYS` | `180` | Stored KQL result sample rows older than this. Rows are not deleted, only the sample is stripped (see below). |
| `RETENTION_AUDIT_DAYS` | `730` | Audit log rows (`audit_events`, **Settings → Audit log**) older than this. |

Ages are measured from when the row was created, except chat threads (last update) and query
samples (when the query ran).

## What "samples are stripped" means

When a KQL search runs, Crosswire stores a summary: row count, columns, duration and the first 20
rows (the sample). The sample is kept on the query (`kql_proposals.result_summary`) and on the
hunt evidence (`kql_result` and `scheduled_result` rows). After `RETENTION_SAMPLES_DAYS` the purge
replaces the sample with an empty list and marks it expired.

- Kept: the query, who approved it, when it ran, row count, columns and the rest of the evidence trail.
- The hunt case shows "Sample removed after N days (retention). The row count and columns are kept."
  Hunt reports say the same in place of the sample table.
- The decision log never stores sample rows. When Hunter reads a hunt, its log entry keeps only
  the number of rows; run results in the log hold the row count and mode. Free text is different:
  chat messages and logged agent answers keep whatever the model wrote, which can quote rows. They
  follow `RETENTION_CHAT_DAYS` and `RETENTION_DECISIONS_DAYS`, not the sample period.
- Full result sets are never stored; they stay in Defender and Sentinel.

## When it runs

- **Worker:** once per local day, at or after 00:30 in `APP_TIMEZONE` (default
  `Australia/Sydney`). It runs on its own, outside the worker's minute tick, so a long first purge
  never delays proposal expiry or scheduled hunts. A purge still running is not started again.
  A worker restart after 00:30 runs it again that day; that is harmless.
- **By hand:** `pnpm --filter web retention` from a checkout (reads `.env`). Compose:
  `docker compose -f docker-compose.prod.yml --env-file .env.prod run --rm migrate node_modules/.bin/tsx src/server/cli/retention.ts`.
  Azure: use the one-off job pattern in [key rotation, step 2](key-rotation.md#step-2-re-encrypt-stored-secrets)
  with `src/server/cli/retention.ts` as the command, then put the migration command back.

It works in batches of 5,000 rows (chat threads 500), each a short statement, so it holds no long
locks. It is idempotent: a second run, or a second worker replica on the same day, finds nothing
left to remove. Retention applies to every org in the deployment; there is no per-org setting.

## Check that it ran

Each run writes a `retention_purge` system audit event with the counts and the settings used, and
logs `retention purge complete`. The event has no org, so query it directly:

```sql
select created_at, data from audit_events where action = 'retention_purge' order by created_at desc limit 7;
```

Counts: `chatThreads`, `chatMessages`, `agentDecisions`, `kqlSamples`, `evidenceSamples`,
`auditEvents`. Worker failures log `job retention failed` at error level, which raises the
worker job alert in Azure ([Azure deploy](azure-deploy.md#5-probes-and-logs)).

## Changing a setting

1. Agree the periods with whoever owns your privacy and records obligations. IP addresses and user
   agents in the audit log are personal data in some jurisdictions.
2. Set the values as plain env vars on the web **and** worker apps (Azure:
   `az containerapp update --set-env-vars`), or in `.env` for Compose. Only the worker purges, but
   keep them the same everywhere. Bicep does not set these, and a Bicep redeploy drops values added
   with `az` ([configuration](../configuration.md#azure-mapping-phase-7)); set them again after one.
3. Restart the worker. The next purge (or a manual run) applies the new periods.

**Lowering a period deletes data at the next run, and it cannot be undone** except by restoring a
backup ([backup and restore](backup-restore.md)). Before a large cut, run a count first, for
example:

```sql
select count(*) from audit_events where created_at < now() - interval '365 days';
```

Backups are separate: PITR backups and `pg_dump` files keep deleted rows until they expire.

## Related

- [Configuration](../configuration.md#security-sessions-and-retention)
- [Hunting](../hunting.md) (stored samples)
- [Auth audit log](../auth.md#auth-audit-log-issue-22)
