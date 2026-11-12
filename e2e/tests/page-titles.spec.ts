import { expect, test, type Page } from '@playwright/test'

/** Browser-visible titles, including nested route overrides and client-side history (#173). */
async function title(page: Page, expected: string) {
  await expect(page).toHaveTitle(`${expected} · Crosswire`)
  await expect(page.locator('head title')).toHaveCount(1)
}

test('main pages update their browser title during navigation and history', async ({ page }) => {
  await page.goto('/app')
  await page.waitForLoadState('networkidle')
  await title(page, 'Control panel')
  await page.evaluate(() => { (window as Window & { __titleProbe?: boolean }).__titleProbe = true })
  const nav = page.getByRole('navigation', { name: 'Main', exact: true })
  const destinations: Array<[RegExp, string]> = [
    [/^Watches$/, 'Watches'],
    [/^Daily digests$/, 'Daily digests'],
    [/^Hunts$/, 'Hunts'],
    [/^Ask an agent$/, 'Ask an agent'],
    [/^Approvals/, 'Approvals'],
    // The link name gains a badge ("Agents 1 running") while another spec has a run going.
    [/^Agents(\s|$)/, 'Agents'],
    [/^Settings$/, 'Settings'],
  ]
  for (const [link, expected] of destinations) {
    await nav.getByRole('link', { name: link }).click()
    await title(page, expected)
    // A full document reload would hide client-side head-update bugs.
    expect(await page.evaluate(() => (window as Window & { __titleProbe?: boolean }).__titleProbe)).toBe(true)
  }
  await page.goBack()
  await title(page, 'Agents')
  await page.goForward()
  await title(page, 'Settings')
})

test('hunt, approval and intel detail titles use their loaded record', async ({ page }) => {
  await page.goto('/app/hunts')
  await page.waitForLoadState('networkidle')
  await page.getByRole('link', { name: '[DEMO] Suspicious PowerShell on demo workstations', exact: true }).click()
  await title(page, '[DEMO] Suspicious PowerShell on demo workstations · Hunt')
  const nav = page.getByRole('navigation', { name: 'Main', exact: true })
  await nav.getByRole('link', { name: /^Approvals/ }).click()
  await title(page, 'Approvals')
  await page.getByRole('link', { name: /\[DEMO\] Isolate/ }).first().click()
  await title(page, '[DEMO] Isolate demo-wks-001 · Approval')
  await page.goBack()
  await title(page, 'Approvals')
  await page.goForward()
  await title(page, '[DEMO] Isolate demo-wks-001 · Approval')
  await page.goto('/app/intel/CVE-2024-27834')
  await title(page, 'CVE-2024-27834 · Intel')
})

test('sign-in and email-confirmation titles do not expose URL details', async ({ browser, page }) => {
  const anon = await browser.newContext({ storageState: { cookies: [], origins: [] } })
  try {
    const signedOut = await anon.newPage()
    await signedOut.goto('/sign-in?returnTo=%2Fapp%2Fsettings')
    await title(signedOut, 'Sign in')
    await signedOut.goto('/auth-error?error=invalid_code&error_description=synthetic-private-detail')
    await title(signedOut, 'Sign-in problem')
  } finally {
    await anon.close()
  }
  // Invalid test token only previews an expired link; it cannot change an email destination.
  await page.goto('/app/settings/digest-email/confirm?token=synthetic-private-token')
  await title(page, 'Confirm digest email')
})
