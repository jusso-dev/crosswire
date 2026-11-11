import { chromium, type FullConfig } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { loadDemo, signUp, STORAGE_STATE } from './helpers'

/**
 * Create one owner with [DEMO] data and save its session (#147). Specs reuse it through
 * storageState instead of each signing up, which tripped Better Auth's sign-up rate limit.
 * Specs that change shared demo state (approvals, searches) still create their own user.
 */
export default async function globalSetup(config: FullConfig) {
  const baseURL = config.projects[0]?.use.baseURL ?? 'http://localhost:3000'
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({ baseURL })
    await signUp(page, `owner-${Date.now().toString(36)}@example.test`)
    await loadDemo(page)
    mkdirSync(path.dirname(STORAGE_STATE), { recursive: true })
    await page.context().storageState({ path: STORAGE_STATE })
  } finally {
    await browser.close()
  }
}
