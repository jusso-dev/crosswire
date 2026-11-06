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
- Rate limiting: Better Auth limiter, 5 sign-in attempts per minute per IP. Client IP comes from
  `X-Forwarded-For`; set `TRUSTED_PROXIES` (comma-separated IPs/CIDRs of your proxy) so multi-hop
  headers resolve correctly. Audit rows record the right-most hop (the one your proxy appended).
- Sessions: database sessions (7 days). No hand-rolled JWT store.

## Local sign-in (issue #18)

Email and password (`AUTH_EMAIL_PASSWORD=true`, minimum 12 characters, Better Auth's scrypt
hashing). Open `/sign-in`, choose "Create an account". The first account gets a personal
workspace where it is the owner. Errors are generic ("Invalid email or password") to avoid account
enumeration. Magic links are not enabled; SMTP settings are used only for digests.

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

## Auth audit log (issue #22)

Table `audit_events` (`category = 'auth'`): `sign_up`, `sign_in`, `sign_out`, `sso_success`,
`sso_failure`, `sso_linked`, `sso_rejected_unknown_tenant`, `session_revoke*`, `role_changed`.
Each row has result, user id when known, org id, IP address, user agent and timestamp. Passwords,
tokens, authorisation codes and submitted emails are never stored.

Owners can view it under **Settings → Audit log**, or query:

```sql
select created_at, action, result, actor_id, ip_address from audit_events
where category = 'auth' order by created_at desc limit 100;
```

**Retention and PII:** rows are kept indefinitely in v1; self-hosters own retention. IP addresses
and user agents are personal data in some jurisdictions; delete old rows on your schedule:
`delete from audit_events where created_at < now() - interval '365 days';`

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
