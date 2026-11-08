# Runbook: deploy to Azure (Container Apps)

Target (ADR 0003): Azure Container Apps (`web` + `worker`), PostgreSQL Flexible Server, Key Vault,
Log Analytics, one user-assigned managed identity. IaC: `infra/azure/main.bicep`.

## 1. Prerequisites

- Azure subscription, `az` CLI with Bicep, rights to create role assignments.
- A container image. The deploy workflow pushes `ghcr.io/<owner>/crosswire:<sha>`; make the GHCR
  package public or add registry credentials to the Container Apps.

## 2. Provision

```sh
az group create -n crosswire-prod -l australiaeast
export CROSSWIRE_PG_PASSWORD="$(openssl rand -base64 30)"
az deployment group what-if -g crosswire-prod -f infra/azure/main.bicep -p infra/azure/main.bicepparam \
  -p image=ghcr.io/jusso-dev/crosswire:<sha> appUrl=https://placeholder operatorObjectId=$(az ad signed-in-user show --query id -o tsv)
az deployment group create  -g crosswire-prod -f infra/azure/main.bicep -p infra/azure/main.bicepparam \
  -p image=ghcr.io/jusso-dev/crosswire:<sha> appUrl=https://placeholder operatorObjectId=$(az ad signed-in-user show --query id -o tsv)
```

Outputs: `webFqdn`, `keyVaultName`, `postgresHost`. Redeploy with `appUrl=https://<webFqdn>` (or
your custom domain). The web app reports **not ready** until migrations run (step 3).

## 3. Secrets (Key Vault)

Bicep writes `database-url`. Seed the rest (values never go in git or GitHub variables):

```sh
KV=<keyVaultName>
az keyvault secret set --vault-name $KV -n better-auth-secret --value "$(openssl rand -hex 32)"
az keyvault secret set --vault-name $KV -n app-encryption-key --value "$(openssl rand -hex 32)"
az keyvault secret set --vault-name $KV -n entra-client-secret --value '<SSO app secret>'
```

| Secret | Env var | Rotation |
| --- | --- | --- |
| `database-url` | `DATABASE_URL` | Change the Postgres password, update the secret, restart |
| `better-auth-secret` | `BETTER_AUTH_SECRET` | Rotating signs everyone out |
| `app-encryption-key` | `APP_ENCRYPTION_KEY` | Rotate with the [key rotation runbook](key-rotation.md) (keeps stored secrets readable) |
| `entra-client-secret` | `ENTRA_CLIENT_SECRET` | Before the Entra secret expires |

Email/password sign-up is disabled in Azure (`AUTH_EMAIL_PASSWORD=false`); analysts sign in with
Entra. Pass the non-secret Entra values as Bicep parameters on the redeploy (with the real
`appUrl`), so later redeploys keep them:

```sh
az deployment group create -g crosswire-prod -f infra/azure/main.bicep -p infra/azure/main.bicepparam \
  -p image=ghcr.io/jusso-dev/crosswire:<sha> appUrl=https://<webFqdn> operatorObjectId=<id> \
  entraClientId=<SSO app id> entraTenantId=<tenant guid>
```

`postgresAdminPassword` comes from `CROSSWIRE_PG_PASSWORD` on every run; a new value rotates the
Postgres password and the `database-url` secret together.

**Run migrations (first provision and whenever you deploy by hand):**

```sh
az containerapp job start -g crosswire-prod -n crosswire-web-migrate
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
  -p image=ghcr.io/jusso-dev/crosswire:<sha> appUrl=https://placeholder operatorObjectId=<id> \
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
NSGs on the two subnets.

## 4. GitHub Actions deploy (manual approval)

See also: [migrations](migrations.md), [rollback](rollback.md), [staging](staging.md), [custom domain](custom-domain.md), [backup and restore](backup-restore.md).

`.github/workflows/deploy.yml` runs on **workflow_dispatch only** (never on pull requests). It
deploys the commit you dispatch it on, or promotes an existing release with `image_tag=vX.Y.Z`:
CI → build, SBOM, CRITICAL CVE gate, push `ghcr.io/<owner>/crosswire:sha-<sha>` → optional
`staging` → **`production` environment approval** → migration job → update web and worker →
smoke test (`scripts/smoke.sh`). The job summary records the previous revision for
[rollback](rollback.md). Restrict the `production` environment to the `main` branch
(Environment → Deployment branches) so only reviewed code can be dispatched.

Setup:

1. Entra: create an app registration `crosswire-deploy` with a **federated credential** for
   `repo:<owner>/crosswire:environment:production` (OIDC; no client secret). Repos using GitHub's
   immutable-ID subject format send `repo:<owner>@<owner-id>/crosswire@<repo-id>:environment:production`
   instead; if `azure/login` fails with `AADSTS700213`, copy the exact `subject claim` from the
   job log into the federated credential.
2. Grant it **Contributor on the resource group only** (it updates container apps and starts the migration job).
3. GitHub → Settings → Environments → `production`: add required reviewers.
4. **Environment** variables on `production` (staging gets its own set): `AZURE_CLIENT_ID`,
   `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `AZURE_RESOURCE_GROUP`, `CROSSWIRE_NAME_PREFIX`
   (default `crosswire`), `CROSSWIRE_BASE_URL` (e.g. `https://crosswire.contoso.com`). No secrets needed.
5. After the first deploy, run [bootstrap](bootstrap.md) once.

## 5. Probes and logs

- Liveness/startup: `GET /healthz` (process up, no DB). Readiness: `GET /readyz` (503 when
  Postgres is unreachable). Both are configured in `infra/azure/modules/apps.bicep`.
- Logs are JSON lines (`time`, `level`, `msg`, fields) in Log Analytics:
  `ContainerAppConsoleLogs_CL | where ContainerAppName_s == 'crosswire-web'`.
- Authorization headers, cookies, tokens and secrets are redacted by the logger.
- **Application Insights (#73):** Bicep creates a workspace-based App Insights resource and passes
  `APPLICATIONINSIGHTS_CONNECTION_STRING` (not a secret) to the apps; `telemetry.mjs` (preloaded with
  `node --import`) enables the Azure Monitor OpenTelemetry distro for inbound and outbound HTTP.
  Postgres uses postgres.js, which has no OpenTelemetry instrumentation, so DB time appears inside
  request spans rather than as separate dependencies. Request URLs carry no secrets;
  headers and bodies are not exported; app logs stay redacted JSON in Log Analytics.
- **Alerts** (`infra/azure/modules/alerts.bicep`, email via `alertEmail`): HTTP 5xx (≥5 in 5 min),
  probe failures, and failed hunts/KQL runs/executions/worker jobs (error-level logs). Silence an
  alert: Azure portal → Monitor → Alerts → the rule → *Disable*, or add an alert processing rule for
  a maintenance window. Useful queries:
  - `ContainerAppConsoleLogs_CL | extend j=parse_json(Log_s) | where j.msg=="request" | summarize count() by tostring(j.status), bin(TimeGenerated, 5m)`
  - `ContainerAppConsoleLogs_CL | extend j=parse_json(Log_s) | where j.level=="error"`

## 6. Verification checklist

Same as the local runbook: sign in (Entra), chat streams, worker logs show ingest, approvals show
executors `off`, `/readyz` is 200.
