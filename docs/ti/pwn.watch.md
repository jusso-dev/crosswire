# pwn.watch ingest (issues #36, #42)

[pwn.watch](https://pwn.watch) publishes machine-readable feeds. Crosswire stores a local copy so
matching and pages never hit the origin on page load. **Source: pwn.watch.** Please keep the
attribution in UI and docs.

## Feeds (checked 2026-11-07)

| URL | Shape | Table |
| --- | --- | --- |
| `https://pwn.watch/incidents.json` | `{ site, generatedAt, updatedAt, live, categories, incidents: Incident[] }` | `pwn_incidents` (key: `slug`) |
| `https://pwn.watch/changes.json` | `{ site, generatedAt, category, feeds, changes: Change[] }` | `pwn_changes` (key: sha256 of incident+date+title) |
| `https://pwn.watch/tags.json` | `{ site, generatedAt, tags: Tag[] }` | `pwn_tags` (key: `id`) |

Incident fields used: `slug, title, url, summary, category, severity, status, patchStatus,
product, tags[], stacks[], cveIds[], startedAt, updatedAt`. Change fields: `incident,
incidentTitle, category, severity, status, date, title, body, url, sourceUrl`. Tag fields: `id,
label, group, groupLabel, incidents, url`. Recorded fixtures: `apps/web/test/fixtures/pwnwatch/`.

Parsers (`apps/web/src/server/ti/pwnwatch.ts`) ignore unknown fields and skip malformed items, so
upstream drift degrades gracefully. Every row stores `source = 'pwn.watch'`, the feed URL and
`retrieved_at`.

## Running

```sh
pnpm ingest:pwn                                            # live, polite, cached
pnpm ingest:pwn --fixtures test/fixtures/pwnwatch # offline
```

The worker (`pnpm worker`, Compose `worker` service) runs ingest + match hourly. No Cloudflare
Queues; plain Node timers.

## Politeness (issue #42)

- **User-Agent:** `Crosswire/0.1 (+https://github.com/jusso-dev/crosswire)`.
- **Cache:** raw payloads in `ti_fetch_cache`. A live fetch is skipped while the cached copy is
  younger than `TI_CACHE_TTL_SECONDS` (default and minimum 3600).
- **Revalidation:** `If-None-Match` / `If-Modified-Since`; `304` reuses the cache.
- **Throttling:** at most 2 retries on `429`/`503`, honouring `Retry-After` (capped at 60 s). No
  tight loops.
- **Timeouts:** `TI_HTTP_TIMEOUT_MS` (30 s).
- **Size cap:** responses over `TI_MAX_RESPONSE_BYTES` (default 25 MB) are refused, by
  `Content-Length` and by counting the streamed body; nothing is cached.
- **Redirects:** followed only to `https` on the same host as the configured URL, at most 3 hops.
  A redirect to another host (including internal addresses), to plain `http` or without a
  `Location` fails the fetch, so a moved or compromised feed cannot send the worker elsewhere.
- `robots.txt` allows all paths (checked 2026-11-07). We use JSON feeds only, never HTML scraping.
