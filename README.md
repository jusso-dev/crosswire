# Crosswire

Open-source SOC kit for Microsoft customers who already use **GitHub Copilot agents**. Crosswire gives a team a durable cast of specialist agents that get better with use: they hunt in **Microsoft Defender XDR** and **Microsoft Sentinel**, cross-compare threat intel, and propose **gated** auto-response that a human must approve before anything executes.

The product idea builds on [bradygaster/squad](https://github.com/bradygaster/squad) and `@bradygaster/squad-sdk`: charters, compounding history, parallel fan-out, and inspectable decisions — wrapped in a **TanStack Start** control plane instead of leaving everything in a repo-only Copilot workflow.

> **Status:** early scaffolding. The [milestones](https://github.com/jusso-dev/crosswire/milestones) and [issues](https://github.com/jusso-dev/crosswire/issues) are the build plan.

## Who it is for

- SOC, MDR, and Microsoft security teams that hunt in Defender XDR and Sentinel
- Teams already using GitHub Copilot agents (or planning to)
- People who want an open-source kit they can self-host in Docker, with **Azure as the first documented deploy target**
- A later commercial / hosted layer is intentionally out of v1 (see the Later milestone)

## What v1 does

| Capability | v1 |
| --- | --- |
| Analyst UI | TanStack Start dashboard + [TanStack AI basic-chat](https://tanstack.com/ai/latest/docs/ui/recipes/basic-chat) |
| Auth | [Better Auth](https://www.better-auth.com/) with **Entra ID OIDC** first (SAML later) |
| Agents | Security cast: Lead, Hunter, Intel, Responder, Scribe — Copilot-native; spike embedding `@bradygaster/squad-sdk` |
| Hunting | Live Advanced Hunting / Graph and Sentinel queries, with human review of proposed KQL |
| Response | Propose → human approve → execute (Sentinel playbooks / Logic Apps / Graph containment). Dry-run required. |
| Threat intel | [pwn.watch](https://pwn.watch) ingest + org watchlists (keywords, CVE, vendor, tag) and a daily digest. Investigate [cve.watch](https://cve.watch) or document a substitute (NVD/KEV). |
| Cloudflare Radar | **Not in v1** — optional TI feed later |
| Packaging | Docker (runs anywhere). First deploy guide targets Azure Container Apps (or App Service), Azure Database for PostgreSQL, and Key Vault |
| Hosting | **No Cloudflare Workers/Pages/D1** as a runtime |

## Default agent cast

| Agent | Role |
| --- | --- |
| **Lead** | Scopes hunts, routes work, signs off recommendations |
| **Hunter** | Defender XDR Advanced Hunting and Sentinel lake / incident queries |
| **Intel** | Watchlist matching, pwn.watch (and later other TI), cross-source compare |
| **Responder** | Drafts gated response proposals; never executes without approval |
| **Scribe** | Compresses hunt outcomes and analyst feedback into org memory |

## Stack (intended)

- **App:** TanStack Start + React, TanStack AI chat UI
- **Auth:** Better Auth (`tanstackStartCookies`), Entra OIDC
- **Data:** Postgres (compose for local; Azure Database for PostgreSQL in the first deploy)
- **Agents:** GitHub Copilot agent definitions + Squad-shaped memory (SDK spike in Phase 3)
- **Secrets:** environment files locally; Azure Key Vault in production
- **CI/CD:** GitHub Actions (lint, typecheck, tests; deploy with manual approval)

## Repository layout (target)

```
apps/web          TanStack Start control plane (dashboard, chat, approvals)
packages/*        Shared types, auth helpers, connectors (as they land)
.squad/           Security cast charters, routing, and exported memory (if used)
.github/          Copilot / Agentic Workflow definitions + Actions
infra/            Docker + Azure Bicep/Terraform
docs/             ADRs, runbooks, Entra app registration
```

Exact folders land in Phase 0. Until then this repo holds the plan, licence, and issues.

## Build plan

Work is tracked as **epics and child issues** under these milestones:

| Phase | Milestone | Theme |
| --- | --- | --- |
| Meta | — | [v1 definition of done](https://github.com/jusso-dev/crosswire/issues?q=is%3Aissue+label%3Aepic) |
| 0 | [Phase 0 — Foundation](https://github.com/jusso-dev/crosswire/milestone/1) | App scaffold, Docker Compose, env, CI, community files, ADRs |
| 1 | [Phase 1 — Auth](https://github.com/jusso-dev/crosswire/milestone/2) | Better Auth, Entra OIDC, orgs, session guards, auth audit |
| 2 | [Phase 2 — Dashboard + Chat](https://github.com/jusso-dev/crosswire/milestone/3) | App shell, dashboard empty states, TanStack AI chat, approval inbox stub |
| 3 | [Phase 3 — Squad / Copilot](https://github.com/jusso-dev/crosswire/milestone/4) | SDK spike, security cast, memory, Copilot wiring, learning loop |
| 4 | [Phase 4 — Watch + TI](https://github.com/jusso-dev/crosswire/milestone/5) | pwn.watch, watchlists, matcher, daily digest, TI compare (no Radar) |
| 5 | [Phase 5 — Hunting](https://github.com/jusso-dev/crosswire/milestone/6) | Live Defender XDR + Sentinel hunting, hunt cases, safe KQL |
| 6 | [Phase 6 — Gated response](https://github.com/jusso-dev/crosswire/milestone/7) | Proposals, approval, executors, dry-run, RBAC, audit |
| 7 | [Phase 7 — Azure deploy](https://github.com/jusso-dev/crosswire/milestone/8) | Production Docker, Azure first-target, runbooks, probes |
| Later | [Later](https://github.com/jusso-dev/crosswire/milestone/9) | Cloudflare Radar connector, SAML SSO, commercial / MSSP notes |

Browse all issues: [github.com/jusso-dev/crosswire/issues](https://github.com/jusso-dev/crosswire/issues)

All milestones: [github.com/jusso-dev/crosswire/milestones](https://github.com/jusso-dev/crosswire/milestones)

## Safety model

Crosswire is built for **human-led** security operations:

1. Agents may *propose* hunts and responses.
2. Destructive or tenant-changing actions require an explicit approval (and can expire unused).
3. Phase 5 hunting must not issue destructive Graph calls.
4. Phase 6 executors are feature-flagged and must support dry-run.
5. Every agent action and approval is auditable.

Do not point this kit at a production tenant without reviewing the Entra app permissions and running dry-run first.

## Licence

[MIT](./LICENSE). Open-source kit first; a hosted commercial offering is a later conversation, not a v1 deliverable.

## Related

- [bradygaster/squad](https://github.com/bradygaster/squad) — persistent specialist agents
- [TanStack Start](https://tanstack.com/start/latest) and [TanStack AI chat recipe](https://tanstack.com/ai/latest/docs/ui/recipes/basic-chat)
- [Better Auth](https://www.better-auth.com/) and [SSO plugin](https://www.better-auth.com/docs/plugins/sso)
- [Microsoft Security Copilot / Sentinel hunting docs](https://learn.microsoft.com/en-us/azure/sentinel/) (customer tenant; you bring the app registration)
