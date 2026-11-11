# Runbook: deploy to Azure (Container Apps)

Target (ADR 0003): Azure Container Apps (`web` + `worker`), PostgreSQL Flexible Server, Key Vault,
Log Analytics, one user-assigned managed identity. IaC: `infra/azure/main.bicep`.

## 1. Prerequisites

- Azure subscription, `az` CLI with Bicep, rights to create role assignments.
- A container image. The deploy workflow pushes `ghcr.io/<owner>/crosswire:sha-<sha>` (the full
  40-character commit SHA); releases also push `:vX.Y.Z`. Make the GHCR package public or add
  registry credentials to the Container Apps.

## 2. Provision

First deployment. Generate both database passwords once and store them in your password manager.
You need the same values on every later run.

```sh
az group create -n crosswire-prod -l australiaeast
export CROSSWIRE_PG_PASSWORD="$(openssl rand -base64 30)"       # Postgres admin (owner)
export CROSSWIRE_PG_APP_PASSWORD="$(openssl rand -base64 30)"   # app role used by web and worker
az deployment group what-if -g crosswire-prod -f infra/azure/main.bicep -p infra/azure/main.bicepparam \
  -p image=ghcr.io/jusso-dev/crosswire:sha-<40 hex> appUrl=https://placeholder alertEmail=<ops email> \
     operatorObjectId=$(az ad signed-in-user show --query id -o tsv) \
     rotatePostgresPassword=true rotateAppDatabasePassword=true
az deployment group create  -g crosswire-prod -f infra/azure/main.bicep -p infra/azure/main.bicepparam \
  -p image=ghcr.io/jusso-dev/crosswire:sha-<40 hex> appUrl=https://placeholder alertEmail=<ops email> \
     operatorObjectId=$(az ad signed-in-user show --query id -o tsv) \
     rotatePostgresPassword=true rotateAppDatabasePassword=true
```

Outputs: `webFqdn`, `keyVaultName`, `postgresHost`, `kqlApprovalPolicy`. Redeploy with
`appUrl=https://<webFqdn>` (or your custom domain). The web app reports **not ready** until
migrations run (step 3).

**Routine redeploys** export the same two values and leave both `rotate*` flags at `false` (the
default). Both passwords are required on every run, with at least 16 characters and no default, so a
missing variable stops the deployment before anything changes. With the flags off, Bicep does not
send the admin password to the server and does not rewrite either Key Vault secret, so a typo or a
different shell cannot change a live password (#137).

`alertEmail` is required: a deployment whose alerts notify nobody fails with a clear error (#153).
A lab may pass `allowAlertsWithoutEmail=true` instead.

### Settings Bicep keeps (#133)

Bicep sets every plain environment variable on web and worker, so set policy here, not in the
portal. A Bicep redeploy replaces each app's env list.

| Bicep parameter | Env var | Default |
| --- | --- | --- |
| `kqlApprovalPolicy` | `KQL_APPROVAL_POLICY` | `member` |
| `responseAllowSelfApproval` | `RESPONSE_ALLOW_SELF_APPROVAL` | `false` |
| `sessionMaxAgeHours`, `sessionIdleMinutes` | `SESSION_MAX_AGE_HOURS`, `SESSION_IDLE_MINUTES` | `12`, `60` |
| `retentionChatDays`, `retentionDecisionsDays`, `retentionSamplesDays`, `retentionAuditDays` | `RETENTION_*_DAYS` | `365`, `365`, `180`, `730` |
| `rateLimitChatPerMin`, `rateLimitStorage` | `RATE_LIMIT_CHAT_PER_MIN`, `RATE_LIMIT_STORAGE` | `20`, `database` |
| `trustedProxies` | `TRUSTED_PROXIES` | empty |
| `huntingDemoMode`, `allowDemoFixtures` | `HUNTING_DEMO_MODE`, `ALLOW_DEMO_FIXTURES` | `false` (labs set `true`) |

The web app logs the approval policy in force at start-up (`"msg":"approval policy"`), and the
deployment output `kqlApprovalPolicy` shows what Bicep set. `apps/web/test/bicep-env-coverage.test.ts`
fails when a new variable in `env.ts` is neither set by Bicep nor listed as not needed in Azure.

## 3. Secrets (Key Vault)

Bicep writes `database-url` (owner, migration job only) and `database-url-app` (app role, web and
worker) when the matching `rotate*` flag is true. Seed the rest (values never go in git or GitHub
variables):

```sh
KV=<keyVaultName>
az keyvault secret set --vault-name $KV -n better-auth-secret --value "$(openssl rand -hex 32)"
az keyvault secret set --vault-name $KV -n app-encryption-key --value "$(openssl rand -hex 32)"
az keyvault secret set --vault-name $KV -n entra-client-secret --value '<SSO app secret>'
```

| Secret | Env var | Rotation |
| --- | --- | --- |
| `database-url` | `DATABASE_URL` (migration job) | See "Rotate the database passwords" below |
| `database-url-app` | `DATABASE_URL` (web, worker); `APP_DATABASE_URL` (migration job) | See below |
| `better-auth-secret` | `BETTER_AUTH_SECRET` | Rotating signs everyone out |
| `app-encryption-key` | `APP_ENCRYPTION_KEY` | Rotate with the [key rotation runbook](key-rotation.md) (keeps stored secrets readable) |
| `entra-client-secret` | `ENTRA_CLIENT_SECRET` | Before the Entra secret expires |

Email/password sign-up is disabled in Azure (`AUTH_EMAIL_PASSWORD=false`); analysts sign in with
Entra. Pass the non-secret Entra values as Bicep parameters on the redeploy (with the real
`appUrl`), so later redeploys keep them:

```sh
az deployment group create -g crosswire-prod -f infra/azure/main.bicep -p infra/azure/main.bicepparam \
  -p image=ghcr.io/jusso-dev/crosswire:sha-<40 hex> appUrl=https://<webFqdn> operatorObjectId=<id> \
  entraClientId=<SSO app id> entraTenantId=<tenant guid>
```

### Database TLS (#134)

Both database URLs end with `sslmode=verify-full`: the driver checks the server certificate chain
and host name. Azure Database for PostgreSQL certificates chain to DigiCert Global Root G2 and
Microsoft RSA Root Certificate Authority 2017. Both are in the CA list bundled with Node 24, which
the image uses, so no CA file is needed. In production the app logs a warning at start-up when
`DATABASE_URL` has no `sslmode=verify-full`. `DATABASE_TLS_INSECURE_OK=true` silences that warning
for a database without TLS on a private network. It does not change how the app connects.

**Existing deployments:** a routine redeploy does not rewrite `database-url`. To move it to
`verify-full`, run one deployment with `rotatePostgresPassword=true` and the current password
(the server keeps the same password, the secret is rewritten), then restart the apps.

### Least-privilege app role (#135)

Web and worker connect as `crosswire_app` (`postgresAppLogin`), which has `SELECT, INSERT, UPDATE,
DELETE` on the app tables and no DDL. The migration job keeps the owner URL, and after migrations
runs `node scripts/app-db-role.mjs`, which creates the role, sets its password from
`database-url-app`, and grants again. See [migrations](migrations.md#database-roles-135).

**Adding the app role to an existing deployment:** export `CROSSWIRE_PG_APP_PASSWORD`, deploy once
with `rotateAppDatabasePassword=true` (and `rotatePostgresPassword=true` with the current admin
password, to move `database-url` to `verify-full`), then run the migration job (or a Deploy) before
the new web and worker revisions start. Until the job has created the role, web and worker cannot
connect.

### Rotate the database passwords (#137)

Rotation is its own step, never part of a routine deploy:

1. Generate the new value and store it in your password manager.
2. Admin: export it as `CROSSWIRE_PG_PASSWORD` and deploy with `rotatePostgresPassword=true`. Bicep
   sets it on the server and rewrites `database-url`.
   App role: export it as `CROSSWIRE_PG_APP_PASSWORD` and deploy with `rotateAppDatabasePassword=true`.
   Bicep rewrites `database-url-app`, then start the migration job, which sets the new password on
   the role.
3. Restart so running revisions read the new secret:
   `az containerapp revision restart -g crosswire-prod -n crosswire-web --revision <latest>` (and the
   worker). Between steps 2 and 3, revisions holding the old app password fail to reconnect, so do
   this in a quiet period.
4. Set both flags back to `false` (the default) for later deploys.

**Run migrations (first provision and whenever you deploy by hand):**

```sh
az containerapp job start -g crosswire-prod -n crosswire-web-migrate   # migrations, then the app role
az containerapp job execution list -g crosswire-prod -n crosswire-web-migrate -o table   # wait for Succeeded
curl -fsS https://<webFqdn>/readyz    # {"status":"ready",...}
```

The Deploy workflow does this automatically. Then run [bootstrap](bootstrap.md) once.

**Verify identity access:** `az containerapp show -g crosswire-prod -n crosswire-web --query
properties.configuration.secrets` lists Key Vault references; the revision only becomes healthy
when the identity can read them (Key Vault Secrets User is assigned by Bicep).

**Postgres access:** `postgresPublicAccess` defaults to `false` (no public endpoint). For
production, use [private networking](#private-networking-production). For a quick lab only, pass
`postgresPublicAccess=true`: that adds the "Allow Azure services" firewall rule, which admits any
Azure-hosted client (including other customers') that has the credentials.

### Private networking (production)

Pass `privateNetworking=true` on the **first** deployment into a resource group. The default is
`false`, so existing deployments are unchanged and nothing is recreated.

What it creates (`infra/azure/modules/network.bicep`):

| Resource | Detail |
| --- | --- |
| VNet `<prefix>-vnet` | Address space `vnetAddressPrefix` (default `10.40.0.0/22`, must be /23 or larger) |
| Subnet `snet-aca` | First /24, delegated to `Microsoft.App/environments` (workload profiles minimum is /27) |
| Subnet `snet-postgres` | /28 after it, delegated to `Microsoft.DBforPostgreSQL/flexibleServers`, with the `Microsoft.Storage` service endpoint Postgres needs |
| Private DNS zone | `<pg-name>.private.postgres.database.azure.com`, linked to the VNet |

It also changes how two existing resources are created:

- **Container Apps environment:** `vnetConfiguration.infrastructureSubnetId` set to `snet-aca`,
  `internal: false` (ingress stays public, `webFqdn` works as before). A delegated subnet needs a
  workload profiles environment, so the environment gets the built-in `Consumption` profile and
  `web`, `worker` and the migration job run on it. Azure also creates a managed `ME_` resource
  group with a public IP and load balancer, which are billed.
- **PostgreSQL:** `network.delegatedSubnetResourceId` and `privateDnsZoneArmResourceId` set,
  `publicNetworkAccess: Disabled`, no firewall rules. The server name in `database-url` does not
  change; inside the VNet it resolves to the private address.

`postgresPublicAccess=true` together with `privateNetworking=true` fails the deployment with a
clear error (rather than silently ignoring one of them). The lab (`crosswire-lab`) keeps public
access: it stays on `postgresPublicAccess=true` and `privateNetworking=false`.

```sh
az deployment group create -g crosswire-prod -f infra/azure/main.bicep -p infra/azure/main.bicepparam \
  -p image=ghcr.io/jusso-dev/crosswire:sha-<40 hex> appUrl=https://placeholder operatorObjectId=<id> \
  privateNetworking=true
```

Keep passing `privateNetworking=true` on every redeploy of that resource group (or set it in your
param file). Without it the template sends an environment and apps with no VNet or workload
profile, which Azure rejects or only partly applies. Run what-if first if unsure.

**Migration from a public deployment.** You cannot turn this on in place. A Container Apps
environment cannot gain a VNet after creation, and a Postgres server cannot move from public
access to VNet integration. Switching means a new environment (with a **new default hostname**,
so a new `webFqdn`) and a new server. Plan it as a new deployment:

1. Deploy into a **new resource group** with `privateNetworking=true` (names derive from the
   resource group, so nothing collides with the old one).
2. Seed Key Vault secrets (step 3). Reuse `app-encryption-key` from the old vault, or saved
   hunting connector secrets cannot be decrypted.
3. Move the data: dump the old database and restore it into the new server from a host inside
   the VNet (or a peered network). The new server has no public endpoint, so a laptop cannot
   reach it directly. See [backup and restore](backup-restore.md).
4. Run migrations, then redeploy with `appUrl=https://<new webFqdn>` or your custom domain.
5. Update the Entra app redirect URI and any custom domain DNS
   ([custom domain](custom-domain.md)) to the new hostname, update `AZURE_RESOURCE_GROUP` in
   the GitHub environment, then retire the old resource group.

Operator access to Postgres (`psql`, restores) needs a jump host, Azure Bastion or a VPN into the
VNet. Container Apps ingress and Key Vault stay public; Key Vault still relies on RBAC.

**Follow-up (not built):** a Key Vault private endpoint with `publicNetworkAccess: Disabled`, and
NSGs on the two subnets. See [backup and restore](backup-restore.md#data-tier-resilience-154) for
the recorded decision.

## 4. GitHub Actions deploy (manual dispatch from main)

See also: [migrations](migrations.md), [rollback](rollback.md), [staging](staging.md), [custom domain](custom-domain.md), [backup and restore](backup-restore.md).

**The gate (#136).** Code reaches `main` only through a pull request with CI green: the `main`
ruleset requires a pull request and the "Lint, typecheck, test, build" check, and blocks force
pushes and deletion. A deploy is a manual dispatch of the Deploy workflow by a maintainer, and the
`production` environment accepts `main` only. There are no required reviewers on `production`:
with one maintainer, review happens on the pull request. With a second maintainer, add required
reviewers to `production` with self-review prevented.

`.github/workflows/deploy.yml` runs on **workflow_dispatch only** (never on pull requests). It
deploys the commit you dispatch it on, or promotes an existing image with `image_tag` set to
`vX.Y.Z` or `sha-<40 hex>` (#140). The commit must be on `main`, and the image's signed provenance
must name that commit. Steps: CI → build, SBOM, CRITICAL CVE gate, push
`ghcr.io/<owner>/crosswire:sha-<sha>` → migration job → update web and worker → wait for both
revisions to be ready (the worker's health probe included) → smoke test (`scripts/smoke.sh`, with
retries) against the migration tag of the image's own commit. If the rollout or smoke test fails,
the job puts web and worker back on their previous images and fails. The job summary records the
previous images for [rollback](rollback.md). There is no staging target; [staging](staging.md) says
how to add one.

Setup:

1. Entra: create an app registration `crosswire-deploy` with a **federated credential** for
   `repo:<owner>/crosswire:environment:production` (OIDC; no client secret). Repos using GitHub's
   immutable-ID subject format send `repo:<owner>@<owner-id>/crosswire@<repo-id>:environment:production`
   instead; if `azure/login` fails with `AADSTS700213`, copy the exact `subject claim` from the
   job log into the federated credential.
2. Grant it **Contributor on the resource group only** (it updates container apps and starts the migration job).
3. GitHub → Settings → Environments → `production`: deployment branches limited to `main`. No
   required reviewers while there is one maintainer (see the gate above).
4. **Environment** variables on `production`: `AZURE_CLIENT_ID`,
   `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `AZURE_RESOURCE_GROUP`, `CROSSWIRE_NAME_PREFIX`
   (default `crosswire`), `CROSSWIRE_BASE_URL` (e.g. `https://crosswire.contoso.com`). No secrets needed.
5. After the first deploy, run [bootstrap](bootstrap.md) once.

## 5. Probes and logs

- Web liveness/startup: `GET /healthz` (process up, no DB). Readiness: `GET /readyz` (503 when
  Postgres is unreachable or a shipped migration is not applied).
- Worker (#142): startup, liveness and readiness probes on its health server
  (`WORKER_HEALTH_PORT`, default 3001) `GET /healthz`, which is 200 while the last loop finished
  under 3 minutes ago. A stuck loop is restarted. All probes are in `infra/azure/modules/apps.bicep`.
  The loop runs only the quick database jobs (expiry, stale runs and executions). Scheduled
  searches, the daily digest and the retention purge start from it but run alongside (#197), so a
  slow query or SMTP server does not make the probe fail. Each of them never runs twice at once.
- Logs are JSON lines (`time`, `level`, `msg`, fields) in Log Analytics:
  `ContainerAppConsoleLogs_CL | where ContainerAppName_s == 'crosswire-web'`.
- Authorization headers, cookies, tokens and secrets are redacted by the logger.
- **Application Insights (#73):** Bicep creates a workspace-based App Insights resource and passes
  `APPLICATIONINSIGHTS_CONNECTION_STRING` (not a secret) to the apps; `telemetry.mjs` (preloaded with
  `node --import`) enables the Azure Monitor OpenTelemetry distro for inbound and outbound HTTP.
  Postgres uses postgres.js, which has no OpenTelemetry instrumentation, so DB time appears inside
  request spans rather than as separate dependencies. Request URLs carry no secrets;
  headers and bodies are not exported; app logs stay redacted JSON in Log Analytics.
- **Alerts** (`infra/azure/modules/alerts.bicep`, email via `alertEmail`, required): HTTP 5xx
  (5 or more in 5 min), probe failures, worker restarts or failed health probes, migration job
  errors, failed hunts/KQL runs/executions/notifications/worker jobs (error-level logs with a known
  `msg`), and Postgres storage over 80% or connections over 40. On a new workspace the log queries
  are not validated at deploy time (their tables appear with the first logs); once logs are flowing,
  redeploy with `skipAlertQueryValidation=false` to catch a broken query.
  Silence an
  alert: Azure portal → Monitor → Alerts → the rule → *Disable*, or add an alert processing rule for
  a maintenance window. Useful queries:
  - `ContainerAppConsoleLogs_CL | extend j=parse_json(Log_s) | where j.msg=="request" | summarize count() by tostring(j.status), bin(TimeGenerated, 5m)`
  - `ContainerAppConsoleLogs_CL | extend j=parse_json(Log_s) | where j.level=="error"`

## 6. Verification checklist

Same as the local runbook: sign in (Entra), chat streams, worker logs show ingest, approvals show
executors `off`, `/readyz` is 200.
