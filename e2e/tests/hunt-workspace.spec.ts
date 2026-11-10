import { expect, test, type Page } from '@playwright/test'
import { horizontalOverflow } from '../support/helpers'

/**
 * Hunt workspace interactions (design.md §4): keyboard row navigation, inspector, URL-kept filters
 * and selection across reload and back/forward, theme persistence, and narrow layout.
 * Uses the shared owner with [DEMO] fixtures from global-setup.ts (read-only on that data).
 */
async function openDemoHunt(page: Page) {
  await page.goto('/app/hunts')
  await page.waitForLoadState('networkidle')
  await page.getByRole('link', { name: /\[DEMO\] Suspicious PowerShell/ }).first().click()
  await page.waitForURL(/\/app\/hunts\/[^/?]+/)
}

test('hunt workspace: keyboard, inspector, filters, history, theme', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await openDemoHunt(page)

  // Demo data is labelled at the result, not only in a banner.
  await expect(page.getByText('Demo data').first()).toBeVisible()

  // Open the search that ran; its sample renders in the grid.
  await page.locator('.cw-qitem', { hasText: 'Ran' }).first().click()
  const grid = page.getByRole('table', { name: /sample rows/ })
  await expect(grid).toBeVisible()
  await expect(page.getByText(/Showing a stored sample of 20 of 1500 rows/)).toBeVisible()

  // Keyboard: Enter opens the inspector, j/k move from the grid or the inspector.
  await grid.locator('tbody tr').first().focus()
  await page.keyboard.press('Enter')
  const inspector = page.getByRole('complementary', { name: 'Row 1' })
  await expect(inspector).toBeVisible()
  await expect(page).toHaveURL(/row=0/)
  await page.keyboard.press('j')
  await page.keyboard.press('j')
  await expect(page).toHaveURL(/row=2/)
  await expect(page.getByRole('complementary', { name: 'Row 3' })).toBeVisible()
  await page.keyboard.press('k')
  await expect(page).toHaveURL(/row=1/)

  // Raw JSON view of the record, with provenance.
  await page.getByRole('button', { name: 'Raw JSON' }).click()
  await expect(page.getByLabel('Raw record')).toContainText('"DeviceName"')
  await expect(page.getByRole('complementary', { name: 'Row 2' })).toContainText('Provenance')
  await page.getByRole('button', { name: 'Fields' }).click()

  // Pivot: show only this device. The filter is a removable chip and lives in the URL.
  const inspectedUrl = page.url()
  await page.getByRole('button', { name: /Show only rows where DeviceName is demo-wks-002/ }).click()
  await expect(page.locator('.cw-filterchip')).toHaveCount(1)
  await expect(page).toHaveURL(/f=eq%3ADeviceName%3Ddemo-wks-002/)
  await expect(page.getByText(/4 of 20 sample rows match the filters/)).toBeVisible()

  // Reload keeps the filter; Back returns to exactly the unfiltered, inspected view.
  await page.reload()
  await expect(page.locator('.cw-filterchip')).toHaveCount(1)
  await page.goBack()
  await expect(page).toHaveURL(inspectedUrl)
  await expect(page.getByRole('complementary', { name: 'Row 2' })).toBeVisible()
  await expect(page.locator('.cw-filterchip')).toHaveCount(0)

  // Clear the filter from the chip.
  await page.goForward()
  await page.getByRole('button', { name: /Remove filter DeviceName/ }).click()
  await expect(page.locator('.cw-filterchip')).toHaveCount(0)

  // Evidence timeline filter is kept in the URL too.
  await page.getByRole('group', { name: 'Show in timeline' }).getByRole('button', { name: 'Results' }).click()
  await expect(page).toHaveURL(/tl=results/)
  await expect(page.locator('.cw-timeline li')).toHaveCount(1)

  // Theme choice persists across reload.
  await page.getByLabel('Theme').selectOption('dark')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
})

test('hunt workspace: long values and narrow width stay usable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await openDemoHunt(page)
  await page.locator('.cw-qitem', { hasText: 'Ran' }).first().click()
  // No horizontal page scroll: wide grids scroll inside their own container.
  const overflow = await horizontalOverflow(page)
  expect(overflow.px, `overflow caused by ${overflow.culprit}`).toBeLessThanOrEqual(1)
  // At narrow widths the inspector is a modal dialog: focus moves in, cannot leave, and returns on close.
  const grid = page.getByRole('table', { name: /sample rows/ })
  await grid.locator('tbody tr').first().click()
  const dialog = page.getByRole('dialog', { name: 'Row 1' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('heading', { name: 'Row 1' })).toBeFocused()
  for (const key of ['Shift+Tab', 'Tab', 'Tab', 'Tab']) {
    await page.keyboard.press(key)
    await expect(dialog.locator(':focus')).toHaveCount(1) // focus stays inside the dialog
  }
  // Step to the next row, then close: focus lands on the row that was showing.
  await dialog.getByRole('button', { name: 'Next row' }).click()
  await expect(page.getByRole('dialog', { name: 'Row 2' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(grid.locator('tbody tr[data-index="1"]')).toBeFocused()
})

test('hunt workspace: at 1000px the inspector overlay keeps focus and the background inert', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 800 })
  await openDemoHunt(page)
  await page.locator('.cw-qitem', { hasText: 'Ran' }).first().click()
  const grid = page.getByRole('table', { name: /sample rows/ })
  await grid.locator('tbody tr').first().click()
  const dialog = page.getByRole('dialog', { name: 'Row 1' })
  await expect(dialog.getByRole('heading', { name: 'Row 1' })).toBeFocused()
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('Tab')
    await expect(dialog.locator(':focus')).toHaveCount(1)
  }
  // The exposed background does not take focus or clicks while the overlay is open.
  await expect(page.locator('.cw-ws-main')).toHaveAttribute('inert', '')
  await dialog.getByRole('button', { name: 'Close inspector' }).click()
  await expect(page.locator('.cw-ws-main')).not.toHaveAttribute('inert', '')
  await expect(grid.locator('tbody tr[data-index="0"]')).toBeFocused()
})
