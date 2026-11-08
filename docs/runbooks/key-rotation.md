# Runbook: rotate APP_ENCRYPTION_KEY

`APP_ENCRYPTION_KEY` (64 hex chars) encrypts the secrets Crosswire stores in Postgres with
AES-256-GCM:

- hunting connector client secrets (`org_connectors.client_secret_enc`)
- response connector client secrets (`org_response_connectors.client_secret_enc`)
- Teams and Slack webhook URLs (`org_notification_channels.url_enc`)

Changing the key on its own makes all of these unreadable. Rotate it with the three steps below
instead. Nobody needs to re-save a connector or channel.

How it works (`apps/web/src/server/lib/crypto.ts`): new values are always encrypted with
`APP_ENCRYPTION_KEY`. Decryption tries `APP_ENCRYPTION_KEY` first, then each key in
`APP_ENCRYPTION_KEY_PREVIOUS` (comma-separated) in order. `pnpm rotate-secrets` then re-encrypts
every stored value with the current key, after which the old key can go.

Other secrets are not affected: `BETTER_AUTH_SECRET` (sessions, Entra tokens) and
`ENTRA_CLIENT_SECRET` rotate as described in [Azure deploy](azure-deploy.md#3-secrets-key-vault).

## Before you start

- Pick a quiet window. Do not run a deploy (GitHub workflow or Bicep) until step 3 is finished: a
  Bicep redeploy rewrites the apps' secrets and env vars and drops the ones added in step 1, and
  the deploy workflow uses the same job as step 2.
- Have rights to set Key Vault secrets and update the container apps and job in the resource group.
- Never print key values. The commands below pass them through command substitution and use
  `-o none` so `az` does not echo them.

The run in step 2 is **all-or-nothing**. It runs in one transaction with the rows locked; if any
value cannot be decrypted with the current or a previous key, the whole run rolls back and nothing
changes. It is idempotent: values already under the current key are left alone, so it is safe to
run again. It reports counts only (no plaintext, no ciphertext) and writes a `secrets_rotated`
audit event with the same counts.

## Azure Container Apps

Names below assume the default prefix `crosswire` (`crosswire-web`, `crosswire-worker`,
`crosswire-web-migrate`, identity `crosswire-id`). Set your own:

```sh
RG=crosswire-prod
KV=<keyVaultName>
KV_URI=$(az keyvault show -n $KV --query properties.vaultUri -o tsv)
ID=$(az identity show -g $RG -n crosswire-id --query id -o tsv)
```

### Step 1: new key in, old key kept for decryption

Order matters: make the old key available as the previous key **before** the current key changes,
or the apps cannot read stored secrets in between.

1. Copy the current key into a new Key Vault secret, `app-encryption-key-previous`:

   ```sh
   az keyvault secret set --vault-name $KV -n app-encryption-key-previous -o none \
     --value "$(az keyvault secret show --vault-name $KV -n app-encryption-key --query value -o tsv)"
   ```

2. Reference it from the web app, the worker and the job, and expose it as
   `APP_ENCRYPTION_KEY_PREVIOUS`:

   ```sh
   REF="app-encryption-key-previous=keyvaultref:${KV_URI}secrets/app-encryption-key-previous,identityref:$ID"
   for APP in crosswire-web crosswire-worker; do
     az containerapp secret set -g $RG -n $APP --secrets "$REF" -o none
     az containerapp update -g $RG -n $APP --set-env-vars APP_ENCRYPTION_KEY_PREVIOUS=secretref:app-encryption-key-previous -o none
   done
   az containerapp job secret set -g $RG -n crosswire-web-migrate --secrets "$REF" -o none
   az containerapp job update -g $RG -n crosswire-web-migrate --container-name migrate \
     --set-env-vars APP_ENCRYPTION_KEY_PREVIOUS=secretref:app-encryption-key-previous -o none
   ```

   A plain env var holding the old key also works, but it is then visible in the app
   configuration. Prefer the Key Vault secret.

3. Set the new key. Key Vault keeps the old value as an earlier version of the secret:

   ```sh
   az keyvault secret set --vault-name $KV -n app-encryption-key --value "$(openssl rand -hex 32)" -o none
   ```

4. Wait 30 minutes. Container Apps fetches the latest version of a Key Vault reference within
   30 minutes and restarts the revisions that use it. Then restart the web and worker revisions
   yourself to be sure (`az containerapp revision restart`, see
   [configuration](../configuration.md#azure-mapping-phase-7)).
5. Check: `/readyz` is ready, a hunting connector still works (run a test query), and
   **Settings → Notifications → Send test** still delivers. Stored values still decrypt with the
   old key, now from `APP_ENCRYPTION_KEY_PREVIOUS`.

While the apps refresh at different times, a value saved by one app under the new key cannot be
read by another app still on the old key. Expect at most a few failed notifications
(`notification_failed`) or scheduled hunt runs in that window; they work again once both apps
have the new key.

### Step 2: re-encrypt stored secrets

Run `rotate-secrets` once, using the one-off job pattern from [Azure deploy](azure-deploy.md#3-secrets-key-vault)
(the migration job). Point the job at the rotation command, start it, then put it back:

```sh
az containerapp job update -g $RG -n crosswire-web-migrate --container-name migrate \
  --command node_modules/.bin/tsx src/server/cli/rotate-secrets-cli.ts -o none
az containerapp job start -g $RG -n crosswire-web-migrate
az containerapp job execution list -g $RG -n crosswire-web-migrate -o table   # wait for Succeeded

# Put the migration command back (the deploy workflow relies on it):
az containerapp job update -g $RG -n crosswire-web-migrate --container-name migrate \
  --command node_modules/.bin/tsx src/server/cli/migrate.ts -o none
```

Read the result in Log Analytics:

```kusto
ContainerAppConsoleLogs_CL
| where ContainerJobName_s endswith "-migrate"
| extend j = parse_json(Log_s)
| where j.msg in ("rotate-secrets complete", "rotate-secrets failed")
```

The result has, per table (`orgConnectors`, `orgResponseConnectors`, `orgNotificationChannels`),
`rotated` (re-encrypted now) and `current` (already under the new key).

- **First run:** `rotated` covers the stored values and `current` is 0 (or counts values saved
  since step 1). If `rotated` is 0 and `current` is not, the job still loaded the old key as
  `APP_ENCRYPTION_KEY`, so nothing moved. Wait for the Key Vault reference to refresh (up to 30
  minutes) and run it again.
- **Failed** (`cannot decrypt secret with APP_ENCRYPTION_KEY or any APP_ENCRYPTION_KEY_PREVIOUS
  key`): nothing was changed. A value was encrypted with a key that is not configured. Check that
  `app-encryption-key-previous` holds the key that was current before step 1. If an older rotation
  was never finished, add that key too (comma-separated).
- Run it once more. Every table should show `rotated: 0`, which confirms all values are under the
  new key.

### Step 3: remove the old key

1. Remove the env var and the secret reference from the web app, the worker and the job:

   ```sh
   for APP in crosswire-web crosswire-worker; do
     az containerapp update -g $RG -n $APP --remove-env-vars APP_ENCRYPTION_KEY_PREVIOUS -o none
     az containerapp secret remove -g $RG -n $APP --secret-names app-encryption-key-previous -o none
   done
   az containerapp job update -g $RG -n crosswire-web-migrate --container-name migrate \
     --remove-env-vars APP_ENCRYPTION_KEY_PREVIOUS -o none
   az containerapp job secret remove -g $RG -n crosswire-web-migrate --secret-names app-encryption-key-previous -o none
   ```

2. Restart the web and worker revisions. Check a connector and a channel again.
3. Keep the Key Vault secret `app-encryption-key-previous`; do not delete it. Key Vault keeps a
   deleted secret's name reserved during soft delete (90 days by default), which would block step 1
   of the next rotation. The next rotation overwrites it with `az keyvault secret set`. If an earlier
   rotation already deleted it, recover it with
   `az keyvault secret recover --vault-name <vault> --name app-encryption-key-previous`, then set the
   new value.

**Keep the old key for restores.** Database backups taken before the rotation hold values
encrypted with the old key. Do not purge the earlier version of `app-encryption-key` (or the
earlier versions of `app-encryption-key-previous`) until the backup retention period has passed. To use
such a backup, restore it, then set the old key as `APP_ENCRYPTION_KEY_PREVIOUS` and run step 2
again. See [backup and restore](backup-restore.md).

## Compose and local

Same three steps with `.env` / `.env.prod`:

1. Set `APP_ENCRYPTION_KEY_PREVIOUS=<old key>` and `APP_ENCRYPTION_KEY=<new key>` (`openssl rand -hex 32`),
   then restart `web` and `worker`.
2. Run the rotation:
   - Compose: `docker compose -f docker-compose.prod.yml --env-file .env.prod run --rm migrate node_modules/.bin/tsx src/server/cli/rotate-secrets-cli.ts`
   - Checkout: `pnpm --filter web rotate-secrets`
3. Remove `APP_ENCRYPTION_KEY_PREVIOUS` and restart `web` and `worker`.

## Record

Note the date, operator and the counts from step 2 in your change ticket. The `secrets_rotated`
audit event is a system event with no org, so it is not shown under **Settings → Audit log**; query
it directly:

```sql
select created_at, data from audit_events where action = 'secrets_rotated' order by created_at desc limit 5;
```
