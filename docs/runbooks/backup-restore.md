# Runbook: Postgres backup and restore (#72)

Crosswire state (orgs, users, sessions, hunts, approvals, agent memory, audit) lives in Azure
Database for PostgreSQL Flexible Server. **Key Vault secrets are separate**: restoring the database
does not restore or rotate secrets, and `APP_ENCRYPTION_KEY` must match the one used when connector
secrets were encrypted. If the key was rotated after the restore point, set the old key as
`APP_ENCRYPTION_KEY_PREVIOUS` and re-run the rotation ([key rotation](key-rotation.md)).

Restored data includes rows the daily [retention purge](data-retention.md) has since removed. The
next purge removes them again.

## Backups

- Automated backups with point-in-time restore (PITR), retention **7 days** in the Bicep
  (`backup.backupRetentionDays`). Production: raise to 14–35 days and consider
  `geoRedundantBackup: 'Enabled'` (set at server creation).
- Compose deployments: schedule `pg_dump` from the host, e.g.
  `docker compose -f docker-compose.prod.yml --env-file .env.prod exec -T postgres pg_dump -U crosswire -Fc crosswire > crosswire-$(date +%F).dump`,
  and copy dumps off the host.

## v1 lab targets

| | Target |
| --- | --- |
| RPO | ≤ 5 minutes with PITR (Azure); ≤ 24 h with daily `pg_dump` (Compose) |
| RTO | Best effort, a few hours (lab). No enterprise SLA. |

## Restore drill (do this once before go-live, then quarterly)

1. Pick a restore point (e.g. 30 minutes ago):
   `az postgres flexible-server restore -g <rg> -n <prefix>-pg-restore --source-server <prefix>-pg-<suffix> --restore-time "<UTC ISO time>"`
2. Wait for the new server; allow access from the Container Apps environment (same networking as the original).
3. Build the new connection string and update the Key Vault secret `database-url` to point at the restored server.
4. Restart the web and worker revisions so they pick up the secret.
5. Verify: `/readyz` ready with the expected `migration`; sign in; open a known hunt case and approval.
6. Record the drill in the [drill log](#drill-log) below and the RPO/RTO in the go-live checklist.
7. Decommission or keep: either keep the restored server and delete the old one, or point back and delete the restored one.

Compose restore: `pg_restore -U crosswire -d crosswire --clean --if-exists < crosswire-YYYY-MM-DD.dump`
inside the postgres container, then restart `web` and `worker`.

## Drill log

One row per drill, newest first. Dates `DD-MM-YYYY`. Time to restore is from starting step 1 to
step 5 passing. RPO is the data age at the restore point; RTO is the time to restore achieved.
Result is pass or fail, with a note for anything that went wrong.

_No drills recorded yet. The lead engineer fills this in after the first drill._

| Date | Operator | Restore point (UTC) | Time to restore | RPO | RTO | Result |
| --- | --- | --- | --- | --- | --- | --- |
| | | | | | | |

Related: [migrations](migrations.md) (destructive migration recovery), [rollback](rollback.md).
