import { env } from '../env'

/**
 * Security headers + CORS + simple rate limits (#74). No Cloudflare/WAF dependency.
 */

/** Baseline CSP. 'unsafe-inline' for scripts is required by TanStack Start's SSR hydration bootstrap. */
export const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ')

export function securityHeaders(isHttps: boolean): Record<string, string> {
  const h: Record<string, string> = {
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
  }
  if (isHttps) h['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains'
  return h
}

/** Allowed cross-origin callers: APP_URL's origin plus CORS_ALLOWED_ORIGINS. Never `*`. */
export function allowedOrigins(): Set<string> {
  const e = env()
  const out = new Set<string>([new URL(e.APP_URL).origin])
  for (const o of (e.CORS_ALLOWED_ORIGINS ?? '').split(',')) {
    const t = o.trim()
    if (!t || t === '*') continue
    try {
      out.add(new URL(t).origin)
    } catch {
      /* ignore malformed */
    }
  }
  return out
}

export function corsHeaders(origin: string | null): Record<string, string> | null {
  if (!origin || !allowedOrigins().has(origin)) return null
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type, x-request-id',
    Vary: 'Origin',
  }
}

/**
 * Fixed-window in-memory limiter. Per replica: with N replicas the effective limit is N x limit
 * (documented). Auth endpoints use Better Auth's own limiter.
 */
export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>()
  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
  ) {}

  check(key: string, now = Date.now()): { ok: boolean; retryAfterSec: number } {
    const cur = this.hits.get(key)
    if (!cur || cur.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs })
      if (this.hits.size > 10_000) this.sweep(now)
      return { ok: true, retryAfterSec: 0 }
    }
    cur.count++
    return cur.count > this.limit ? { ok: false, retryAfterSec: Math.ceil((cur.resetAt - now) / 1000) } : { ok: true, retryAfterSec: 0 }
  }

  private sweep(now: number) {
    for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k)
  }
}

/**
 * Client key for rate limiting: walk X-Forwarded-For from the right, skipping hops listed in
 * TRUSTED_PROXIES (exact IPs), and use the first untrusted hop. Without TRUSTED_PROXIES the
 * right-most hop is used (the one the nearest proxy appended). Clients cannot choose a bucket by
 * prepending entries; they could only add entries to the left, which are ignored.
 */
export function clientKey(request: Request, trusted = trustedProxies()) {
  const hops = (request.headers.get('x-forwarded-for') ?? '').split(',').map((h) => h.trim()).filter(Boolean)
  for (let i = hops.length - 1; i >= 0; i--) {
    if (!trusted.has(hops[i]!)) return hops[i]!
  }
  return request.headers.get('x-real-ip') || hops[0] || 'local'
}

function trustedProxies() {
  return new Set((env().TRUSTED_PROXIES ?? '').split(',').map((s) => s.trim()).filter(Boolean))
}

let chatLimiter: RateLimiter | undefined
export function chatRateLimiter() {
  chatLimiter ??= new RateLimiter(env().RATE_LIMIT_CHAT_PER_MIN)
  return chatLimiter
}
