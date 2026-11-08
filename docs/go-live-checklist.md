# Go-live checklist (#81)

Printable. Tick each item for the environment you are going live on. Lab and production
expectations differ where noted.

**Environment:** ____________  **Date:** ____________  **Operator:** ____________

## Platform

- [ ] Azure deploy done: Bicep applied, migration job succeeded, web + worker healthy ([azure-deploy](runbooks/azure-deploy.md), [migrations](runbooks/migrations.md))
- [ ] Smoke test green: `scripts/smoke.sh https://<host> <migration-tag>` ([smoke](runbooks/azure-deploy.md#5-probes-and-logs))
- [ ] Custom domain + managed TLS bound, HSTS present ([custom-domain](runbooks/custom-domain.md)) — *lab: default ACA host acceptable*
- [ ] Backups on (PITR retention set) and **one restore drill completed**, logged in the [drill log](runbooks/backup-restore.md#drill-log). RPO/RTO recorded: ______
- [ ] Data retention periods agreed and set (`RETENTION_*`; defaults chat 365, decisions 365, samples 180, audit 730 days); first `retention_purge` audit event seen ([data retention](runbooks/data-retention.md))
- [ ] Key rotation runbook read; owner of `app-encryption-key` named: ______ ([key rotation](runbooks/key-rotation.md))
- [ ] Rollback procedure read; previous image tag noted: ______ ([rollback](runbooks/rollback.md))
- [ ] Application Insights receiving data; alert email set and a test alert received ([azure-deploy](runbooks/azure-deploy.md))
- [ ] Bootstrap run once; first admin email: ______ ([bootstrap](runbooks/bootstrap.md))

## Identity and access

- [ ] Entra SSO app: single-tenant, redirect URI for the final host, secret in Key Vault ([auth](auth.md#entra-id-oidc-issue-19))
- [ ] Org linked to tenant id; email/password sign-up OFF in production (`AUTH_EMAIL_PASSWORD=false`)
- [ ] Approver RBAC set: at least two people with `approver`/`owner`; analysts are `analyst` ([response](response.md#approval-workflow-and-rbac-issues-51-55))
- [ ] Session limits confirmed (`SESSION_MAX_AGE_HOURS` default 12, `SESSION_IDLE_MINUTES` default 60) and MFA required by Entra Conditional Access on the SSO app ([auth](auth.md#session-lifetime))

## Hunting (least privilege)

- [ ] Separate hunting app: `ThreatHunting.Read.All`, Log Analytics Reader, Sentinel Reader only; no write permissions ([hunting](hunting.md))
- [ ] Connector saved (encrypted secret or org-scoped `env:CROSSWIRE_HUNT_<ORG>_…` ref); `HUNTING_DEMO_MODE=false` in production
- [ ] KQL approval policy chosen and set: `KQL_APPROVAL_POLICY` = ______ (`member` default, `approver`, or `second-person`) ([hunting](hunting.md#approval-policy-kql_approval_policy))
- [ ] Test query ran with `mode: live`

## Response safety

- [ ] Dashboard shows **dry-run ON** and every executor `off` (or `dry-run`) ([response](response.md))
- [ ] No change ticket exists yet for live execution (required before `RESPONSE_DRY_RUN=false`)

## Operations

- [ ] Digest email target: org owners' mailboxes receive the daily digest (SMTP configured); owners whose sign-in email has no mailbox have confirmed a digest address in **Settings → Digest email** ([watchlists](watchlists.md#digest-email-address-102)) (*lab: in-app only is fine*)
- [ ] Support contact for operators: ______ (security reports: [SECURITY.md](../SECURITY.md))
- [ ] Day-1 playbook shared with analysts ([day-1 playbook](day-1-operator-playbook.md))
