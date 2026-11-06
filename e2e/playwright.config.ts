import { defineConfig } from '@playwright/test'

/**
 * Golden-path E2E (#80). Runs locally / on demand only (the project keeps e2e out of PR CI).
 * Needs a running app with demo fixtures support and an empty-ish database:
 *   BASE_URL=http://localhost:3000 pnpm --filter e2e test:e2e
 * Each run signs up one new user; Better Auth rate-limits sign-ups per IP, so wait about a minute
 * between back-to-back runs (a 429 on sign-up is the limiter working, not a product bug).
 * On failure, traces and screenshots land in e2e/test-results (attach to the ship-gate ticket #84).
 */
export default defineConfig({
  testDir: './tests',
  timeout: 90_000,
  retries: 0,
  use: {
    baseURL: process.env.BASE_URL ?? 'http://localhost:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  reporter: [['list']],
})
