# Watchlists, matcher, digests and compare (issues #38–#41)

## Watch entries

**Watches** page: add keyword, CVE, vendor or tag entries for your org.

| Type | Validation | Matching |
| --- | --- | --- |
| CVE | `CVE-YYYY-NNNN+` (normalised to upper case) | Exact match on the record's CVE list |
| Tag | Lower-cased, spaces → `-` (pwn.watch tag ids, e.g. `cisa-kev`) | Exact match on tags |
| Vendor | 3+ characters | Case-insensitive whole word on vendor/product, then title |
| Keyword | 3+ characters | Case-insensitive whole token in title + summary |

Keywords are plain token matches, not ML; expect some noise. Any org member can add or remove
entries in v1 (removal is a soft disable). Entries are org-scoped and isolation is tested.

## Matcher

`pnpm match:watches` (and the worker after each ingest) compares every enabled entry with
pwn.watch incidents and CISA KEV records and writes `watch_hits`. A unique index on
`(org, entry, source, source_id)` makes re-runs idempotent. It logs counts only, never content.

## Daily digest

`pnpm digest:daily [YYYY-MM-DD]`, or the worker once per UTC day (00:05 UTC, for the previous
day). One `digests` row per org per UTC day; quiet days produce a "no hits" digest. **Digests**
page shows them. Email goes to that org's owners only when `SMTP_HOST` is set; `emailed_at`
prevents double sends. Dates are stored in UTC; the UI shows local time.

## TI compare

`/app/intel/<CVE>` shows one card per source (pwn.watch, CISA KEV, and NVD / cve.watch when
added), with a deterministic "agree / differ" summary (dates, severity labels, exploitation).
Missing sources show as absent. Non-CVE keys do a text search on pwn.watch.

### Cloudflare Radar (optional, Later #64)

Off by default. With `RADAR_ENABLED=true` and a `CLOUDFLARE_API_TOKEN` (custom token with Radar
read access), IP and domain keys get a Radar card: `GET /radar/entities/ip` (ASN, network owner,
location) and `GET /radar/ranking/domain/{domain}` (rank or bucket, categories). Radar has no CVE
data, so CVE keys never call it. Responses use the same polite TTL cache (`ti_fetch_cache`, the token
is never cached). Failures show an absent card. The card credits Cloudflare Radar; check Radar's
terms before redistributing its data. Radar is a feed only: no Cloudflare hosting is involved.
