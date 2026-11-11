# Runbook: bootstrap the first org and admin (#78)

Run **once** on a fresh database, after migrations.

```sh
# From a checkout (reads .env):
ADMIN_EMAIL=soc-lead@contoso.com ORG_NAME="Contoso SOC" BOOTSTRAP_ENTRA_TENANT_ID=<tenant guid> pnpm bootstrap

# Azure: run bootstrap inside the web container (it already has DATABASE_URL and secrets):
az containerapp exec -g crosswire-prod -n crosswire-web --command \
  "env ADMIN_EMAIL=soc-lead@contoso.com ORG_NAME='Contoso SOC' BOOTSTRAP_ENTRA_TENANT_ID=<tenant guid> node_modules/.bin/tsx src/server/cli/bootstrap.ts"

# Compose prod (from the directory with .env.prod):
docker compose -f docker-compose.prod.yml --env-file .env.prod run --rm \
  -e ADMIN_EMAIL=soc-lead@contoso.com -e ORG_NAME="Contoso SOC" migrate \
  node_modules/.bin/tsx src/server/cli/bootstrap.ts
```

What it does:

- Creates the first org (optionally linked to your Entra tenant id) and records the admin email.
- If that user already exists they become **owner** immediately (you ran the command, so this is
  your choice; check the address first).
- Otherwise the first sign-in with that email becomes owner of the bootstrapped org, but only when
  the email is proven (#188):
  - **Entra:** the sign-in must come from the tenant in `BOOTSTRAP_ENTRA_TENANT_ID`. The same
    address from another tenant does not claim it.
  - **SAML:** the account's email must be verified.
  - **Local sign-up never claims it**, because it does not verify the address. The new account
    gets its own personal workspace instead.
  Each refused attempt writes a `bootstrap_owner_claim_refused` audit row. Everyone else from the
  tenant joins as analyst (or by group mapping, see [auth](../auth.md#roles-from-entra-groups-and-app-roles)).
- With `BOOTSTRAP_ENTRA_TENANT_ID`, the admin's email domain is stored as the org's domain, so local
  and SAML sign-ups for that domain are refused (#203).
- Personal workspaces from earlier local sign-ups do not block bootstrap; only a team org does.
- **Production:** keep `AUTH_EMAIL_PASSWORD=false` (Azure default).
- Writes a `bootstrap` audit row (no full email stored).
- **Refuses** if any org exists (safe to re-run; it fails with a message).
- **Refuses** if live response execution is enabled. Defaults are dry-run ON and executors OFF
  (fail closed, see [response](../response.md)); row limits are always on.

Lab reset (break-glass, lab only): drop and recreate the database, run migrations, bootstrap again.
