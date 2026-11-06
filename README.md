# Crosswire

Open-source SOC kit for Microsoft customers who already use **GitHub Copilot agents**. Crosswire gives a team a durable cast of specialist agents that get better with use: they hunt in **Microsoft Defender XDR** and **Microsoft Sentinel**, cross-compare threat intel, and propose **gated** auto-response that a human must approve before anything executes.

The product idea builds on [bradygaster/squad](https://github.com/bradygaster/squad) and `@bradygaster/squad-sdk`: charters, compounding history, parallel fan-out, and inspectable decisions — wrapped in a **TanStack Start** control plane instead of leaving everything in a repo-only Copilot workflow.

> **Status:** Phases 0–7 and the Later items are implemented; Phase 8 (production hardening and first use) is the v1 ship gate. The [milestones](https://github.com/jusso-dev/crosswire/milestones) and [issues](https://github.com/jusso-dev/crosswire/issues) are the build plan (Phases 0–8 plus Later).

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
| Agents | Security cast: Lead, Hunter, Intel, Responder, Scribe. Squad-shaped charters and memory; hybrid runtime per [ADR 0002](docs/adr/0002-squad-sdk-embed.md) |
| Hunting | Live Advanced Hunting / Graph and Sentinel queries, with human review of proposed KQL |
| Response | Propose → human approve → execute (Sentinel playbooks / Logic Apps / Graph containment). Dry-run required. |
| Threat intel | [pwn.watch](https://pwn.watch) ingest + org watchlists (keywords, CVE, vendor, tag) and a daily digest. cve.watch is unavailable, so CISA KEV is the CVE source ([details](docs/ti/cve.watch.md)). |
| Cloudflare Radar | **Not in v1.** Optional, flag-off IP/domain enrichment on the compare view (Later) |
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

## Quick start

Requirements: Node 24 (`.nvmrc`), pnpm 10 (`corepack enable`), Docker.

```sh
git clone https://github.com/jusso-dev/crosswire && cd crosswire
corepack enable && pnpm install
cp .env.example .env                 # set BETTER_AUTH_SECRET and APP_ENCRYPTION_KEY (openssl rand -hex 32)
docker compose up -d postgres
pnpm db:migrate
pnpm dev                             # http://localhost:3000, then "Create an account"
```

Or run everything in Docker: `docker compose up --build` (app, Postgres, worker; Redis optional via
`--profile redis`).

No tenant or API key needed: chat uses a labelled stub model, hunting has a demo mode, and TI can be
loaded from recorded fixtures (`pnpm ingest:pwn --fixtures test/fixtures/pwnwatch`).

| Command | What it does |
| --- | --- |
| `pnpm dev` / `pnpm build` / `pnpm start` | Develop, build, run the production server |
| `pnpm lint` / `pnpm typecheck` / `pnpm test` | The checks CI runs (tests use in-process Postgres) |
| `pnpm db:generate` / `pnpm db:migrate` | Create / apply Drizzle migrations |
| `pnpm ingest:pwn` / `pnpm ingest:cve` | Ingest pwn.watch and CISA KEV (polite, cached) |
| `pnpm match:watches` / `pnpm digest:daily` | Match watchlists, build daily digests |
| `pnpm expire:proposals` / `pnpm compact-memory` | Expire stale proposals, compact agent memory |
| `pnpm worker` | Background worker running the jobs above on a schedule |

## Stack

- **App:** TanStack Start + React, [TanStack AI basic-chat](https://tanstack.com/ai/latest/docs/ui/recipes/basic-chat) (`POST /api/chat`, SSE)
- **Auth:** Better Auth (`tanstackStartCookies`), local email/password, Entra ID OIDC
- **Data:** Postgres + Drizzle (Compose locally; Azure Database for PostgreSQL in the first deploy)
- **Agents:** charters in `.squad/`, in-process runtime (stub or BYO Anthropic/OpenAI key), Copilot custom agents in `.github/agents/` ([ADR 0002](docs/adr/0002-squad-sdk-embed.md))
- **Secrets:** env files locally; Azure Key Vault references in production
- **CI/CD:** GitHub Actions on GitHub-hosted runners (lint, typecheck, tests, image build); manual-approval deploy to Azure

## Repository layout

```
apps/web          TanStack Start control plane (dashboard, chat, hunts, watches, approvals)
  src/routes      Pages and HTTP endpoints (/api/chat, /api/auth/*, /healthz, /readyz)
  src/fns         Server functions (session-guarded) used by the UI
  src/server      Auth, DB schema, agents, TI, hunting, response, CLI jobs
  drizzle/        SQL migrations
  test/           Vitest suites (PGlite) and recorded TI fixtures
.squad/           Security cast charters, team and routing
.github/          Copilot custom agents + CI and deploy workflows
infra/            Azure Bicep and prod Compose env example
docs/             ADRs, runbooks, auth, hunting, response, TI
```

## Documentation

- Architecture: [ADRs](docs/adr/README.md) ([0001 overview](docs/adr/0001-architecture-overview.md))
- Setup: [configuration](docs/configuration.md), [auth and Entra SSO](docs/auth.md)
- Product areas: [agents and memory](docs/agents.md), [watchlists and TI](docs/watchlists.md), [hunting](docs/hunting.md), [gated response](docs/response.md), [Copilot agents](docs/copilot-agents.md)
- Threat intel sources: [pwn.watch](docs/ti/pwn.watch.md), [cve.watch status and CISA KEV substitute](docs/ti/cve.watch.md)

## Deploy

- [Local Docker and any Docker host](docs/runbooks/local-docker.md) (`docker-compose.prod.yml`)
- [Azure Container Apps](docs/runbooks/azure-deploy.md) (Bicep in `infra/azure/`, manual-approval GitHub Actions)
- [Customer Entra setup](docs/runbooks/entra-setup.md) (SSO vs hunting permissions)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) and
[SECURITY.md](SECURITY.md) (report vulnerabilities privately).

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
| 7 | [Phase 7 — Azure deploy](https://github.com/jusso-dev/crosswire/milestone/8) | Production Docker, Azure first-target, runbooks, probes, SBOM scan, optional staging |
| 8 | [Phase 8 — Prod + first use](https://github.com/jusso-dev/crosswire/milestone/10) | Prod hardening, release, go-live checklist, first successful operator use (SSO → watch → hunt → gated dry-run) |
| Later | [Later](https://github.com/jusso-dev/crosswire/milestone/9) | Cloudflare Radar connector, SAML SSO, [commercial notes](docs/commercial-notes.md), [MSSP backlog](docs/mssp-backlog.md) |

Browse all issues: [github.com/jusso-dev/crosswire/issues](https://github.com/jusso-dev/crosswire/issues)

All milestones: [github.com/jusso-dev/crosswire/milestones](https://github.com/jusso-dev/crosswire/milestones)

## Safety model

Crosswire is built for **human-led** security operations:

1. Agents may *propose* hunts and responses.
2. Destructive or tenant-changing actions require an explicit approval (and can expire unused).
3. Phase 5 hunting must not issue destructive Graph calls.
4. Phase 6 executors are feature-flagged and must support dry-run.
5. Every agent action and approval is auditable.
6. v1 is not considered shipped until Phase 8’s first-use / ship-gate checklist passes on the Azure deploy (dry-run ON by default).

Do not point this kit at a production tenant without reviewing the Entra app permissions and running dry-run first.

## Licence

[MIT](./LICENSE). Open-source kit first; a hosted commercial offering is a later conversation, not a v1 deliverable.

## Related

- [bradygaster/squad](https://github.com/bradygaster/squad) — persistent specialist agents
- [TanStack Start](https://tanstack.com/start/latest) and [TanStack AI chat recipe](https://tanstack.com/ai/latest/docs/ui/recipes/basic-chat)
- [Better Auth](https://www.better-auth.com/) and [SSO plugin](https://www.better-auth.com/docs/plugins/sso)
- [Microsoft Security Copilot / Sentinel hunting docs](https://learn.microsoft.com/en-us/azure/sentinel/) (customer tenant; you bring the app registration)
