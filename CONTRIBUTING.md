# Contributing to Crosswire

Thanks for helping. Crosswire is a security tool, so small, tested, reviewed changes win.

## Setup

Requirements: Node 24 (see `.nvmrc`), pnpm 10 (`corepack enable`), Docker (for Postgres).

```sh
git clone https://github.com/jusso-dev/crosswire && cd crosswire
corepack enable && pnpm install
cp .env.example .env          # set BETTER_AUTH_SECRET and APP_ENCRYPTION_KEY (openssl rand -hex 32)
docker compose up -d postgres
pnpm db:migrate
pnpm dev                      # http://localhost:3000, create an account on the sign-in page
```

No Entra tenant, model API key or Microsoft licence is needed: chat uses a labelled stub model,
hunting runs in demo mode with fixture data, and TI can be loaded from recorded fixtures:

```sh
pnpm ingest:pwn --fixtures test/fixtures/pwnwatch
pnpm ingest:cve --fixtures test/fixtures/kev.json
pnpm match:watches
```

## The same checks CI runs

```sh
pnpm build        # also generates the route tree used by typecheck
pnpm lint
pnpm typecheck
pnpm test         # Vitest + PGlite (in-process Postgres); no Docker needed
```

CI (`.github/workflows/ci.yml`) runs these on every PR plus a Docker image build and a migration
drift check. There are no end-to-end browser tests in CI.

## Database changes

Edit `apps/web/src/server/db/schema/`, then `pnpm db:generate` and commit the new file under
`apps/web/drizzle/`. CI fails if the schema and migrations disagree.

## Pull requests

- Fork, branch, PR to `main`. Link the issue (`Closes #NN`).
- Keep PRs focused. Add or update tests for behaviour changes.
- Issues are organised by milestone (Phase 0–7, Later) and labels (`area:*`, `phase-*`).
- By contributing you agree your work is licensed under the MIT licence.

## Changing the agent cast

Charters live in `.squad/agents/<agent>/charter.md`. GitHub Copilot custom agents in
`.github/agents/<agent>.agent.md` mirror them. **When you change a charter, update the matching
`.agent.md`** (same safety rules, same tool list). Every charter must keep the line "Never execute
containment without an approved proposal"; a test enforces it.

## Safety rules for code

- Agents never get an execute tool. KQL and response execution happen only from human actions.
- Hunting HTTP calls go through `HuntingClient` and its allowlist. Response calls go through
  executors. Do not add generic `fetch(url)` helpers to either.
- Never log or store secrets. Use `redactValue` / the logger, which redact automatically.

## Security issues

Do not open public issues for vulnerabilities. See [SECURITY.md](SECURITY.md).
