import { expect, test } from '@playwright/test'
import { signUp, testId } from '../support/helpers'

/**
 * Golden path (#80): local sign-in (stand-in for SSO) -> load [DEMO] fixtures -> watch hit ->
 * hunt with a proposed KQL -> approve & run (demo mode) -> response proposal -> approver dry-run.
 * Asserts the executor never performs a live call: the proposal stays non-executed and the dry
 * run lists planned calls only. Signs up its own user: it approves the demo search, which would
 * change the shared owner's data for other specs.
 */
test.use({ storageState: { cookies: [], origins: [] } })

test('SSO stand-in -> watch hit -> hunt proposal -> dry-run approval', async ({ page, request }, info) => {
  // 1. Sign up (local stand-in for Entra SSO). First user owns a personal workspace.
  await signUp(page, `${testId(info, 'golden')}@example.test`)
  await expect(page.getByRole('heading', { name: /^Good (morning|afternoon|evening)/ })).toBeVisible()
  // Safety lamp and its words come from one value (#165): safe mode means dry run on, nothing live.
  await expect(page.locator('.cw-lamp')).toHaveText('Safe mode on')

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
  await expect(page.getByText(/labelled demo rows/)).toBeVisible()
  // The fixture already has one result, so assert a NEW one appears and the search reaches "Ran".
  const results = page.locator('ol.cw-timeline li', { hasText: 'Search results' })
  const before = await results.count()
  const pending = page.locator('section.cw-panel2', { hasText: 'Review this search' }).first()
  await pending.getByRole('button', { name: 'Approve and run' }).click()
  await expect(results).toHaveCount(before + 1)
  await expect(page.locator('.cw-qitem', { hasText: 'SecurityEvent' }).getByText('Ran')).toBeVisible()

  // 5. Response proposal (Responder, on behalf of this owner): approver dry-run works; approving
  //    your own request is refused (self-approval off by default).
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /Approvals/ }).click()
  await page.getByRole('link', { name: /\[DEMO\] Isolate demo-wks-001/ }).click()
  await expect(page.getByText(/Demo fixture, not a real request/)).toBeVisible()
  await page.getByRole('button', { name: 'Dry run' }).click()
  await expect(page.getByRole('heading', { name: 'Last dry run' })).toBeVisible()
  const dry = page.getByRole('region', { name: 'Last dry run' })
  await expect(dry.getByText('Dry run', { exact: true })).toBeVisible()
  await dry.getByText('Raw record').click()
  await expect(dry.locator('pre').filter({ hasText: '"mode": "dry-run"' })).toBeVisible()
  // The requester cannot approve their own action: the screen says why and offers no Approve
  // button. The server refusal itself is covered in apps/web/test/ui-polish.test.ts.
  await expect(page.getByText('You cannot approve this one')).toBeVisible()
  await expect(page.getByRole('button', { name: /^Approve/ })).toHaveCount(0)

  // 6. No live executor ran: status is still pending and there is no execution record.
  await expect(page.locator('main.cw-content .cw-badge').first()).toHaveText(/pending/i)
  await expect(page.getByRole('heading', { name: 'Execution' })).toHaveCount(0)

  // 7. Unauthenticated API stays closed.
  const res = await request.get('/api/me', { headers: { cookie: '' } })
  expect([401, 403]).toContain(res.status())
})
