# Go-live checklist (#81)

Printable. Tick each item for the environment you are going live on. Lab and production
expectations differ where noted.

**Environment:** ____________  **Date:** ____________  **Operator:** ____________

## Platform

- [ ] Azure deploy done: Bicep applied, migration job succeeded, web + worker healthy ([azure-deploy](runbooks/azure-deploy.md), [migrations](runbooks/migrations.md))
- [ ] Smoke test green: `scripts/smoke.sh https://<host> <migration-tag>` ([smoke](runbooks/azure-deploy.md#5-probes-and-logs))
- [ ] Custom domain + managed TLS bound, HSTS present ([custom-domain](runbooks/custom-domain.md)) — *lab: default ACA host acceptable*
- [ ] Backups on (PITR retention set) and **one restore drill completed** ([backup-restore](runbooks/backup-restore.md)) — RPO/RTO recorded: ______
- [ ] Rollback procedure read; previous image tag noted: ______ ([rollback](runbooks/rollback.md))
- [ ] Application Insights receiving data; alert email set and a test alert received ([azure-deploy](runbooks/azure-deploy.md))
- [ ] Bootstrap run once; first admin email: ______ ([bootstrap](runbooks/bootstrap.md))

## Identity and access

- [ ] Entra SSO app: single-tenant, redirect URI for the final host, secret in Key Vault ([auth](auth.md#entra-id-oidc-issue-19))
- [ ] Org linked to tenant id; email/password sign-up OFF in production (`AUTH_EMAIL_PASSWORD=false`)
- [ ] Approver RBAC set: at least two people with `approver`/`owner`; analysts are `analyst` ([response](response.md#approval-workflow-and-rbac-issues-51-55))

## Hunting (least privilege)

- [ ] Separate hunting app: `ThreatHunting.Read.All`, Log Analytics Reader, Sentinel Reader only; no write permissions ([hunting](hunting.md))
- [ ] Connector saved (encrypted secret or org-scoped `env:CROSSWIRE_HUNT_<ORG>_…` ref); `HUNTING_DEMO_MODE=false` in production
- [ ] Test query ran with `mode: live`

## Response safety

- [ ] Dashboard shows **dry-run ON** and every executor `off` (or `dry-run`) ([response](response.md))
- [ ] No change ticket exists yet for live execution (required before `RESPONSE_DRY_RUN=false`)

## Operations

- [ ] Digest email target: org owners' mailboxes receive the daily digest (SMTP configured) — *lab: in-app only is fine*
- [ ] Support contact for operators: ______ (security reports: [SECURITY.md](../SECURITY.md))
- [ ] Day-1 playbook shared with analysts ([day-1 playbook](day-1-operator-playbook.md))
