# 0003. Azure first deploy target: Container Apps

- **Status:** Accepted
- **Date:** 2026-11-07

## Context

Issue #59 asks for one Azure compute target. Crosswire ships as a container with a web process
and a background worker.

## Decision

Azure Container Apps (ACA), provisioned with Bicep in `infra/azure/`:

- `web` app with external HTTPS ingress, liveness `/healthz`, readiness `/readyz`.
- `worker` app (same image, worker command), exactly one replica.
- User-assigned managed identity reads Key Vault secrets (Key Vault references).
- Azure Database for PostgreSQL Flexible Server; Log Analytics for container logs.

## Consequences

- One image, two apps; no App Service plan or Functions needed.
- Probes and scale rules are declarative in Bicep.
- App Service remains possible (same image) but is not documented.

## Alternatives considered

- **App Service for Containers:** fine for the web process, but the always-on worker is clumsier.
- **AKS:** too heavy for a first deploy of an OSS kit.
