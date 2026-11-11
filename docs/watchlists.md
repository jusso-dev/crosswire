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

`pnpm digest:daily [YYYY-MM-DD]`, or the worker once per local day (00:05 in `APP_TIMEZONE`, default
`Australia/Sydney`, for the previous day). One `digests` row per org per local day (DST-safe); quiet days produce a "no hits" digest. **Digests**
page shows them. Email goes to that org's owners only when `SMTP_HOST` is set; `emailed_at`
prevents double sends. Each owner gets it at their confirmed digest address if they set one (below),
otherwise at their sign-in email. Dates are stored in UTC; the UI shows local time.

### Digest email address (#102)

An Entra sign-in name (UPN) often has no mailbox, so owners can send their digest to another
address. **Settings → Digest email** (owners only, since only owners receive digest email):

1. Enter the address and click **Send confirmation link**. Crosswire emails the link to that
   address.
2. Open the link while signed in to Crosswire as yourself, then click **Confirm address**. Opening
   the link alone changes nothing, so a mail scanner that fetches links cannot confirm it.
3. Digests now go to the confirmed address. **Remove** clears it (and any pending request), and
   digests go to the sign-in email again.

- Needs SMTP. Without `SMTP_HOST` the section says email is not set up and no address can be
  confirmed; nothing is saved.
- The link expires after 24 hours and works once. A new link can be sent after one minute; it
  replaces the old one. A link opened by a different signed-in user is not valid.
- The address applies to that owner in that org only. Only a hash of the link token is stored.
  Audit events (`digest_email_requested`, `digest_email_confirmed`, `digest_email_cleared`) record
  the address's domain, never the full address.
- When a Microsoft sign-in has no verified email, the section warns that the sign-in email may have
  no mailbox.

## TI compare

`/app/intel/<CVE>` shows one card per source (pwn.watch, CISA KEV, and NVD / cve.watch when
added), with a deterministic "agree / differ" summary (dates, severity labels, exploitation).
Missing sources show as absent. Non-CVE keys do a text search on pwn.watch.

All TI fetches (pwn.watch, CISA KEV, Radar) refuse responses larger than `TI_MAX_RESPONSE_BYTES`
(default 25 MB); a refused response is not cached. They follow redirects only to `https` on the
same host (#211). Fetch rules: [pwn.watch](ti/pwn.watch.md#politeness-issue-42).

### Cloudflare Radar (optional, Later #64)

Off by default. With `RADAR_ENABLED=true` and a `CLOUDFLARE_API_TOKEN` (custom token with Radar
read access), IP and domain keys get a Radar card: `GET /radar/entities/ip` (ASN, network owner,
location) and `GET /radar/ranking/domain/{domain}` (rank or bucket, categories). Radar has no CVE
data, so CVE keys never call it. Responses use the same polite TTL cache (`ti_fetch_cache`, the token
is never cached). Failures show an absent card. The card credits Cloudflare Radar; check Radar's
terms before redistributing its data. Radar is a feed only: no Cloudflare hosting is involved.
