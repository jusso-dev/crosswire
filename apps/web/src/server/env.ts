import { BlockList, isIP } from 'node:net'
import { z } from 'zod'

/**
 * Single source of truth for server configuration. Names match `.env.example`.
 * Server-only: never import this module from client code.
 */
const bool = (fallback: boolean) =>
  z
    .enum(['true', 'false', '1', '0', ''])
    .optional()
    .transform((v) => (v === undefined || v === '' ? fallback : v === 'true' || v === '1'))

const executorFlag = z.enum(['off', 'dry-run', 'on']).default('off')
const optionalBool = z.enum(['true', 'false', '1', '0']).optional().transform((v) => (v === undefined ? undefined : v === 'true' || v === '1'))

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  APP_URL: z.url().default('http://localhost:3000'),
  DATABASE_URL: z.string().min(1).default('postgres://crosswire:crosswire-local-dev@localhost:5432/crosswire'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  /** IANA zone for displayed times and the daily digest day. Storage stays UTC. */
  APP_TIMEZONE: z
    .string()
    .default('Australia/Sydney')
    .refine((tz) => {
      try {
        new Intl.DateTimeFormat('en-AU', { timeZone: tz })
        return true
      } catch {
        return false
      }
    }, 'must be an IANA time zone such as Australia/Sydney'),

  BETTER_AUTH_SECRET: z.string().min(32).default('dev-only-insecure-secret-change-me-0000'),
  AUTH_EMAIL_PASSWORD: bool(true),
  ENTRA_CLIENT_ID: z.string().optional(),
  ENTRA_CLIENT_SECRET: z.string().optional(),
  ENTRA_TENANT_ID: z.string().default('organizations'),
  ENTRA_ORG_NAME: z.string().default('Entra organisation'),
  /**
   * Comma-separated proxy IPs or CIDR ranges (IPv4 or IPv6) whose X-Forwarded-For entries are
   * trusted, by Better Auth and the chat rate limiter (#157). An invalid entry stops the server.
   */
  TRUSTED_PROXIES: z
    .string()
    .optional()
    .superRefine((v, ctx) => {
      const { invalid } = parseTrustedProxies(v)
      if (invalid.length) ctx.addIssue({ code: 'custom', message: `not an IP address or CIDR range: ${invalid.join(', ')}` })
    }),
  ENTRA_AUTO_PROVISION_ORGS: bool(false),

  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_FROM: z.string().default('Crosswire <crosswire@localhost>'),
  /**
   * Allows SMTP without TLS (#210). Off by default: port 465 uses implicit TLS and every other port
   * must upgrade with STARTTLS, or the send fails. Only for a lab relay on a trusted network.
   */
  SMTP_ALLOW_PLAINTEXT: bool(false),

  /**
   * Chat model (ADR 0004). Crosswire hosts the agents; the model only answers.
   * `azure`: Azure OpenAI, keyless via Entra (managed identity) unless AZURE_OPENAI_API_KEY is set.
   * `openai-compatible`: any OpenAI-compatible endpoint. `off`: chat shows a setup message.
   */
  MODEL_PROVIDER: z.enum(['off', 'azure', 'openai-compatible']).default('off'),
  /** Resource endpoint, for example https://contoso-ai.openai.azure.com */
  AZURE_OPENAI_ENDPOINT: z.url().optional(),
  /** Deployment name of the chat model in that resource. */
  AZURE_OPENAI_DEPLOYMENT: z.string().optional(),
  /** Optional. Leave unset to use Entra ID (recommended). */
  AZURE_OPENAI_API_KEY: z.string().optional(),
  /** Optional; the v1 API needs none. */
  AZURE_OPENAI_API_VERSION: z.string().optional(),
  /** Optional: client ID of a user-assigned managed identity for DefaultAzureCredential. */
  AZURE_CLIENT_ID: z.string().optional(),
  OPENAI_BASE_URL: z.url().optional(),
  OPENAI_MODEL: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_API: z.enum(['chat-completions', 'responses']).default('chat-completions'),
  AGENT_TIMEOUT_MS: z.coerce.number().int().positive().default(90_000),

  TI_CACHE_TTL_SECONDS: z.coerce.number().int().min(3600).default(3600),
  TI_HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  PWN_WATCH_BASE_URL: z.url().default('https://pwn.watch'),
  CISA_KEV_URL: z
    .url()
    .default('https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json'),
  CVE_WATCH_ENABLED: bool(false),

  APP_ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-f]{64}$/i, 'APP_ENCRYPTION_KEY must be 64 hex characters (32 bytes)')
    .optional(),
  HUNTING_DEMO_MODE: bool(true),
  HUNTING_MAX_ROWS: z.coerce.number().int().positive().max(1000).default(100),
  HUNTING_TIMEOUT_MS: z.coerce.number().int().positive().max(120_000).default(60_000),
  KQL_PROPOSAL_TTL_HOURS: z.coerce.number().int().positive().default(24),

  RESPONSE_EXECUTOR_SENTINEL: executorFlag,
  RESPONSE_EXECUTOR_LOGICAPP: executorFlag,
  RESPONSE_EXECUTOR_GRAPH: executorFlag,
  RESPONSE_LOGICAPP_URL: z.url().optional(),
  /** Global dry-run switch (#83). Unset = true. Live execution needs RESPONSE_DRY_RUN=false explicitly. */
  RESPONSE_DRY_RUN: optionalBool,
  RESPONSE_ALLOW_SELF_APPROVAL: bool(false),
  RESPONSE_PROPOSAL_TTL_HOURS: z.coerce.number().int().positive().default(24),
  /** v2 (#89): most devices/incidents one live proposal may act on. Hard ceiling 50. */
  RESPONSE_MAX_LIVE_TARGETS: z.coerce.number().int().positive().max(50).default(10),

  SAML_ENABLED: bool(false),

  RADAR_ENABLED: bool(false),
  CLOUDFLARE_API_TOKEN: z.string().optional(),

  WORKER_TIMEZONE: z.string().default('UTC'),
  /** Port of the worker's health server (GET /healthz), used by container probes (#142, #151). */
  WORKER_HEALTH_PORT: z.coerce.number().int().positive().max(65535).default(3001),
  /** v2 (#92): scheduled hunts. Off switch for the worker loop; schedules still need human approval. */
  SCHEDULED_HUNTS_ENABLED: bool(true),
  /** v2 (#91): outbound webhook notifications (Teams/Slack). Channels are configured per org. */
  NOTIFICATIONS_ENABLED: bool(true),

  /** Comma-separated extra origins allowed for CORS / Better Auth trusted origins (#74). APP_URL is always allowed. */
  CORS_ALLOWED_ORIGINS: z.string().optional(),
  /** Per-IP requests per minute for /api/chat (#74). */
  RATE_LIMIT_CHAT_PER_MIN: z.coerce.number().int().positive().default(20),

  /**
   * Who may approve and run a read-only KQL search. `member`: any org member (default).
   * `approver`: owners and approvers only. `second-person`: an approver other than the person who
   * asked for it (the proposer, or the chat user whose agent proposed it); no edits at approval.
   */
  KQL_APPROVAL_POLICY: z.enum(['member', 'approver', 'second-person']).default('member'),

  /** Session lifetime: absolute cap since sign-in, and idle timeout since last activity. */
  SESSION_MAX_AGE_HOURS: z.coerce.number().int().positive().max(24 * 30).default(12),
  SESSION_IDLE_MINUTES: z.coerce.number().int().min(5).max(24 * 60).default(60),

  /** Data retention in days, purged daily by the worker. 0 keeps that data forever. */
  RETENTION_CHAT_DAYS: z.coerce.number().int().min(0).default(365),
  RETENTION_DECISIONS_DAYS: z.coerce.number().int().min(0).default(365),
  RETENTION_SAMPLES_DAYS: z.coerce.number().int().min(0).default(180),
  RETENTION_AUDIT_DAYS: z.coerce.number().int().min(0).default(730),

  /** Largest TI feed response accepted, in bytes (default 25 MB). Larger responses are refused. */
  TI_MAX_RESPONSE_BYTES: z.coerce.number().int().positive().default(25 * 1024 * 1024),

  /** Previous APP_ENCRYPTION_KEY values (comma-separated, 64 hex each), accepted for decryption during rotation. */
  APP_ENCRYPTION_KEY_PREVIOUS: z
    .string()
    .regex(/^[0-9a-f]{64}(,[0-9a-f]{64})*$/i, 'APP_ENCRYPTION_KEY_PREVIOUS must be comma-separated 64-hex keys')
    .optional(),

  /** Rate-limit counters: `database` is shared by every replica (default); `memory` is per process. */
  RATE_LIMIT_STORAGE: z.enum(['database', 'memory']).default('database'),

  /** Application Insights (#73). When set, OpenTelemetry exports traces/logs to Azure Monitor. */
  APPLICATIONINSIGHTS_CONNECTION_STRING: z.string().optional(),

  /** Squad governance. `enforced` is the default. `legacy` is the previous behaviour, for a rollback of one control. */
  MEMORY_GOVERNANCE: z.enum(['enforced', 'legacy']).default('enforced'),
  RUN_LEDGER: z.enum(['enforced', 'legacy']).default('enforced'),
  EGRESS_FILTER: z.enum(['enforced', 'legacy']).default('enforced'),
  APPROVAL_BINDING: z.enum(['enforced', 'legacy']).default('enforced'),
  /** Per-call input estimate cap (characters / 4). Not a provider token count. */
  BUDGET_MAX_INPUT_TOKENS: z.coerce.number().int().positive().default(24_000),
  BUDGET_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(4_000),
  /** Parent turn plus up to 4 specialist calls, with headroom. */
  BUDGET_MAX_INFLIGHT: z.coerce.number().int().positive().default(8),
  BUDGET_CONTEXT_WINDOW_TOKENS: z.coerce.number().int().positive().default(128_000),
  BUDGET_DAILY_INPUT_TOKENS: z.coerce.number().int().positive().default(200_000),
  /**
   * Optional dollar cap, in micros (1 USD = 1_000_000). Requires BUDGET_USD_PER_MILLION_TOKENS.
   * Unset means there is no dollar cap. Token and inflight caps still apply. A cap without a rate fails closed.
   */
  BUDGET_MAX_SPEND_MICROS: z.coerce.number().int().nonnegative().optional(),
  /** Customer-supplied price. Crosswire does not invent a price for an Azure deployment. */
  BUDGET_USD_PER_MILLION_TOKENS: z.coerce.number().positive().optional(),

  /**
   * Silences the production warning for a DATABASE_URL without sslmode=verify-full (#134), for a
   * database on a private network that has no TLS. It does not change how the driver connects.
   */
  DATABASE_TLS_INSECURE_OK: bool(false),
})

/** Every variable the server reads through env(). Used by the Bicep coverage test (#133). */
export const ENV_KEYS = Object.keys(schema.shape) as Array<keyof z.infer<typeof schema>>

export type Env = z.infer<typeof schema>

/** Variables that must be set explicitly in production (no dev default allowed). */
const REQUIRED_IN_PRODUCTION = ['APP_URL', 'DATABASE_URL', 'BETTER_AUTH_SECRET', 'APP_ENCRYPTION_KEY'] as const

export function parseEnv(source: Record<string, string | undefined>): Env {
  // Empty values (KEY= in .env) mean "unset", so documented placeholders never fail validation.
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v.trim() !== ''))
  const result = schema.safeParse(cleaned)
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n')
    throw new Error(`Invalid configuration:\n${issues}\nSee .env.example for every variable.`)
  }
  if (result.data.NODE_ENV === 'production') {
    const missing = REQUIRED_IN_PRODUCTION.filter((k) => !cleaned[k])
    if (missing.length > 0) {
      throw new Error(
        `Missing required production configuration: ${missing.join(', ')}. See .env.example and docs/configuration.md.`,
      )
    }
  }
  return result.data
}

/**
 * Configuration that starts but is weaker than it should be. Logged loudly at start-up; never
 * refuses to start, so an existing deployment keeps running while it is fixed.
 */
export function startupWarnings(e: Env): string[] {
  const warnings: string[] = []
  if (e.NODE_ENV === 'production' && !e.DATABASE_TLS_INSECURE_OK && databaseSslMode(e.DATABASE_URL) !== 'verify-full') {
    warnings.push(
      'DATABASE_URL does not set sslmode=verify-full, so the Postgres server certificate and host name are not checked. ' +
        'Add ?sslmode=verify-full (see docs/configuration.md). Set DATABASE_TLS_INSECURE_OK=true only for a database without TLS on a private network.',
    )
  }
  if (e.NODE_ENV === 'production' && e.SMTP_HOST && e.SMTP_ALLOW_PLAINTEXT) {
    warnings.push('SMTP_ALLOW_PLAINTEXT=true: mail, including the SMTP password and confirmation links, may be sent without TLS. Use it only for a relay on a trusted network.')
  }
  return warnings
}

/** The sslmode in a Postgres URL (lower case), or null when it has none or cannot be parsed. */
export function databaseSslMode(url: string): string | null {
  try {
    const params = new URL(url).searchParams
    // sslrootcert=system implies verify-full in postgres.js.
    if (params.get('sslrootcert') === 'system') return 'verify-full'
    return params.get('sslmode')?.toLowerCase() ?? null
  } catch {
    return null
  }
}

const WARNED = Symbol.for('crosswire.startupWarningsLogged')

/**
 * Log start-up warnings once per process, as JSON lines in the logger's format (env.ts stays free
 * of other app imports because server.mjs loads it as a separate bundle). The flag lives on
 * globalThis so the env-check bundle and the server bundle share it.
 */
export function logStartupWarnings(e: Env, write: (line: string) => void = (l) => process.stdout.write(`${l}\n`)) {
  const g = globalThis as unknown as Record<symbol, boolean>
  if (g[WARNED]) return
  g[WARNED] = true
  for (const w of startupWarnings(e)) write(JSON.stringify({ time: new Date().toISOString(), level: 'warn', msg: 'startup configuration warning', warning: w }))
}

let cached: Env | undefined
export function env(): Env {
  if (!cached) {
    cached = parseEnv(process.env)
    logStartupWarnings(cached)
  }
  return cached
}

/** Test hook: reset the cached configuration after mutating process.env. */
export function resetEnvForTests() {
  cached = undefined
}

export type ExecutorName = 'sentinel' | 'logicapp' | 'graph'

export interface ResponseSafety {
  /** True when no executor may perform a live call (global dry-run). */
  dryRun: boolean
  executors: Record<ExecutorName, 'off' | 'dry-run' | 'on'>
  /** Human-readable reasons a requested `on` executor was downgraded (fail closed). */
  warnings: string[]
}

/**
 * Effective response safety (#83). Fails closed:
 * - RESPONSE_DRY_RUN unset => dry-run ON.
 * - Any executor flag `on` while dry-run is ON is downgraded to `dry-run` and reported.
 * - Executor flags unset => off.
 */
export function responseSafety(e: Env = env()): ResponseSafety {
  const dryRun = e.RESPONSE_DRY_RUN !== false
  const requested = { sentinel: e.RESPONSE_EXECUTOR_SENTINEL, logicapp: e.RESPONSE_EXECUTOR_LOGICAPP, graph: e.RESPONSE_EXECUTOR_GRAPH }
  const warnings: string[] = []
  const executors = { ...requested }
  if (dryRun) {
    for (const [k, v] of Object.entries(requested) as Array<[ExecutorName, 'off' | 'dry-run' | 'on']>) {
      if (v === 'on') {
        executors[k] = 'dry-run'
        warnings.push(`RESPONSE_EXECUTOR_${k.toUpperCase()}=on ignored: RESPONSE_DRY_RUN is not explicitly false, so live execution stays disabled.`)
      }
    }
  }
  return { dryRun, executors, warnings }
}

/** Matches client IPs against TRUSTED_PROXIES entries. */
export interface ProxyMatcher {
  has(ip: string): boolean
}

/**
 * Parse a comma-separated TRUSTED_PROXIES value (#157). Each entry is an IPv4 or IPv6 address, or
 * a CIDR range such as `10.0.0.0/8` or `fd00::/8`. Returns the matcher and any invalid entries.
 * IPv4 entries also match the IPv4-mapped IPv6 form (`::ffff:10.0.0.1`). Uses node:net BlockList.
 */
export function parseTrustedProxies(value: string | undefined): { matcher: ProxyMatcher; invalid: string[] } {
  const list = new BlockList()
  const invalid: string[] = []
  for (const raw of (value ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const [addr = '', bits, extra] = raw.split('/')
    const family = isIP(addr)
    const type = family === 4 ? 'ipv4' : 'ipv6'
    if (!family || extra !== undefined) {
      invalid.push(raw)
    } else if (bits === undefined) {
      list.addAddress(addr, type)
    } else {
      const prefix = /^\d{1,3}$/.test(bits) ? Number(bits) : NaN
      if (prefix >= 0 && prefix <= (family === 4 ? 32 : 128)) list.addSubnet(addr, prefix, type)
      else invalid.push(raw)
    }
  }
  return {
    invalid,
    matcher: {
      has(ip: string) {
        const family = isIP(ip)
        return family !== 0 && list.check(ip, family === 4 ? 'ipv4' : 'ipv6')
      },
    },
  }
}
