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
import { EntraSignInRefused, UnknownTenantError, checkEntraGate, entraEmailFallback, latestEntraClaims, syncEntraSignIn } from './entra'
import { entraClaimedDomain } from './domains'
import { logger } from '../lib/logger'
import { clientIp } from '../lib/http-security'

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

/**
 * Header that carries the client IP to Better Auth (#196). `withClientIp` sets it from
 * X-Forwarded-For (right-most untrusted hop, skipping TRUSTED_PROXIES, the same rule as the chat
 * limiter) and drops any value the client sent. Better Auth reads only this header, so a client
 * cannot pick its own rate-limit bucket with X-Real-IP or extra X-Forwarded-For entries.
 */
export const CLIENT_IP_HEADER = 'x-crosswire-client-ip'

export function withClientIp(request: Request): Request {
  // srvx's NodeRequest cannot be passed to Node's native Request constructor.
  // Its clone method returns a native request, preserving the method and body.
  const forwarded = request.clone()
  const headers = forwarded.headers
  headers.delete(CLIENT_IP_HEADER)
  const ip = clientIp(request.headers)
  if (ip) headers.set(CLIENT_IP_HEADER, ip)
  return forwarded
}

function requestMeta(headers: Headers | undefined) {
  return {
    ipAddress: headers?.get(CLIENT_IP_HEADER) ?? (headers ? clientIp(headers) : null),
    userAgent: headers?.get('user-agent') ?? null,
  }
}

/** Plain codes for /auth-error. The callback turns an APIError with a code into that redirect. */
function signInError(err: unknown): unknown {
  if (err instanceof UnknownTenantError) return new APIError('FORBIDDEN', { message: 'unknown_tenant', code: 'UNKNOWN_TENANT' })
  if (err instanceof EntraSignInRefused) return new APIError('FORBIDDEN', { message: err.code.toLowerCase(), code: err.code })
  return err
}

/** Redirect to /auth-error from code that runs outside the callback's own error handling. */
function authErrorRedirect(code: string) {
  return new APIError('FOUND', undefined, new Headers({ location: `${env().APP_URL}/auth-error?error=${encodeURIComponent(code)}` }))
}

type HookCtx = { path?: string; params?: Record<string, string | undefined> } | null | undefined
const isMicrosoftCallback = (ctx: HookCtx) => ctx?.path === '/callback/:id' && ctx.params?.id === 'microsoft'

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
      // Set by withClientIp (#196), never by the client. TRUSTED_PROXIES is applied there.
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
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
            // Redirect flow only (#188): no POST /sign-in/social with a bare ID token.
            disableIdTokenSignIn: true,
            // Check only (#187): refuse an unknown tenant, or a token that matches no mapping when the
            // org requires one, before a user row is created. Placement happens at session creation.
            mapProfileToUser: async (profile) => {
              try {
                await checkEntraGate(profile)
              } catch (err) {
                if (err instanceof UnknownTenantError) {
                  await writeAudit({ category: 'auth', action: 'sso_rejected_unknown_tenant', result: 'failure', actorType: 'system', data: { tid: err.tid || null } })
                  throw authErrorRedirect('UNKNOWN_TENANT')
                }
                if (err instanceof EntraSignInRefused) throw authErrorRedirect(err.code)
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
          // A local or SAML account cannot take an address in a domain an Entra tenant owns (#203).
          before: async (u, ctx) => {
            if (isMicrosoftCallback(ctx)) return
            if (await entraClaimedDomain(u.email)) throw new APIError('FORBIDDEN', { message: 'Use Microsoft sign-in for this address.', code: 'DOMAIN_USES_ENTRA' })
          },
          after: async (created, ctx) => {
            // Only a local sign-up gets a personal workspace (#188). SSO users are placed by their
            // provider; any other path (for example a direct API call) places nobody.
            if (ctx?.path !== '/sign-up/email') return
            await ensurePersonalOrg(created.id, created.name || created.email)
          },
        },
      },
      session: {
        create: {
          // Every Entra sign-in (#187, #195): place the user and sync their role from group and
          // app-role mappings, using the ID token Better Auth stored just before this session.
          // A refusal stops the session; the callback sends the user to /auth-error with the code.
          before: async (s, ctx) => {
            if (!isMicrosoftCallback(ctx)) return
            try {
              await syncEntraSignIn(s.userId, await latestEntraClaims(s.userId))
            } catch (err) {
              throw signInError(err)
            }
          },
        },
      },
    },
    hooks: {
      // SAML provider domains (#203): one domain per provider (the unique index then means one
      // provider per domain), and never a domain an Entra org owns.
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== '/sso/register' && ctx.path !== '/sso/update-provider') return
        const domain = (ctx.body as { domain?: unknown } | undefined)?.domain
        if (domain === undefined) return
        if (typeof domain !== 'string' || domain.includes(',')) throw new APIError('BAD_REQUEST', { message: 'Register one domain per provider.', code: 'ONE_DOMAIN_PER_PROVIDER' })
        if (await entraClaimedDomain(`x@${domain.trim()}`)) throw new APIError('FORBIDDEN', { message: 'This domain belongs to an Entra-connected organisation.', code: 'DOMAIN_USES_ENTRA' })
      }),
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
      // Domain verification (#203): a provider signs nobody in until a DNS TXT record proves its domain.
      ...(e.SAML_ENABLED
        ? [sso({ providersLimit: samlProvidersLimit, domainVerification: { enabled: true }, provisionUser: async (d) => void (await provisionSamlUser(d)), provisionUserOnEveryLogin: true })]
        : []),
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
