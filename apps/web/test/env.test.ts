import { describe, expect, it } from 'vitest'
import { parseEnv } from '../src/server/env'

describe('env config (#13)', () => {
  it('loads development defaults from an empty env', () => {
    const e = parseEnv({ NODE_ENV: 'development' })
    expect(e.PORT).toBe(3000)
    expect(e.MODEL_PROVIDER).toBe('stub')
    expect(e.RESPONSE_EXECUTOR_SENTINEL).toBe('off')
    expect(e.RESPONSE_EXECUTOR_LOGICAPP).toBe('off')
    expect(e.RESPONSE_EXECUTOR_GRAPH).toBe('off')
    expect(e.ENTRA_AUTO_PROVISION_ORGS).toBe(false)
  })

  it('fails fast and names missing production variables', () => {
    expect(() => parseEnv({ NODE_ENV: 'production' })).toThrow(/APP_URL, DATABASE_URL, BETTER_AUTH_SECRET, APP_ENCRYPTION_KEY/)
  })

  it('accepts a complete production config', () => {
    const e = parseEnv({
      NODE_ENV: 'production',
      APP_URL: 'https://crosswire.example.com',
      DATABASE_URL: 'postgres://u:p@db:5432/crosswire',
      BETTER_AUTH_SECRET: 'x'.repeat(40),
      APP_ENCRYPTION_KEY: 'a'.repeat(64),
    })
    expect(e.APP_URL).toBe('https://crosswire.example.com')
  })

  it('rejects invalid values with a readable message', () => {
    expect(() => parseEnv({ RESPONSE_EXECUTOR_GRAPH: 'yes' })).toThrow(/RESPONSE_EXECUTOR_GRAPH/)
    expect(() => parseEnv({ BETTER_AUTH_SECRET: 'short' })).toThrow(/BETTER_AUTH_SECRET/)
    expect(() => parseEnv({ TI_CACHE_TTL_SECONDS: '60' })).toThrow(/TI_CACHE_TTL_SECONDS/)
  })
})
