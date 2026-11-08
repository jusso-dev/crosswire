import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { APIError, createAuthMiddleware } from 'better-auth/api'
import { tanstackStartCookies } from 'better-auth/tanstack-start'
import { sso } from '@better-auth/sso'
import { provisionSamlUser, samlProvidersLimit } from './saml'
import { getDb } from '../db/client'
import * as schema from '../db/schema'
import { env } from '../env'
import { writeAudit } from '../audit'
import { ensurePersonalOrg, getCurrentOrg } from '../orgs'
import { claimPendingBootstrapByEmail } from '../ops/bootstrap'
import { UnknownTenantError, decodeJwtClaims, entraEmailFallback, placeEntraUser, resolveEntraOrg } from './entra'
import { logger } from '../lib/logger'

/** Map Better Auth endpoint paths to audit actions. */
const AUDITED_PATHS: Record<string, string> = {
  '/sign-up/email': 'sign_up',
  '/sign-in/email': 'sign_in',
  '/sign-out': 'sign_out',
  '/callback/:id': 'sso_callback',
  '/sso/saml2/sp/acs/:providerId': 'saml_callback',
  '/revoke-session': 'session_revoke',
  '/revoke-sessions': 'session_revoke_all',
  '/revoke-other-sessions': 'session_revoke_others',
}

function requestMeta(headers: Headers | undefined) {
  return {
    // Right-most hop is the one our proxy (ACA ingress / Caddy) appended; earlier entries are client-supplied.
    ipAddress: headers?.get('x-forwarded-for')?.split(',').at(-1)?.trim() || headers?.get('x-real-ip') || null,
    userAgent: headers?.get('user-agent') ?? null,
  }
}

/**
 * Better Auth session lifetime from SESSION_IDLE_MINUTES. updateAge is how often the expiry is
 * pushed forward: about five minutes, never more than half the idle window, so an active user's
 * session is always refreshed well before it lapses.
 */
export function sessionLifetime(idleMinutes: number) {
  const expiresIn = idleMinutes * 60
  return { expiresIn, updateAge: Math.min(5 * 60, Math.floor(expiresIn / 2)) }
}

function createAuth() {
  const e = env()
  const entraEnabled = Boolean(e.ENTRA_CLIENT_ID && e.ENTRA_CLIENT_SECRET)

  return betterAuth({
    appName: 'Crosswire',
    baseURL: e.APP_URL,
    // Custom domains and extra origins (#70, #74). APP_URL is always trusted.
    trustedOrigins: [e.APP_URL, ...(e.CORS_ALLOWED_ORIGINS ?? '').split(',').map((o) => o.trim()).filter((o) => o && o !== '*')],
    secret: e.BETTER_AUTH_SECRET,
    database: drizzleAdapter(getDb(), { provider: 'pg', schema }),
    advanced: {
      useSecureCookies: e.NODE_ENV === 'production',
      database: { generateId: () => crypto.randomUUID() },
      // Behind ACA / a reverse proxy the client IP arrives in X-Forwarded-For.
      ipAddress: {
        ipAddressHeaders: ['x-forwarded-for', 'x-real-ip'],
        ...(e.TRUSTED_PROXIES ? { trustedProxies: e.TRUSTED_PROXIES.split(',').map((s) => s.trim()).filter(Boolean) } : {}),
      },
    },
    // Idle timeout: each authenticated request within updateAge of the last refresh slides the
    // expiry forward, so inactivity for SESSION_IDLE_MINUTES ends the session. The absolute cap
    // (SESSION_MAX_AGE_HOURS since sign-in) is enforced in getAppSession (session.ts).
    session: sessionLifetime(e.SESSION_IDLE_MINUTES),
    // Shared limiter: with storage 'database' every replica counts against the same rate_limit
    // rows (the drizzle adapter finds the table by the `rateLimit` export in schema/auth.ts).
    rateLimit: {
      enabled: e.NODE_ENV !== 'test',
      window: 60,
      max: 30,
      customRules: { '/sign-in/email': { window: 60, max: 5 } },
      ...(e.RATE_LIMIT_STORAGE === 'database' && e.NODE_ENV !== 'test' ? { storage: 'database' as const, modelName: 'rateLimit' } : { storage: 'memory' as const }),
    },
    emailAndPassword: { enabled: e.AUTH_EMAIL_PASSWORD, minPasswordLength: 12, autoSignIn: true },
    account: { encryptOAuthTokens: true },
    onAPIError: { errorURL: '/auth-error' },
    socialProviders: entraEnabled
      ? {
          microsoft: {
            clientId: e.ENTRA_CLIENT_ID!,
            clientSecret: e.ENTRA_CLIENT_SECRET!,
            tenantId: e.ENTRA_TENANT_ID,
            scope: ['openid', 'profile', 'email'],
            disableProfilePhoto: true,
            // Reject unknown tenants before a user row is created (see docs/auth.md).
            mapProfileToUser: async (profile) => {
              if (typeof profile.tid !== 'string') throw new APIError('FORBIDDEN', { message: 'missing_tenant' })
              try {
                await resolveEntraOrg(profile.tid)
              } catch (err) {
                if (err instanceof UnknownTenantError) {
                  await writeAudit({ category: 'auth', action: 'sso_rejected_unknown_tenant', result: 'failure', actorType: 'system', data: { tid: profile.tid } })
                  throw new APIError('FORBIDDEN', { message: 'unknown_tenant', code: 'UNKNOWN_TENANT' })
                }
                throw err
              }
              return entraEmailFallback(profile)
            },
          },
        }
      : undefined,
    databaseHooks: {
      user: {
        create: {
          after: async (created, ctx) => {
            // Entra users are placed by the account hook below; local users get a personal org.
            if (ctx?.path?.startsWith('/callback') || ctx?.path?.startsWith('/sso/')) return
            // Bootstrap admin signing up locally joins the bootstrapped org as owner (#78).
            if (await claimPendingBootstrapByEmail(created.id, created.email)) return
            await ensurePersonalOrg(created.id, created.name || created.email)
          },
        },
      },
      account: {
        create: {
          after: async (acct) => {
            if (acct.providerId !== 'microsoft' || !acct.idToken) return
            const tid = decodeJwtClaims(acct.idToken).tid
            if (typeof tid === 'string') {
              const orgId = await placeEntraUser(acct.userId, tid)
              await writeAudit({ category: 'auth', action: 'sso_linked', actorType: 'user', actorId: acct.userId, orgId, data: { provider: 'microsoft' } })
            }
          },
        },
      },
    },
    hooks: {
      after: createAuthMiddleware(async (ctx) => {
        const action = AUDITED_PATHS[ctx.path]
        if (!action) return
        const returned = ctx.context.returned
        const failed = returned instanceof APIError || (returned instanceof Response && returned.status >= 400)
        const sessionUser = ctx.context.newSession?.user ?? ctx.context.session?.user
        const userId = sessionUser?.id ?? null
        const org = userId ? await getCurrentOrg(userId).catch(() => null) : null
        try {
          await writeAudit({
            category: 'auth',
            action:
              action === 'sso_callback' || action === 'saml_callback'
                ? `${action === 'saml_callback' ? 'saml' : 'sso'}_${failed || !userId ? 'failure' : 'success'}`
                : action,
            result: failed ? 'failure' : 'success',
            actorType: userId ? 'user' : 'system',
            actorId: userId,
            orgId: org?.id ?? null,
            ...requestMeta(ctx.headers),
            // Never log the submitted email/password; record only the provider for SSO.
            data: action === 'sso_callback' ? { provider: ctx.params?.id ?? null } : action === 'saml_callback' ? { provider: ctx.params?.providerId ?? null } : {},
          })
        } catch (err) {
          logger.error('auth audit write failed', { error: err instanceof Error ? err.message : String(err) })
        }
      }),
    },
    plugins: [
      // SAML SSO (Later, #65). Entra OIDC above stays the default; tanstackStartCookies must be last.
      ...(e.SAML_ENABLED ? [sso({ providersLimit: samlProvidersLimit, provisionUser: async (d) => void (await provisionSamlUser(d)), provisionUserOnEveryLogin: true })] : []),
      tanstackStartCookies(),
    ],
  })
}

export type Auth = ReturnType<typeof createAuth>
let instance: Auth | undefined
export function auth(): Auth {
  instance ??= createAuth()
  return instance
}
export function resetAuthForTests() {
  instance = undefined
}
