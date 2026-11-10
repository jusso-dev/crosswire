// Least-privilege application role (#135). Run by the migration job AFTER migrations, as the
// owner/admin login (DATABASE_URL). Creates or updates the login role named in APP_DATABASE_URL
// (the URL web and worker use), sets its password from that URL, and grants DML only:
//   - SELECT, INSERT, UPDATE, DELETE on every table in schema public, USAGE/SELECT on its sequences.
//   - No CREATE on any schema, so the app cannot run DDL.
//   - USAGE on schema drizzle and SELECT on drizzle.__drizzle_migrations, so /readyz can read it.
//   - Append-only event tables: no UPDATE on audit_events (retention still deletes old rows), no
//     UPDATE or DELETE on response_events and agent_run_events (they go only by FK cascade, which
//     runs as the table owner).
// Idempotent: safe on every deploy. Skips (exit 0) when APP_DATABASE_URL is unset, for setups that
// keep one login (local dev, Compose). Usage: node scripts/app-db-role.mjs
import postgres from 'postgres'

const APPEND_ONLY_NO_UPDATE = ['audit_events']
const APPEND_ONLY_NO_UPDATE_DELETE = ['response_events', 'agent_run_events']

const log = (level, msg, fields = {}) => console.log(JSON.stringify({ time: new Date().toISOString(), level, msg, ...fields }))

export function appRoleFromUrl(url) {
  const u = new URL(url)
  const role = decodeURIComponent(u.username)
  const password = decodeURIComponent(u.password)
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(role)) throw new Error('APP_DATABASE_URL user must be a plain lower-case role name (letters, digits, _).')
  if (password.length < 16) throw new Error('APP_DATABASE_URL password must be at least 16 characters.')
  return { role, password }
}

export async function ensureAppRole(ownerUrl, appUrl) {
  const { role, password } = appRoleFromUrl(appUrl)
  const sql = postgres(ownerUrl, { max: 1, onnotice: () => {} })
  try {
    const [{ owner }] = await sql`select current_user as owner`
    if (owner === role) throw new Error('APP_DATABASE_URL must use a different role from DATABASE_URL (the owner).')
    await sql.begin(async (tx) => {
      // The password travels as a bound parameter into a transaction-local setting, never as SQL text.
      await tx`select set_config('crosswire.app_role', ${role}, true), set_config('crosswire.app_password', ${password}, true)`
      await tx.unsafe(`
        do $$
        declare
          r text := current_setting('crosswire.app_role');
          pw text := current_setting('crosswire.app_password');
          t text;
        begin
          if not exists (select 1 from pg_roles where rolname = r) then
            execute format('create role %I login password %L', r, pw);
          else
            execute format('alter role %I login password %L', r, pw);
          end if;
          execute format('grant connect on database %I to %I', current_database(), r);
          execute format('revoke create on schema public from %I', r);
          execute format('grant usage on schema public to %I', r);
          execute format('grant select, insert, update, delete on all tables in schema public to %I', r);
          execute format('grant usage, select on all sequences in schema public to %I', r);
          -- Tables created by later migrations (run by this owner) get the same DML grants.
          execute format('alter default privileges in schema public grant select, insert, update, delete on tables to %I', r);
          execute format('alter default privileges in schema public grant usage, select on sequences to %I', r);
          if exists (select 1 from pg_namespace where nspname = 'drizzle') then
            execute format('revoke create on schema drizzle from %I', r);
            execute format('grant usage on schema drizzle to %I', r);
            execute format('grant select on drizzle.__drizzle_migrations to %I', r);
          end if;
          foreach t in array array[${APPEND_ONLY_NO_UPDATE.map((t) => `'${t}'`).join(', ')}] loop
            if to_regclass('public.' || t) is not null then
              execute format('revoke update, truncate on public.%I from %I', t, r);
            end if;
          end loop;
          foreach t in array array[${APPEND_ONLY_NO_UPDATE_DELETE.map((t) => `'${t}'`).join(', ')}] loop
            if to_regclass('public.' || t) is not null then
              execute format('revoke update, delete, truncate on public.%I from %I', t, r);
            end if;
          end loop;
        end
        $$`)
    })
    return { role }
  } finally {
    await sql.end({ timeout: 5 })
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const appUrl = process.env.APP_DATABASE_URL
  if (!appUrl) {
    log('info', 'app database role skipped: APP_DATABASE_URL is not set')
  } else {
    try {
      const { role } = await ensureAppRole(process.env.DATABASE_URL, appUrl)
      log('info', 'app database role ready', { role })
    } catch (err) {
      log('error', 'app database role failed', { error: err instanceof Error ? err.message : String(err) })
      process.exitCode = 1
    }
  }
}
