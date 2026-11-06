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

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  APP_URL: z.url().default('http://localhost:3000'),
  DATABASE_URL: z.string().min(1).default('postgres://crosswire:crosswire-local-dev@localhost:5432/crosswire'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  BETTER_AUTH_SECRET: z.string().min(32).default('dev-only-insecure-secret-change-me-0000'),
  AUTH_EMAIL_PASSWORD: bool(true),
  ENTRA_CLIENT_ID: z.string().optional(),
  ENTRA_CLIENT_SECRET: z.string().optional(),
  ENTRA_TENANT_ID: z.string().default('organizations'),
  ENTRA_ORG_NAME: z.string().default('Entra organisation'),
  /** Comma-separated proxy IPs/CIDRs whose X-Forwarded-For entries are trusted (Better Auth). */
  TRUSTED_PROXIES: z.string().optional(),
  ENTRA_AUTO_PROVISION_ORGS: bool(false),

  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_FROM: z.string().default('Crosswire <crosswire@localhost>'),

  MODEL_PROVIDER: z.enum(['stub', 'anthropic', 'openai']).default('stub'),
  MODEL_NAME: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  AGENT_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),

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
  RESPONSE_ALLOW_SELF_APPROVAL: bool(false),
  RESPONSE_PROPOSAL_TTL_HOURS: z.coerce.number().int().positive().default(24),

  SAML_ENABLED: bool(false),

  RADAR_ENABLED: bool(false),
  CLOUDFLARE_API_TOKEN: z.string().optional(),

  WORKER_TIMEZONE: z.string().default('UTC'),
})

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

let cached: Env | undefined
export function env(): Env {
  cached ??= parseEnv(process.env)
  return cached
}

/** Test hook: reset the cached configuration after mutating process.env. */
export function resetEnvForTests() {
  cached = undefined
}
