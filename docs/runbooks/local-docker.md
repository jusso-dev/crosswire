# Runbook: local Docker

## Development stack

```sh
cp .env.example .env
# set BETTER_AUTH_SECRET and APP_ENCRYPTION_KEY: openssl rand -hex 32
docker compose up --build
```

- `postgres` (loopback 5432, volume `pgdata`, healthcheck), `migrate` (one-shot; applies migrations
  then exits), `web` (http://localhost:3000; starts after `migrate` succeeds), `worker` (ingest,
  match, digest, expiry).
- Redis is optional and unused by v1: `docker compose --profile redis up`.
- `docker compose down` keeps data; `docker compose down -v` deletes the Postgres volume.
- Linux is the happy path; Docker Desktop/OrbStack work on macOS and Windows.

The default Postgres password is for local use only and Postgres binds to `127.0.0.1`. Change
`POSTGRES_PASSWORD` before exposing the host to any network.

## Production-like stack (any Docker host)

```sh
cp infra/compose.prod.env.example .env.prod   # fill in real values
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build
```

- No source bind mounts; the runtime image only (`docker build -t crosswire:web .`).
- Postgres is not published; the app binds to `127.0.0.1:3000`.
- `restart: unless-stopped`; memory limits as hints.
- **TLS:** terminate in a reverse proxy on the host. Caddy example:

```
crosswire.example.com {
  reverse_proxy 127.0.0.1:3000
}
```

Set `APP_URL=https://crosswire.example.com`. The proxy must pass `X-Forwarded-For` (Caddy and
Traefik do by default) for per-client sign-in rate limits.

## Verification checklist

1. `curl -fsS localhost:3000/healthz` → `{"status":"ok"}`; `/readyz` → `ready`.
2. Open `/sign-in`, create an account, land on the dashboard with four empty states.
3. Chat: new thread, pick Intel, send a message, see a streamed (stub) reply. Refresh: it persists.
4. Threat intel: the worker fetches pwn.watch and CISA KEV on start (then hourly). Check
   `docker compose logs worker` for `ingest:pwn ok`, then add a watch (for example tag `cisa-kev`)
   and wait for the next match run, or run `docker compose restart worker`. Offline? From a
   checkout, with `DATABASE_URL` pointing at the stack:
   `pnpm ingest:pwn --fixtures test/fixtures/pwnwatch && pnpm match:watches`.
5. Approvals: create a proposal; confirm execute is disabled while `RESPONSE_EXECUTOR_*=off`.

Times are stored in UTC and shown in the browser's local time zone.
