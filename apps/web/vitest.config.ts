import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    pool: 'forks',
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: { NODE_ENV: 'test', LOG_LEVEL: 'error', APP_ENCRYPTION_KEY: '0'.repeat(64), BETTER_AUTH_SECRET: 'test-secret-test-secret-test-secret-123' },
  },
})
