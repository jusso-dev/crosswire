# cve.watch investigation (issue #37)

**Decision: substitute.** cve.watch is not integrated. CISA KEV is the CVE backbone in v1; the
schema is ready to add cve.watch (or NVD) later without changes.

## Evidence (2026-11-07, from Australia)

| Check | Result |
| --- | --- |
| `curl -m 15 https://cve.watch` | Connection timed out (no TCP connect) |
| `curl https://www.cve.watch` | HTTP 200, but the page is a Namecheap parking page ("has been recently registered with namecheap.com") |
| Official feed/API | None found |

Earlier reports in the product lock noted TLS/DNS failures. The apex is unreachable and `www` is a
parked domain, so there is no stable feed to integrate.

## Substitute

- **CISA Known Exploited Vulnerabilities** (`CISA_KEV_URL`, JSON) ingested by
  `pnpm ingest:cve` into the generic `cve_records` table with `source = 'cisa-kev'`. Fixture:
  `apps/web/test/fixtures/kev.json` (used in CI).
- **NVD** is a planned second source (`source = 'nvd'`) using the NVD 2.0 API with an API key and
  aggressive caching (NVD rate limits are strict). Not required for v1.

## Re-enabling cve.watch later

`cve_records.source` already allows `'cve.watch'` and `CVE_WATCH_ENABLED` exists (default
`false`). If a stable JSON feed appears, add an ingester like `ti/kev.ts` behind that flag.
