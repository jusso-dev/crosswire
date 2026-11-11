# Authentication

Better Auth 1.7 on TanStack Start (issue #17), using the official `tanstackStartCookies()` plugin
(`better-auth/tanstack-start`). Docs followed: [better-auth.com](https://www.better-auth.com/docs),
version 1.7.18.

- Handlers: `/api/auth/*` (`apps/web/src/routes/api.auth.$.ts`).
- Server config: `apps/web/src/server/auth/auth.ts`. Browser client: `apps/web/src/lib/auth-client.ts`.
- Tables: `user`, `session`, `account`, `verification` in `apps/web/src/server/db/schema/auth.ts`,
  migrations in `apps/web/drizzle/` (`pnpm db:migrate`).
- Cookies: httpOnly, `SameSite=Lax`; `Secure` and `__Secure-` prefix when `NODE_ENV=production`.
- CSRF (#199): Better Auth checks the origin on its own endpoints. Server functions
  (`/_serverFn/*`) pass TanStack Start's CSRF middleware (`src/start.ts`): the browser must say the
  call is same-origin (`Sec-Fetch-Site`), or, when it sends no such header, `Origin` (then
  `Referer`) must be the app's own origin, `APP_URL` or a `CORS_ALLOWED_ORIGINS` entry. A request
  with none of these headers is refused with 403. Cookies are `SameSite=Lax`, so this check is what
  stops other sites on the same registrable domain. On the default `azurecontainerapps.io` host,
  other customers' apps count as the same site, which is one more reason to use a
  [custom domain](runbooks/custom-domain.md).
- Rate limiting: Better Auth limiter, 5 sign-in attempts per minute per client (30 requests per
  minute for other `/api/auth/*` endpoints). Counters live in the `rate_limit` table, so every
  replica shares them (`RATE_LIMIT_STORAGE=database`, the default; `memory` makes them per process).
- Client IP (#196): taken from `X-Forwarded-For`, reading from the right and skipping
  `TRUSTED_PROXIES` hops (comma-separated IPv4 or IPv6 addresses or CIDR ranges of your proxies,
  for example `10.0.0.0/8, fd00::/8`). Without `TRUSTED_PROXIES` the right-most hop is used, the
  one your nearest proxy appended. `X-Real-IP` is never read, because a client can send it. The
  sign-in limiter, the chat limiter and auth audit rows all use this one rule. Container Apps
  ingress appends the client address, so leave `TRUSTED_PROXIES` empty there; behind another proxy
  in front of the ingress (Front Door, Application Gateway), list that proxy's ranges. An entry that
  is not an address or range stops the server at start-up.
- Sessions: database sessions with an idle timeout and an absolute cap (see
  [Session lifetime](#session-lifetime)). No hand-rolled JWT store.

## Local sign-in (issue #18)

Email and password (`AUTH_EMAIL_PASSWORD=true`, minimum 12 characters, Better Auth's scrypt
hashing). Open `/sign-in`, choose "Create an account". Each new account gets a personal
workspace where it is the owner. Local sign-up does not verify the address, so it never claims a
bootstrapped org (#188), and it is refused for a domain an Entra org owns (#203). Errors are generic ("Invalid email or password") to avoid account
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
7. Enterprise applications → `Crosswire SSO` → Properties → **Assignment required?** = **Yes**,
   then Users and groups → assign the people or groups who may use Crosswire. Without this, every
   account in the tenant (staff, guests and service accounts) can sign in as an analyst (#195).
   With it, Entra refuses everyone else before Crosswire sees them. Recommended for every install.
8. Optional, to set roles from Entra: add a groups claim or app roles, see
   [Roles from Entra groups and app roles](#roles-from-entra-groups-and-app-roles).

### Environment

```
ENTRA_CLIENT_ID=<application (client) id>
ENTRA_CLIENT_SECRET=<secret value>
ENTRA_TENANT_ID=<directory (tenant) id>     # or "organizations" for multi-tenant
```

`ENTRA_TENANT_ID=common` also allows personal Microsoft accounts and surprises enterprises; use
your tenant GUID. In production the server logs a start-up warning when `ENTRA_TENANT_ID` is
`organizations` or `common` (the default is `organizations`). Only mapped tenants get in either way,
but a single-tenant install should name its tenant.

Only the redirect flow is enabled. `POST /api/auth/sign-in/social` with a bare ID token is refused
(`disableIdTokenSignIn`, #188).

### Org mapping rule

The ID token's `tid` (tenant id) is matched to `orgs.entra_tenant_id`. This runs on **every**
Entra sign-in, not only the first (#187), so a lost placement repairs itself next time.

- **Known tenant:** the user joins that org. Their role comes from the org's group and app-role
  mappings (next section). With no mappings they join as `analyst` and owners grant roles.
- **Unknown tenant (default):** rejected before any user row is created; the user sees
  `/auth-error?error=UNKNOWN_TENANT` and an `sso_rejected_unknown_tenant` audit row is written.
- `ENTRA_AUTO_PROVISION_ORGS=true`: an unknown tenant gets a new org named `ENTRA_ORG_NAME` at the
  first sign-in, and that person becomes its owner, in one transaction (`entra_org_provisioned`
  audit row). If two people sign in first at the same moment, one org is created; the other person
  joins it as analyst. Nothing is created for a sign-in that is refused. Use this for
  single-customer installs.
- **Removed member:** a person an owner removed is refused (`MEMBER_REMOVED`) until their removal
  row is deleted (see [Removing people](#removing-people)).

### Roles from Entra groups and app roles

Owners map Entra groups or app roles to Crosswire roles in **Settings → Entra groups**. Mappings
belong to one org; the org is still chosen by the token's `tid`, so a mapping in one org never
affects another.

| Type | What to enter | Matched against |
| --- | --- | --- |
| Entra group | The group's **Object ID** (a GUID) | The ID token's `groups` claim |
| App role | The app role's **Value**, for example `Crosswire.Approver` | The ID token's `roles` claim |

**The rule, applied at each Entra sign-in:**

1. The person gets the **highest** role any of their groups or app roles maps to (owner, then
   approver, then analyst). This can lower their role too, for example when they leave a group.
   The role is marked as managed by Entra (`org_memberships.role_source = 'entra'`).
2. **No match:**
   - If **Only people in a mapped group can sign in** is on, the sign-in is refused with a plain
     message (`NOT_IN_MAPPED_GROUP`). This applies to existing members too.
   - Otherwise someone new joins as **analyst**. An existing member whose role was **set by hand**
     keeps it. An existing member whose role **came from Entra** drops to **analyst**.
3. The **last owner** is never removed by a sync. The change is skipped, the person still signs
   in, and an `entra_role_synced_blocked_last_owner` audit row is written (with a log warning).
4. Every change writes an `entra_role_synced` audit row with `from`, `to` and the matched
   mappings. A lowered role runs the same follow-up as a manual change (`onRoleLowered` in
   `server/orgs.ts`): repeat searches the person approved are paused once they can no longer
   approve.
5. An owner can still change an Entra-managed member's role by hand. Settings shows "Managed by
   Entra group", because the next sign-in replaces the manual change.

Turning on "Only people in a mapped group can sign in" is refused when your own last Microsoft
sign-in would not match a mapping, and the last mapping cannot be removed while it is on. This
keeps an owner from locking everyone out. Adding, removing and the setting itself are owner-only
and audited (`entra_mapping_added`, `entra_mapping_removed`,
`entra_require_mapped_group_changed`).

**Group overage.** When a user is in more groups than fit in a token (about 200), Entra leaves the
`groups` claim out and sends `_claim_names.groups` (or `hasgroups`) instead. Crosswire does not call
Microsoft Graph to look them up. It fails closed: **no role is raised from groups** for that
sign-in. App-role matches still apply. To avoid overage, emit only **Groups assigned to the
application** (step 3 below) or use app roles.

#### Set up the groups claim

1. Entra admin centre → App registrations → `Crosswire SSO` → **Token configuration** →
   **Add groups claim**.
2. Choose **Security groups**, or better, **Groups assigned to the application** (only the groups
   assigned to the enterprise app are sent, which avoids overage). With "Groups assigned to the
   application", assign the groups under Enterprise applications → `Crosswire SSO` → Users and
   groups.
3. Under **ID**, choose **Group ID**. Crosswire matches Object IDs, not names.
4. Save. In Crosswire, Settings → Entra groups → add each group's Object ID with a role.

#### Or use app roles

1. App registrations → `Crosswire SSO` → **App roles** → **Create app role**. Allowed member types:
   Users/Groups. Value, for example `Crosswire.Analyst`, `Crosswire.Approver`, `Crosswire.Owner`.
2. Enterprise applications → `Crosswire SSO` → Users and groups → **Add user/group**, pick the
   people or groups, then the role.
3. The ID token's `roles` claim then carries the values. In Crosswire, add each Value with a role.

App roles never overflow and work well with "Assignment required". They are the simplest choice
for most installs.

### Removing people

Owners remove a member in **Settings → People and roles** (`removeMemberFn`). The member loses
access at once and a `member_removed` audit row is written. Owners cannot remove themselves, and
the last owner cannot be removed. Repeat searches they approved are paused. Because SSO places people on every sign-in, a removal row
(`org_member_removals`) keeps the person out of that org on later Entra and SAML sign-ins. To let
them back in:

```sql
delete from org_member_removals where org_id = '<org id>' and user_id = '<user id>';
```

Also remove them from the Entra app assignment, so Entra refuses them first.

### Role changes

All role changes (Settings, Entra sync) go through one function, `changeMemberRole` (#202). It
locks the org's owner rows, re-checks that the person acting is still an owner, and refuses any
change that would leave no owner. Two owners demoting each other at the same moment leave one
owner. `role_changed` audit rows record `from` and `to`; a non-member id is refused and not
audited.

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
`sso_failure`, `sso_linked`, `sso_rejected_unknown_tenant`, `sso_refused`,
`entra_org_provisioned`, `entra_role_synced`, `entra_role_synced_blocked_last_owner`,
`entra_mapping_added`, `entra_mapping_removed`, `entra_require_mapped_group_changed`,
`member_removed`, `bootstrap_owner_claimed`, `bootstrap_owner_claim_refused`, `session_revoke*`,
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
2. An **owner of a team org** registers the IdP via the Better Auth endpoint
   `POST /api/auth/sso/register` (#203). Owning only a personal workspace, which every local
   sign-up does, is not enough; others get "registration is disabled". Example body:
   `{ "providerId": "okta-acme", "issuer": "https://idp.example", "domain": "acme.example",
   "samlConfig": { "entryPoint": "https://idp.example/sso", "cert": "-----BEGIN CERTIFICATE-----…",
   "callbackUrl": "${APP_URL}/app", "idpMetadata": { "metadata": "<IdP metadata XML>" },
   "spMetadata": {} } }`.
3. Give the IdP Crosswire's SP metadata: `GET /api/auth/sso/saml2/sp/metadata?providerId=okta-acme`.
   The ACS URL is `${APP_URL}/api/auth/sso/saml2/sp/acs/okta-acme`.
4. **Verify the domain** (#203). Domain verification is on: a provider signs nobody in until its
   domain is proven. The register response includes a `domainVerificationToken`. Publish it as a
   DNS TXT record at `_better-auth-token-<providerId>.<domain>`, then call
   `POST /api/auth/sso/verify-domain` with `{ "providerId": "okta-acme" }`. Request a new token with
   `POST /api/auth/sso/request-domain-verification`. Register one domain per provider (a
   comma-separated list is refused), and each domain can belong to one provider only (compared
   without case).
5. Bind the provider to your team org (server function `bindSamlProviderFn`, owner only; it must
   be a provider you registered, and the org cannot be a personal workspace).

**Domains owned by an Entra tenant.** When an org is bound to an Entra tenant and has
`orgs.email_domain` set (bootstrap with a tenant id sets it from the admin's address), a local
sign-up or a SAML provider cannot create an account for an address in that domain. Those people
sign in with Microsoft. This stops someone creating `name@contoso.com` first and locking the real
person out. Set it for an existing org with:

```sql
update orgs set email_domain = 'contoso.com' where id = '<org id>';
```

**Stored provider secrets are not encrypted by Crosswire (#212).** The plugin stores the provider
config as JSON text in `sso_provider` (`saml_config`, `oidc_config`), including `samlConfig.privateKey`
(the SP signing key, when set) and `oidcConfig.clientSecret`. Crosswire does not wrap these with
`APP_ENCRYPTION_KEY`, because the plugin reads and writes the table directly and has no supported hook
to do it without patching the package. `pnpm rotate-secrets` does not cover them. Until that changes:

- Prefer SAML without an SP private key (leave `authnRequestsSigned` off unless the IdP needs it),
  and do not register OIDC providers through this plugin. Entra OIDC above uses
  `ENTRA_CLIENT_SECRET` from Key Vault, not this table.
- Treat database backups and read access to `sso_provider` as access to those secrets.
- If an OIDC client secret may have leaked, rotate it at the IdP and register the provider again
  with the new secret.
- If the SP signing key (`samlConfig.privateKey`) may have leaked, generate a new SP key pair,
  register the provider again with the new private key, and give the IdP the new SP certificate.
  Rotating keys at the IdP alone does not replace the SP key.

**Org mapping rule:** each SAML provider is bound to exactly one org (`sso_org_bindings`). Users who
sign in through a bound provider join that org as `analyst` (unless an owner removed them). An unbound provider grants no org
access (the user cannot open `/app`) and writes a `saml_unbound_provider` audit row. SAML sign-ins
write `saml_success` / `saml_failure` audit rows.
