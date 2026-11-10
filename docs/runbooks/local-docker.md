# Runbook: local Docker

## Development stack

```sh
cp .env.example .env
# set BETTER_AUTH_SECRET and APP_ENCRYPTION_KEY: openssl rand -hex 32
docker compose up --build
```

- `postgres` (loopback 5432, volume `pgdata`, healthcheck), `migrate` (one-shot; applies migrations
  then exits; no health check), `web` (http://localhost:3000; starts after `migrate` succeeds),
  `worker` (ingest, match, digest, expiry). The worker's health check calls its own health server
  (`WORKER_HEALTH_PORT`, default 3001): `docker ps` shows it healthy while its loop runs and
  unhealthy when the loop stops.
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

- No source bind mounts; the runtime image only. Set `CROSSWIRE_IMAGE` in `.env.prod` to a published
  image (`ghcr.io/jusso-dev/crosswire:sha-<40 hex>` or `:vX.Y.Z`), or leave it unset to build
  `crosswire:web` from the checkout.
- `POSTGRES_PASSWORD` is required (compose stops without it) and can contain any characters: the
  app receives it as `PGPASSWORD`, not inside the connection URL.
- Postgres is not published; the app binds to `127.0.0.1:3000`. The bundled Postgres has no TLS, so
  the example sets `DATABASE_TLS_INSECURE_OK=true` to silence the start-up warning. For an external
  database, set `DATABASE_URL` with `sslmode=verify-full` and set that flag to `false`.
- `restart: unless-stopped`; memory limits as hints; container logs rotate (10 MB, 5 files).
- **TLS:** terminate in a reverse proxy on the host. Caddy example:

```
crosswire.example.com {
  reverse_proxy 127.0.0.1:3000
}
```

Set `APP_URL=https://crosswire.example.com`. The proxy must pass `X-Forwarded-For` (Caddy and
Traefik do by default) for per-client sign-in rate limits. Set `TRUSTED_PROXIES` to the proxy's
address or range (IP addresses or CIDR ranges, for example `172.16.0.0/12`).

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
