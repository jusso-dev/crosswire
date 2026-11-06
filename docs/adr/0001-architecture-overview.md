# 0001. Architecture overview

- **Status:** Accepted
- **Date:** 2026-11-07

## Context

Crosswire is an open-source SOC kit for Microsoft customers who use GitHub Copilot agents. The
product lock (README, issue #1) fixes the stack and the safety model so that later work does not
re-litigate hosting or agent runtime.

## Decision

1. **Control plane vs agents.** A TanStack Start app (`apps/web`) is the control plane: dashboard,
   TanStack AI chat (`POST /api/chat`, SSE), hunt cases, watchlists and the approval inbox. Agents
   are defined once as charters in `.squad/` and run in two places: in-process in the control plane
   (via TanStack AI adapters, or a stub model) and as GitHub Copilot custom agents in `.github/agents/`.
   See ADR 0002.
2. **Default cast.** Lead, Hunter, Intel, Responder, Scribe. No other agents without a charter.
3. **Data.** PostgreSQL via Drizzle ORM. Everything tenant-related carries `org_id`; one workspace
   equals one org in v1. Public TI tables are global; hits are org-scoped.
4. **Auth.** Better Auth with `tanstackStartCookies`. Local email/password for development;
   Microsoft Entra ID OIDC for production SSO, mapped to orgs by `tid`. SAML is Later.
5. **Packaging.** Docker runs anywhere. Azure (Container Apps + PostgreSQL Flexible Server + Key
   Vault) is the first documented target (ADR 0003).
6. **Hunting.** Live Defender XDR Advanced Hunting and Sentinel (Log Analytics) queries through a
   read-only, allowlisted client. Agents propose KQL; a human reviews, edits and runs it.
7. **Response.** Gated SOAR: propose → human approve → execute. Executors are feature-flagged
   (default off) and support dry run. Agents have no execute tool.
8. **Threat intel.** pwn.watch feeds plus CISA KEV (cve.watch substitute) with polite, cached
   fetching and visible attribution.

### Explicit non-goals for v1

- Cloudflare Workers/Pages/D1/Queues as a host.
- Cloudflare Radar as a v1 TI source (shipped later as an optional, flag-off enrichment).
- SAML SSO (shipped later behind `SAML_ENABLED`, off by default).
- Ungated or autonomous production response.

## Consequences

- Contributors without a tenant or model key can run everything: stub model, demo-mode hunting,
  recorded TI fixtures.
- Background work runs in a plain Node worker (timers), not a queue service.
- The open decision on the Squad SDK is recorded in ADR 0002.
