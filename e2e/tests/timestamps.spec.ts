import { expect, test } from '@playwright/test'
import { horizontalOverflow, TEST_TIME_ZONE } from '../support/helpers'

test.use({ hasTouch: true })

test('exact freshness times are available by keyboard and touch (#161)', async ({ page }, info) => {
  await page.goto('/app/hunts')
  await page.waitForLoadState('networkidle')
  const freshness = page.locator('.cw-fresh').first()
  const toggle = freshness.getByRole('button')
  await expect(toggle).toBeVisible()
  const iso = await freshness.locator('time').first().getAttribute('datetime')
  const expected = new Date(iso!).toLocaleString('en-AU', {
    day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short', timeZone: TEST_TIME_ZONE,
  })
  const exact = freshness.locator('.cw-fresh-exact')
  await expect(exact).toBeHidden()
  await toggle.focus()
  await page.keyboard.press('Enter')
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await expect(exact).toBeVisible()
  await expect(exact).toHaveText(expected)
  await info.attach('exact-time-desktop', { body: await freshness.screenshot(), contentType: 'image/png' })
  await page.keyboard.press('Space')
  await expect(exact).toBeHidden()
  await expect(toggle).toBeFocused()

  await page.setViewportSize({ width: 390, height: 844 })
  await toggle.tap()
  await expect(exact).toBeVisible()
  await expect(exact).toHaveText(expected)
  const overflow = await horizontalOverflow(page)
  expect(overflow.px, `Overflow from ${overflow.culprit}`).toBeLessThanOrEqual(1)
  await info.attach('exact-time-narrow', { body: await page.screenshot(), contentType: 'image/png' })
})
