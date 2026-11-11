import { defineConfig } from '@playwright/test'
import { STORAGE_STATE, TEST_TIME_ZONE } from './support/helpers'

/**
 * End-to-end tests (#80, #147). Chromium only.
 *
 * - CI (`e2e` job in .github/workflows/ci.yml) and a plain local run start the mock model and the
 *   built app themselves (`webServer`), against PG_E2E_URL (a disposable database: specs write to it).
 * - Set BASE_URL to test an app you already run; then only the mock model is started.
 *   Set APP_TIMEZONE to that app's display zone (default Australia/Sydney).
 * - global-setup.ts signs up one owner, loads [DEMO] data and saves the session; specs reuse it.
 *   Specs that change shared demo state sign up their own user (the helper waits out the
 *   sign-up rate limit, so order does not matter).
 * Local: `pnpm build`, then `PG_E2E_URL=postgres://... pnpm test:e2e`.
 * On failure, traces, screenshots and the HTML report land in e2e/test-results and e2e/playwright-report.
 */
const CI = Boolean(process.env.CI)
const externalApp = process.env.BASE_URL
const baseURL = externalApp ?? 'http://127.0.0.1:3100'
const MOCK_PORT = Number(process.env.MOCK_MODEL_PORT ?? 18099)
const dbUrl = process.env.PG_E2E_URL ?? 'postgres://crosswire:crosswire-local-dev@localhost:5432/crosswire_e2e'

// Fixed throwaway values for a local test server. Not secrets.
const appEnv = {
  NODE_ENV: 'production',
  PORT: '3100',
  HOST: '127.0.0.1',
  APP_URL: baseURL,
  APP_TIMEZONE: TEST_TIME_ZONE,
  DATABASE_URL: dbUrl,
  DATABASE_TLS_INSECURE_OK: 'true',
  BETTER_AUTH_SECRET: 'e2e-only-not-a-secret-e2e-only-not-a-secret',
  APP_ENCRYPTION_KEY: '0'.repeat(64),
  AUTH_EMAIL_PASSWORD: 'true',
  ALLOW_DEMO_FIXTURES: 'true',
  HUNTING_DEMO_MODE: 'true',
  MODEL_PROVIDER: 'openai-compatible',
  OPENAI_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1`,
  OPENAI_MODEL: 'mock-model',
  OPENAI_API_KEY: 'e2e-placeholder',
  LOG_LEVEL: 'warn',
}

export default defineConfig({
  testDir: './tests',
  timeout: 90_000,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  workers: CI ? 1 : undefined,
  globalSetup: './support/global-setup.ts',
  use: {
    baseURL,
    browserName: 'chromium',
    storageState: STORAGE_STATE,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  reporter: CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  webServer: [
    {
      command: 'node support/mock-model.mjs',
      url: `http://127.0.0.1:${MOCK_PORT}/__health`,
      env: { MOCK_MODEL_PORT: String(MOCK_PORT) },
      reuseExistingServer: !CI,
      timeout: 15_000,
    },
    ...(externalApp
      ? []
      : [
          {
            command: 'node_modules/.bin/tsx src/server/cli/migrate.ts && node server.mjs',
            cwd: '../apps/web',
            url: `${baseURL}/readyz`,
            env: appEnv,
            reuseExistingServer: !CI,
            timeout: 120_000,
            stdout: 'pipe' as const,
          },
        ]),
  ],
})
