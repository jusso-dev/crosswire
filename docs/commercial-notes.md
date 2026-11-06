# Commercial hosted offering: planning notes (Later, issue #66)

Not a v1 deliverable. Crosswire stays MIT-licensed open source. These notes capture what a hosted
layer would need so it is not improvised into v1 work.

## Tenancy isolation

- The data model is already multi-tenant (`org_id` on every tenant table). A hosted service would
  add database-level isolation options: schema-per-org or database-per-org for regulated customers.
- Row-level security in Postgres as defence in depth behind `getCurrentOrg`.
- Per-org encryption keys (envelope encryption with Key Vault / Managed HSM) instead of one
  `APP_ENCRYPTION_KEY`.

## Secrets

- Customer connector secrets in a per-customer Key Vault, or workload identity federation so no
  customer secret is stored at all.
- Operator break-glass access logged and approved.

## Uptime and operations

- SLAs, on-call, status page, backups with tested restores, multi-zone ACA and Postgres HA.
- Data residency: per-region deployments (AU, EU, US) with no cross-region replication of tenant data.

## Additional SSO

- SAML (issue #65), SCIM provisioning, enforced MFA policies.

## Billing

- Per-org subscriptions, metering on model usage and hunting query volume.

## What stays open source

Connectors (pwn.watch, KEV, Defender, Sentinel), the agent charters, the gated response engine,
the safety rails, and the self-hosted deploy path. Paid value would be operations, compliance and
support, not core security features.
