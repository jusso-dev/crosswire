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
| `app-encryption-key` | `APP_ENCRYPTION_KEY` | Re-save hunting connector secrets afterwards |
| `entra-client-secret` | `ENTRA_CLIENT_SECRET` | Before the Entra secret expires |

Email/password sign-up is disabled in Azure (`AUTH_EMAIL_PASSWORD=false`); analysts sign in with
Entra. Set the non-secret Entra values on both apps:

```sh
for app in crosswire-web crosswire-worker; do
  az containerapp update -g crosswire-prod -n $app --set-env-vars ENTRA_CLIENT_ID=<id> ENTRA_TENANT_ID=<tenant>
done
az containerapp revision restart -g crosswire-prod -n crosswire-web --revision $(az containerapp show -g crosswire-prod -n crosswire-web --query properties.latestRevisionName -o tsv)
```

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
production, create the Container Apps environment in a VNet and give Postgres private access
(VNet integration or a private endpoint) before deploying apps. For a quick lab only, pass
`postgresPublicAccess=true`: that adds the "Allow Azure services" firewall rule, which admits any
Azure-hosted client (including other customers') that has the credentials.

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
   `repo:<owner>/crosswire:environment:production` (OIDC; no client secret).
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
