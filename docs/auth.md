# Authentication

Better Auth 1.7 on TanStack Start (issue #17), using the official `tanstackStartCookies()` plugin
(`better-auth/tanstack-start`). Docs followed: [better-auth.com](https://www.better-auth.com/docs),
version 1.7.18.

- Handlers: `/api/auth/*` (`apps/web/src/routes/api.auth.$.ts`).
- Server config: `apps/web/src/server/auth/auth.ts`. Browser client: `apps/web/src/lib/auth-client.ts`.
- Tables: `user`, `session`, `account`, `verification` in `apps/web/src/server/db/schema/auth.ts`,
  migrations in `apps/web/drizzle/` (`pnpm db:migrate`).
- Cookies: httpOnly, `SameSite=Lax`; `Secure` and `__Secure-` prefix when `NODE_ENV=production`.
- CSRF: Better Auth origin checks on its endpoints; TanStack server functions are same-origin POSTs.
- Rate limiting: Better Auth limiter, 5 sign-in attempts per minute per IP (30 requests per minute
  for other `/api/auth/*` endpoints). Counters live in the `rate_limit` table, so every replica
  shares them (`RATE_LIMIT_STORAGE=database`, the default; `memory` makes them per process). Client
  IP comes from `X-Forwarded-For`; set `TRUSTED_PROXIES` (comma-separated IPs/CIDRs of your proxy)
  so multi-hop headers resolve correctly. Audit rows record the right-most hop (the one your proxy
  appended).
- Sessions: database sessions with an idle timeout and an absolute cap (see
  [Session lifetime](#session-lifetime)). No hand-rolled JWT store.

## Local sign-in (issue #18)

Email and password (`AUTH_EMAIL_PASSWORD=true`, minimum 12 characters, Better Auth's scrypt
hashing). Open `/sign-in`, choose "Create an account". The first account gets a personal
workspace where it is the owner. Errors are generic ("Invalid email or password") to avoid account
enumeration. Magic links are not enabled; SMTP settings are used only for digests and the digest
address confirmation email ([watchlists](watchlists.md#digest-email-address-102)).

Demo users: `SEED_PASSWORD=... pnpm --filter web db:seed` creates `owner@example.test` and
`analyst@example.test` in one org (development only).

## Entra ID OIDC (issue #19)

Better Auth's built-in `microsoft` provider (Entra ID OIDC, scopes `openid profile email` only;
no Graph Security scopes here, those belong to the hunting app in docs/hunting.md).

### App registration

1. Entra admin centre → App registrations → New registration. Name: `Crosswire SSO`.
2. Supported account types: **Single tenant** (recommended). Multi-tenant only if one Crosswire
   serves several tenants.
3. Redirect URI (Web): `${APP_URL}/api/auth/callback/microsoft`.
4. Certificates & secrets → New client secret. Copy the value once.
5. Token configuration → add optional claim `email` to the ID token.
6. API permissions: Microsoft Graph delegated `openid`, `profile`, `email` (default). Grant consent.

### Environment

```
ENTRA_CLIENT_ID=<application (client) id>
ENTRA_CLIENT_SECRET=<secret value>
ENTRA_TENANT_ID=<directory (tenant) id>     # or "organizations" for multi-tenant
```

`ENTRA_TENANT_ID=common` also allows personal Microsoft accounts and surprises enterprises; use
your tenant GUID.

### Org mapping rule

The ID token's `tid` (tenant id) is matched to `orgs.entra_tenant_id`.

- **Known tenant:** the user joins that org as `analyst` (owners grant `approver`/`owner`).
- **Unknown tenant (default):** rejected before any user row is created; the user sees
  `/auth-error?error=unknown_tenant` and an `sso_rejected_unknown_tenant` audit row is written.
- `ENTRA_AUTO_PROVISION_ORGS=true`: an unknown tenant gets a new org named `ENTRA_ORG_NAME`; the
  first user becomes its owner. Use this for single-customer installs.

Link an existing org to a tenant (SQL, one-off):

```sql
update orgs set entra_tenant_id = '<tenant guid>' where id = '<org id>';
```

## Session guards (issue #20)

- Pages under `/app` redirect to `/sign-in?returnTo=...` on the server (`beforeLoad`).
- Every server function uses the `authed` middleware; `/api/*` returns `401` JSON.
- `/healthz`, `/readyz`, `/sign-in`, `/auth-error` and `/api/auth/*` are public.
- `returnTo` only accepts same-origin paths (no open redirects).

## Session lifetime

Two limits, both from the environment:

| Setting | Default | Rule |
| --- | --- | --- |
| `SESSION_IDLE_MINUTES` | `60` | The session ends after this long with no requests. Activity slides the expiry forward (Better Auth refreshes it at most every 5 minutes). |
| `SESSION_MAX_AGE_HOURS` | `12` | Hard cap since sign-in. Activity never extends it. |

- The absolute cap is checked in `getAppSession` (every `/app` page, server function and `/api/*`
  call) and in front of every `/api/auth/*` request, so Better Auth cannot serve or refresh an
  over-age session on its own endpoints.
- An over-age session is deleted and audited as `session_expired_absolute` (actor `system`; the
  data holds the cap in hours and the sign-in time). The browser's cookie is cleared on its next
  request and the user signs in again.
- Changes take effect after a restart. A lower `SESSION_MAX_AGE_HOURS` ends sessions already past
  the new cap on their next request.

**MFA stays with the identity provider.** Crosswire does not prompt for MFA. Require it with Entra
Conditional Access on the SSO app. Signing in again after a session ends may be silent while the
Microsoft session is still valid; Conditional Access sign-in frequency controls that.

## HTTP security headers (#74)

Every response gets security headers from `apps/web/src/server/lib/http-security.ts`. They are fixed
in code, not configured.

- **Content-Security-Policy (production):** `script-src 'self'` plus a fresh per-request nonce on
  HTML pages (`'nonce-…'`), so only the scripts the server rendered can run. No `'unsafe-inline'`
  and no `'unsafe-eval'` for scripts. Non-HTML responses get `script-src 'self'`.
- `style-src 'self' 'unsafe-inline'` (React `style` attributes cannot carry a nonce),
  `font-src 'self' data:` (small fonts inlined into the CSS), `img-src 'self' data:`,
  `connect-src 'self'`, `object-src 'none'`, `base-uri 'self'`, `frame-ancestors 'none'`,
  `form-action 'self'`.
- Development keeps `'unsafe-inline'` for scripts, because Vite injects inline scripts without a
  nonce.
- Also sent: `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`,
  `X-Frame-Options: DENY`, `Permissions-Policy`, `Cross-Origin-Opener-Policy: same-origin`, and
  HSTS over https.
- `/api/chat` is rate limited per client (`RATE_LIMIT_CHAT_PER_MIN`, default 20) in the
  `app_rate_limits` table, shared by every replica. If the database errors, the limiter lets the
  request through and logs a warning (chat still needs a session and the database). Sign-in limits
  are Better Auth's own and are not affected.

## Auth audit log (issue #22)

Table `audit_events` (`category = 'auth'`): `sign_up`, `sign_in`, `sign_out`, `sso_success`,
`sso_failure`, `sso_linked`, `sso_rejected_unknown_tenant`, `session_revoke*`,
`session_expired_absolute`, `role_changed`, and `digest_email_requested` / `digest_email_confirmed`
/ `digest_email_cleared` (these record the address's domain only).
Each row has result, user id when known, org id, IP address, user agent and timestamp. Passwords,
tokens, authorisation codes and submitted emails are never stored.

Owners can view it under **Settings → Audit log**, or query:

```sql
select created_at, action, result, actor_id, ip_address from audit_events
where category = 'auth' order by created_at desc limit 100;
```

**Retention and PII:** the worker deletes audit rows older than `RETENTION_AUDIT_DAYS` (default 730;
`0` keeps them forever) once a day. IP addresses and user agents are personal data in some
jurisdictions; set the period to suit your obligations. See
[data retention](runbooks/data-retention.md).

## SAML SSO (Later)

Optional, off by default (`SAML_ENABLED=false`). Uses Better Auth's SSO plugin
(`@better-auth/sso` 1.7.18). Entra OIDC above is unaffected.

1. Set `SAML_ENABLED=true` and restart.
2. An org **owner** registers the IdP via the Better Auth endpoint `POST /api/auth/sso/register`
   (only owners may register; others get "registration is disabled"). Example body:
   `{ "providerId": "okta-acme", "issuer": "https://idp.example", "domain": "acme.example",
   "samlConfig": { "entryPoint": "https://idp.example/sso", "cert": "-----BEGIN CERTIFICATE-----…",
   "callbackUrl": "${APP_URL}/app", "idpMetadata": { "metadata": "<IdP metadata XML>" },
   "spMetadata": {} } }`.
3. Give the IdP Crosswire's SP metadata: `GET /api/auth/sso/saml2/sp/metadata?providerId=okta-acme`.
   The ACS URL is `${APP_URL}/api/auth/sso/saml2/sp/acs/okta-acme`.
4. Bind the provider to your org (server function `bindSamlProviderFn`, owner only; it must be a
   provider you registered).

**Org mapping rule:** each SAML provider is bound to exactly one org (`sso_org_bindings`). Users who
sign in through a bound provider join that org as `analyst`. An unbound provider grants no org
access (the user cannot open `/app`) and writes a `saml_unbound_provider` audit row. SAML sign-ins
write `saml_success` / `saml_failure` audit rows.
