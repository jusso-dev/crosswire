import { expect, test, type Page } from '@playwright/test'
import { horizontalOverflow, testId } from '../support/helpers'

/**
 * Hunt workspace interactions (design.md §4): keyboard row navigation, inspector, URL-kept filters
 * and selection across reload and back/forward, theme persistence, and narrow layout.
 * Uses the shared owner with [DEMO] fixtures from global-setup.ts. Existing fixture data stays
 * read-only; the state-isolation test creates one additional empty hunt.
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

  // The named scroll region is keyboard reachable; modified arrow keys stay with the browser.
  const region = page.getByRole('region', { name: 'Result rows', exact: true })
  await region.focus()
  await expect(region).toBeFocused()
  const firstRow = grid.locator('tbody tr').first()
  await firstRow.focus()
  const beforeInspecting = page.url()
  for (const key of ['Control+ArrowDown', 'Meta+ArrowDown', 'Alt+ArrowDown']) {
    await page.keyboard.press(key)
    await expect(firstRow).toBeFocused()
    await expect(page).toHaveURL(beforeInspecting)
    await expect(page.getByRole('complementary', { name: 'Row 1' })).toBeHidden()
  }

  // Keyboard: Enter opens the inspector, j/k move from the grid or the inspector.
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

  // Modified inspector keys cannot step rows. Both desktop close paths return focus to the row.
  const secondRow = grid.locator('tbody tr[data-index="1"]')
  const secondInspector = page.getByRole('complementary', { name: 'Row 2' })
  await secondInspector.getByRole('heading', { name: 'Row 2' }).focus()
  for (const key of ['Control+ArrowDown', 'Meta+ArrowDown', 'Alt+ArrowDown']) {
    await page.keyboard.press(key)
    await expect(page).toHaveURL(/row=1/)
    await expect(secondInspector).toBeVisible()
  }
  await page.keyboard.press('Escape')
  await expect(secondInspector).toBeHidden()
  await expect(secondRow).toBeFocused()
  await page.keyboard.press('Enter')
  await secondInspector.getByRole('button', { name: 'Close inspector' }).click()
  await expect(secondInspector).toBeHidden()
  await expect(secondRow).toBeFocused()
  await page.keyboard.press('Enter')

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
  // The same text is also the table caption for screen readers (#163), so check the visible line.
  await expect(page.locator('span.cw-muted', { hasText: /4 of 20 sample rows match the filters/ })).toBeVisible()

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
  const inspectingUrl = page.url()
  // An ARIA modal owns the keyboard just like a native confirmation (#163).
  for (const key of ['g', 'w', '/', 'Shift+Slash', 'Control+k', 'Meta+k']) {
    await page.keyboard.press(key)
    await expect(dialog.getByRole('heading', { name: 'Row 1' })).toBeFocused()
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeHidden()
    await expect(page.getByRole('heading', { name: 'Keyboard shortcuts' })).toBeHidden()
  }
  await page.waitForLoadState('networkidle')
  await expect(page).toHaveURL(inspectingUrl)
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

test('hunt notes, search drafts and confirmations reset between records (#125)', async ({ page }, info) => {
  const secondTitle = `State isolation ${testId(info, 'hunt')}`
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/app/hunts')
  await page.waitForLoadState('networkidle')
  await page.getByRole('button', { name: /Blank hunt and saved playbooks$/ }).click()
  await page.getByRole('button', { name: /Start a new hunt$/ }).click()
  await page.getByLabel(/^Name the hunt/).fill(secondTitle)
  await page.getByRole('button', { name: 'Start hunt', exact: true }).click()
  await page.waitForURL(/\/app\/hunts\/[^/?]+/)
  const secondUrl = page.url()

  await page.keyboard.press('ControlOrMeta+k')
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  await palette.getByRole('combobox').fill('Suspicious PowerShell')
  await palette.getByRole('option', { name: /Suspicious PowerShell/ }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('[DEMO] Suspicious PowerShell on demo workstations')
  const firstUrl = page.url()
  await page.evaluate(() => { (window as Window & { __routeStateProbe?: boolean }).__routeStateProbe = true })
  const note = page.getByLabel(/^Add a note/)
  const propose = page.getByRole('button', { name: /Propose a new search$/ })
  const kql = page.getByLabel('KQL', { exact: true })
  await note.fill('Keep this note on the first hunt')
  await propose.click()
  await kql.fill('DeviceInfo | take 7')
  await page.getByRole('combobox', { name: 'Search in', exact: true }).selectOption('sentinel')

  await page.keyboard.press('ControlOrMeta+k')
  await palette.getByRole('combobox').fill(secondTitle)
  await palette.getByRole('option', { name: new RegExp(secondTitle) }).click()
  await expect(page).toHaveURL(secondUrl)
  await expect(note).toHaveValue('')
  await expect(propose).toHaveAttribute('aria-expanded', 'false')
  await propose.click()
  await expect(kql).toHaveValue('')
  await expect(page.getByRole('combobox', { name: 'Search in', exact: true })).toHaveValue('defender')
  await note.fill('Keep this note on the second hunt')
  await kql.fill('DeviceInfo | take 9')
  await page.getByRole('button', { name: 'Close hunt…', exact: true }).click()
  await expect(page.getByRole('alertdialog')).toBeVisible()

  await page.goBack()
  await expect(page).toHaveURL(firstUrl)
  await expect(note).toHaveValue('')
  await expect(page.getByRole('alertdialog')).toBeHidden()
  await expect(propose).toHaveAttribute('aria-expanded', 'false')
  await propose.click()
  await expect(kql).toHaveValue('')
  await page.goForward()
  await expect(page).toHaveURL(secondUrl)
  await expect(note).toHaveValue('')
  await expect(page.getByRole('alertdialog')).toBeHidden()
  await expect(propose).toHaveAttribute('aria-expanded', 'false')
  expect(await page.evaluate(() => (window as Window & { __routeStateProbe?: boolean }).__routeStateProbe)).toBe(true)
})
