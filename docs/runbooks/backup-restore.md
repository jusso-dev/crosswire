# Runbook: Postgres backup and restore (#72)

Crosswire state (orgs, users, sessions, hunts, approvals, agent memory, audit) lives in Azure
Database for PostgreSQL Flexible Server. **Key Vault secrets are separate**: restoring the database
does not restore or rotate secrets, and `APP_ENCRYPTION_KEY` must match the one used when connector
secrets were encrypted. If the key was rotated after the restore point, set the old key as
`APP_ENCRYPTION_KEY_PREVIOUS` and re-run the rotation ([key rotation](key-rotation.md)).

Restored data includes rows the daily [retention purge](data-retention.md) has since removed. The
next purge removes them again.

## Backups

- Automated backups with point-in-time restore (PITR). Retention is the Bicep parameter
  `postgresBackupRetentionDays` (7 to 35; the template default is 7, `main.bicepparam` sets 14).
  Geo-redundant backup is `postgresGeoRedundantBackup` and can only be set when the server is created.
- Compose deployments: schedule `pg_dump` from the host, e.g.
  `docker compose -f docker-compose.prod.yml --env-file .env.prod exec -T postgres pg_dump -U crosswire -Fc crosswire > crosswire-$(date +%F).dump`,
  and copy dumps off the host.

## Data-tier resilience (#154)

The database holds the audit trail and approval history. These are the chosen levels. Each is a
Bicep parameter, so a production deployment can raise them without editing the template.

| Setting | Lab (`crosswire-lab`) | Production (`main.bicepparam`) | Why |
| --- | --- | --- | --- |
| Backup retention | 7 days | 14 days | Two weeks to notice and recover from a bad change. Raise to 35 for stricter record keeping. |
| Geo-redundant backup | Disabled | Disabled (decide at creation) | Doubles backup storage cost. Enable on a new server when a region-wide outage must be survivable. |
| High availability | Disabled | Disabled | Not available on Burstable B1ms. Needs General Purpose (`postgresSkuTier`), which costs several times more. |
| SKU | `Standard_B1ms` (Burstable) | `Standard_B1ms` | Enough for one organisation's SOC team. Change `postgresSkuName` and `postgresSkuTier` together. |
| `CanNotDelete` locks on Postgres and Key Vault | Off | On (`enableDeleteLocks`) | Stops an accidental delete of the server or vault. Creating locks needs Owner or User Access Administrator. |
| Key Vault purge protection | On | On | Deleted secrets can be recovered for 30 days. |
| Key Vault network access | Public, RBAC only | Public, RBAC only | A private endpoint needs private networking and a jump host for operators. Follow-up, not built. |

## v1 lab targets

| | Target |
| --- | --- |
| RPO | ≤ 5 minutes with PITR (Azure); ≤ 24 h with daily `pg_dump` (Compose) |
| RTO | Best effort, a few hours (lab). No enterprise SLA. |

## Restore drill (do this once before go-live, then quarterly)

1. Pick a restore point (e.g. 30 minutes ago):
   `az postgres flexible-server restore -g <rg> -n <prefix>-pg-restore --source-server <prefix>-pg-<suffix> --restore-time "<UTC ISO time>"`
2. Wait for the new server; allow access from the Container Apps environment (same networking as the original).
3. Build the new connection strings (owner and `crosswire_app`, both with `sslmode=verify-full`)
   and update the Key Vault secrets `database-url` and `database-url-app` to point at the restored
   server. The app role and its grants are restored with the database.
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
