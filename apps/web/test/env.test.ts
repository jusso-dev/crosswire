import { describe, expect, it } from 'vitest'
import { databaseSslMode, parseEnv, startupWarnings } from '../src/server/env'

describe('env config (#13)', () => {
  it('loads development defaults from an empty env', () => {
    const e = parseEnv({ NODE_ENV: 'development' })
    expect(e.PORT).toBe(3000)
    expect(e.MODEL_PROVIDER).toBe('off')
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

  describe('database TLS warning (#134)', () => {
    const prod = { NODE_ENV: 'production', APP_URL: 'https://cw.example.com', BETTER_AUTH_SECRET: 'x'.repeat(40), APP_ENCRYPTION_KEY: 'a'.repeat(64) }

    it('warns in production when DATABASE_URL does not verify the server certificate', () => {
      for (const url of ['postgres://u:p@db:5432/cw', 'postgres://u:p@db:5432/cw?sslmode=require', 'postgres://u:p@db/cw?sslmode=prefer']) {
        expect(startupWarnings(parseEnv({ ...prod, DATABASE_URL: url }))).toEqual([expect.stringMatching(/sslmode=verify-full/)])
      }
    })

    it('does not warn for verify-full, sslrootcert=system, the override, or outside production', () => {
      expect(startupWarnings(parseEnv({ ...prod, DATABASE_URL: 'postgres://u:p@db/cw?sslmode=verify-full' }))).toEqual([])
      expect(startupWarnings(parseEnv({ ...prod, DATABASE_URL: 'postgres://u:p@db/cw?sslrootcert=system' }))).toEqual([])
      expect(startupWarnings(parseEnv({ ...prod, DATABASE_URL: 'postgres://u:p@db/cw', DATABASE_TLS_INSECURE_OK: 'true' }))).toEqual([])
      expect(startupWarnings(parseEnv({ NODE_ENV: 'development', DATABASE_URL: 'postgres://u:p@db/cw' }))).toEqual([])
    })

    it('warns when Entra sign-in uses a multi-tenant authority in production (#195)', () => {
      const db = 'postgres://u:p@db/cw?sslmode=verify-full'
      expect(startupWarnings(parseEnv({ ...prod, DATABASE_URL: db, ENTRA_CLIENT_ID: 'c' }))).toEqual([expect.stringMatching(/ENTRA_TENANT_ID is "organizations"/)])
      expect(startupWarnings(parseEnv({ ...prod, DATABASE_URL: db, ENTRA_CLIENT_ID: 'c', ENTRA_TENANT_ID: 'common' }))).toEqual([expect.stringMatching(/"common"/)])
      expect(startupWarnings(parseEnv({ ...prod, DATABASE_URL: db, ENTRA_CLIENT_ID: 'c', ENTRA_TENANT_ID: '11111111-1111-1111-1111-111111111111' }))).toEqual([])
      expect(startupWarnings(parseEnv({ ...prod, DATABASE_URL: db }))).toEqual([])
    })

    it('only warns: the server still starts with sslmode=require', () => {
      expect(() => parseEnv({ ...prod, DATABASE_URL: 'postgres://u:p@db/cw?sslmode=require' })).not.toThrow()
    })

    it('reads sslmode from URLs with encoded passwords', () => {
      expect(databaseSslMode(`postgres://u:${encodeURIComponent('p@ss:w/rd#1')}@db/cw?sslmode=verify-full`)).toBe('verify-full')
      expect(databaseSslMode('not a url')).toBeNull()
    })
  })

  it('rejects invalid values with a readable message', () => {
    expect(() => parseEnv({ RESPONSE_EXECUTOR_GRAPH: 'yes' })).toThrow(/RESPONSE_EXECUTOR_GRAPH/)
    expect(() => parseEnv({ BETTER_AUTH_SECRET: 'short' })).toThrow(/BETTER_AUTH_SECRET/)
    expect(() => parseEnv({ TI_CACHE_TTL_SECONDS: '60' })).toThrow(/TI_CACHE_TTL_SECONDS/)
  })
})
