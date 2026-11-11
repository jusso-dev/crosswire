import { expect, type APIRequestContext, type Page, type TestInfo } from '@playwright/test'

/** Shared e2e helpers (#147). */
export const PASSWORD = 'correct horse battery staple'
export const MOCK = process.env.MOCK_MODEL_URL ?? `http://127.0.0.1:${process.env.MOCK_MODEL_PORT ?? 18099}`
/** Signed-in owner with [DEMO] data loaded, written by global-setup.ts. */
export const STORAGE_STATE = new URL('../.auth/owner.json', import.meta.url).pathname
/** Shared by the managed app server and timestamp assertions. Match an external server's zone. */
export const TEST_TIME_ZONE = process.env.APP_TIMEZONE ?? 'Australia/Sydney'

/** An id unique to this test and attempt, for emails and mock-model holds. */
export function testId(info: TestInfo, tag: string) {
  return `${tag}-${Date.now().toString(36)}-${info.workerIndex}-${info.retry}`
}

/**
 * Sign up a new local user through the UI. Waits for hydration first, and retries when Better Auth's
 * sign-up limit (3 per 10 s per IP) answers 429, so a full suite does not depend on timing.
 */
export async function signUp(page: Page, email: string) {
  await page.goto('/sign-in')
  // Wait for hydration: a click before React attaches its handlers does nothing.
  await page.waitForLoadState('networkidle')
  await page.getByRole('button', { name: 'Create an account' }).click()
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(PASSWORD)
  for (let attempt = 1; ; attempt++) {
    const response = page.waitForResponse((r) => r.url().includes('/api/auth/sign-up/email'))
    await page.getByRole('button', { name: 'Create account' }).click()
    const r = await response
    if (r.status() !== 429 || attempt >= 6) break
    const wait = Number(r.headers()['x-retry-after'] ?? '10')
    await page.waitForTimeout((Number.isFinite(wait) ? wait + 1 : 11) * 1000)
  }
  await page.waitForURL(/\/app/)
  await page.waitForLoadState('networkidle')
}

/** Load [DEMO] fixtures from the control panel. Idempotent: "already loaded" also passes. */
export async function loadDemo(page: Page) {
  await page.goto('/app')
  await page.waitForLoadState('networkidle')
  await page.getByRole('button', { name: 'Load demo data' }).click()
  await expect(page.getByText(/Demo data (loaded|is already loaded)/)).toBeVisible()
}

/** Release a reply the mock model is holding for this test's key. */
export async function releaseMock(request: APIRequestContext, key: string) {
  return (await (await request.post(`${MOCK}/__release?key=${encodeURIComponent(key)}`)).json()) as { released: boolean; count: number }
}

/**
 * Horizontal overflow at the current viewport, measured on the widest visible element, not only on
 * `documentElement.scrollWidth` (#147): `overflow-x: clip` on html/body hides overflow from that
 * measure. Elements inside their own horizontal scroll or clip container (wide grids) are skipped,
 * because they scroll inside that container rather than the page.
 */
export async function horizontalOverflow(page: Page): Promise<{ px: number; culprit: string | null }> {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth
    const contained = (el: Element) => {
      for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
        const ox = getComputedStyle(p).overflowX
        if (ox === 'auto' || ox === 'scroll' || ox === 'hidden' || ox === 'clip') return true
      }
      return false
    }
    let px = Math.max(0, document.documentElement.scrollWidth - window.innerWidth)
    let culprit: string | null = px > 0 ? 'html' : null
    for (const el of Array.from(document.body.querySelectorAll('*'))) {
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) continue
      const s = getComputedStyle(el)
      if (s.visibility === 'hidden' || s.display === 'none' || s.position === 'fixed') continue
      const over = r.right - vw
      if (over > px && !contained(el)) {
        px = over
        culprit = `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${el.classList.length ? `.${Array.from(el.classList).join('.')}` : ''}`
      }
    }
    return { px: Math.round(px), culprit }
  })
}
