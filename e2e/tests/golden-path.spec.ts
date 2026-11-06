import { expect, test } from '@playwright/test'

/**
 * Golden path (#80): local sign-in (stand-in for SSO) -> load [DEMO] fixtures -> watch hit ->
 * hunt with a proposed KQL -> approve & run (demo mode) -> response proposal -> approver dry-run.
 * Asserts the executor never performs a live call: the proposal stays non-executed and the dry
 * run lists planned calls only.
 */
const stamp = Date.now()
const owner = { email: `owner-${stamp}@example.test`, password: 'correct horse battery staple' }

test('SSO stand-in -> watch hit -> hunt proposal -> dry-run approval', async ({ page, request }) => {
  // 1. Sign up (local stand-in for Entra SSO). First user owns a personal workspace.
  await page.goto('/sign-in')
  await page.getByRole('button', { name: 'Create an account' }).click()
  await page.getByLabel('Email').fill(owner.email)
  await page.getByLabel('Password').fill(owner.password)
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
  await expect(page.getByText(/Response safety: dry-run ON/)).toBeVisible()

  // 2. Load the obviously fake demo pack.
  await page.getByRole('button', { name: 'Load demo data' }).click()
  await expect(page.getByText(/Demo data loaded/)).toBeVisible()

  // 3. Watch hit exists.
  await page.getByRole('link', { name: 'Watches', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Recent hits' })).toBeVisible()
  await expect(page.locator('table').last().locator('tbody tr').first()).toBeVisible()

  // 4. Hunt case with a pending KQL proposal: human approves and runs it (demo mode, no tenant).
  await page.getByRole('link', { name: 'Hunts', exact: true }).click()
  await page.getByRole('link', { name: /\[DEMO\] Suspicious PowerShell/ }).click()
  await expect(page.getByText(/Demo mode/)).toBeVisible()
  const pending = page.locator('section.cw-card', { hasText: 'proposed' }).first()
  await pending.getByRole('button', { name: 'Approve and run' }).click()
  await expect(page.locator('ol.cw-timeline')).toContainText('kql_result')

  // 5. Response proposal (Responder, on behalf of this owner): approver dry-run works; approving
  //    your own request is refused (self-approval off by default).
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /Approvals/ }).click()
  await page.getByRole('link', { name: /\[DEMO\] Isolate demo-wks-001/ }).click()
  await expect(page.getByText(/Demo fixture: not a real proposal/)).toBeVisible()
  await page.getByRole('button', { name: 'Dry run' }).click()
  await expect(page.getByRole('heading', { name: 'Last dry run' })).toBeVisible()
  await expect(page.locator('pre').filter({ hasText: '"mode": "dry-run"' })).toBeVisible()
  await page.getByRole('button', { name: 'Approve' }).click()
  await expect(page.getByRole('alert')).toContainText(/self-approval is off/)

  // 6. No live executor ran: status is still pending and there is no execution record.
  await expect(page.locator('main.cw-content .cw-badge').first()).toHaveText('pending')
  await expect(page.getByRole('heading', { name: 'Execution' })).toHaveCount(0)

  // 7. Unauthenticated API stays closed.
  const res = await request.get('/api/me', { headers: { cookie: '' } })
  expect([401, 403]).toContain(res.status())
})
