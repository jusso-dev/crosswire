# Runbook: staging (optional lab slot) (#86)

**Choice: ephemeral staging, docs + workflow support.** A second always-on environment roughly
doubles the monthly cost (Container Apps + Postgres), which is not justified for most labs. Stand it
up for a release window, test, then tear it down.

## Stand up

```sh
az group create -n crosswire-staging -l australiaeast
az deployment group create -g crosswire-staging -f infra/azure/main.bicep -p infra/azure/main.bicepparam \
  -p prefix=cwstg image=ghcr.io/<owner>/crosswire:<tag> appUrl=https://placeholder
```

Seed Key Vault secrets as in the [Azure runbook](azure-deploy.md) (**different values from
production**), then redeploy with `appUrl=https://<staging fqdn>`.

## GitHub Environment `staging`

Create environment `staging` with its **own** variables (`AZURE_CLIENT_ID`, `AZURE_TENANT_ID`,
`AZURE_SUBSCRIPTION_ID`, `AZURE_RESOURCE_GROUP=crosswire-staging`, `CROSSWIRE_NAME_PREFIX=cwstg`,
`CROSSWIRE_BASE_URL`) and a federated credential for `environment:staging` scoped to the staging
resource group only. Reviewers optional.

Deploy → Run workflow → `staging: true`. The same image goes to staging first (migrate + smoke), then
production still waits for its own approval. Staging uses separate variables and a separate Azure
identity, so it cannot deploy to production resources.

## What differs from production

| | Staging | Production |
| --- | --- | --- |
| Resource group / prefix | `crosswire-staging` / `cwstg` | `crosswire-prod` / `crosswire` |
| `APP_URL`, trusted origins | staging FQDN | custom domain |
| Entra SSO redirect URI | add staging callback to a **test** app registration | prod app registration |
| Hunting connector | test tenant or demo mode | customer tenant |
| Postgres SKU | Burstable B1ms | Burstable/General Purpose as needed |
| Secrets | separate Key Vault, separate values | production Key Vault |
| Response flags | dry-run on, executors off | dry-run on, executors off (change ticket to alter) |

## Tear down

`az group delete -n crosswire-staging --yes` (Key Vault soft-delete keeps the vault name reserved for 30 days; purge protection is on).
