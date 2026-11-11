import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { loadDemo, releaseMock, signUp, testId } from '../support/helpers'

/**
 * UI polish pass: command palette, shortcuts, run view with Stop, chat to run link, and the
 * approval confirmation. Uses the mock model started by playwright.config.ts. The first test uses
 * the shared owner from global-setup.ts; the second creates its own users because it approves.
 */
test('palette, shortcuts, run view with Stop, and a deliberate approval', async ({ page, request }, info) => {
  test.setTimeout(150_000)
  const key = testId(info, 'polish')
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/app')
  await page.waitForLoadState('networkidle')

  // First-run checklist is there and can be hidden; it stays hidden after reload.
  await expect(page.getByRole('heading', { name: 'Get started' })).toBeVisible()
  await page.getByRole('button', { name: 'Hide checklist' }).click()
  await page.reload()
  await page.waitForLoadState('networkidle')
  await expect(page.getByRole('heading', { name: 'Get started' })).toHaveCount(0)

  // Command palette: Cmd/Ctrl+K, type, Enter opens the item.
  await page.keyboard.press('ControlOrMeta+k')
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  await expect(palette).toBeVisible()
  await palette.getByRole('combobox').fill('suspicious powershell')
  await expect(palette.getByRole('option', { name: /Suspicious PowerShell/ })).toBeVisible()
  await page.keyboard.press('Enter')
  await page.waitForURL(/\/app\/hunts\/.+/)
  await expect(palette).toBeHidden()

  // Shortcuts: ? opens the sheet, Esc closes; g a goes to approvals; keys do nothing while typing.
  await page.keyboard.press('Shift+Slash')
  await expect(page.getByRole('heading', { name: 'Keyboard shortcuts' })).toBeVisible()
  await expect(page.getByText(/No shortcut approves, rejects, executes or stops anything/)).toBeVisible()
  await page.keyboard.press('Escape')
  await page.keyboard.press('g')
  await page.keyboard.press('a')
  await page.waitForURL(/\/app\/approvals/)
  await page.goto('/app/agents?view=log')
  await page.waitForLoadState('networkidle')
  await page.keyboard.press('/')
  const logSearch = page.getByPlaceholder('Search the whole log')
  await expect(logSearch).toBeFocused()
  await logSearch.type('ga')
  await expect(page).toHaveURL(/view=log/)

  // Approval: the requester sees why they cannot approve. Dry run still works.
  await page.goto('/app/approvals')
  await page.getByRole('link', { name: /\[DEMO\] Isolate/ }).first().click()
  await expect(page.getByRole('heading', { name: 'What your decision is bound to' })).toBeVisible()
  await expect(page.getByText('Matches the stored content')).toBeVisible()
  await expect(page.getByText('You cannot approve this one')).toBeVisible()
  await expect(page.getByRole('button', { name: /^Approve/ })).toHaveCount(0)
  for (const q of ['1. What will happen', '2. To what', '3.', '4. Who asked', '5. What the dry run showed', '6. How to roll back', '7. When it expires']) {
    await expect(page.locator('.cw-answers h2', { hasText: q }).first()).toBeVisible()
  }

  // Chat: a live run shows status and Stop; stopping ends the run as Stopped.
  await page.goto('/app/chat')
  await page.waitForLoadState('networkidle')
  await page.getByRole('button', { name: /Chat with Intel/ }).click()
  await page.waitForURL(/\/app\/chat\/.+/)
  await page.getByRole('textbox', { name: /Message to Intel/ }).fill(`What is new for Fortinet? [t:${key}]`)
  await page.keyboard.press('Enter')
  const bar = page.locator('.cw-livebar')
  await expect(bar).toContainText('Intel is working', { timeout: 30_000 })
  await expect(bar.getByText('Running', { exact: true })).toBeVisible({ timeout: 15_000 })
  await bar.getByRole('button', { name: 'Stop run' }).click()
  // Confirmation lands on the safe choice: keep the run going.
  await expect(bar.getByRole('button', { name: 'Keep running' })).toBeFocused()
  await bar.getByRole('button', { name: 'Yes, stop it' }).click()
  await releaseMock(request, key)
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible({ timeout: 20_000 })

  // The reply links to its run; the run view shows status, steps and the stop.
  await page.reload()
  await page.waitForLoadState('networkidle')
  await page.getByRole('link', { name: 'Run and steps' }).last().click()
  await page.waitForURL(/view=runs/)
  const panel = page.getByRole('region', { name: /Intel run/ })
  // The run view refreshes every two seconds while a run is live, so the end state arrives on its own.
  await expect(panel.locator('.cw-runstatus')).toHaveText(/Stopped|Completed/, { timeout: 20_000 })
  await expect(panel.getByRole('list', { name: 'Run steps, oldest first' })).toContainText('Started')
  await expect(panel.locator('.cw-timeline .cw-ev-label', { hasText: /Stop requested|Stopped|Completed/ }).first()).toBeVisible()
  await expect(panel.getByText('intel-compare v1')).toBeVisible()

  // Filters: status narrows the list.
  await page.getByLabel('Status').selectOption('failed')
  await expect(page.getByText('No runs match these filters')).toBeVisible()

  // Skills and review views render.
  await page.getByRole('navigation', { name: 'Agent views' }).getByRole('link', { name: 'Skills' }).click()
  await expect(page.getByRole('heading', { name: 'hunt-read-only' })).toBeVisible()
  await page.getByRole('navigation', { name: 'Agent views' }).getByRole('link', { name: /Review/ }).click()
  await expect(page.getByRole('heading', { name: /Held for review/ })).toBeVisible()
})

test('a second approver approves through a confirmation that names the target', async ({ browser }, info) => {
  test.setTimeout(120_000)
  // No invite flow exists in the UI, so this check runs only when the test can make a second
  // approver in the same org through PG_E2E_URL (the disposable database). Skipped otherwise,
  // before any set-up work runs.
  const url = process.env.PG_E2E_URL
  test.skip(!url, 'Set PG_E2E_URL to the disposable database to add a second approver.')

  // Owner loads demo data; the demo action is requested on the owner's behalf.
  const ownerEmail = `${testId(info, 'polish-owner')}@example.test`
  const approverEmail = `${testId(info, 'polish-approver')}@example.test`
  const signedOut = { storageState: { cookies: [], origins: [] } }
  const ownerCtx = await browser.newContext(signedOut)
  const owner = await ownerCtx.newPage()
  await signUp(owner, ownerEmail)
  await loadDemo(owner)
  await ownerCtx.close()
  // Reuse the web app's postgres client rather than adding a dependency to the e2e package.
  type Sql = ((strings: TemplateStringsArray, ...values: unknown[]) => Promise<Array<Record<string, string>>>) & { end(): Promise<void> }
  const mod = createRequire(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../apps/web/package.json'))('postgres') as { default?: unknown }
  const postgres = (mod.default ?? mod) as (url: string) => Sql
  const sql = postgres(url!)
  try {
    const approverCtx = await browser.newContext(signedOut)
    const page = await approverCtx.newPage()
    await signUp(page, approverEmail)
    const [o] = await sql`select m.org_id from org_memberships m join "user" u on u.id = m.user_id where u.email = ${ownerEmail}`
    const [a] = await sql`select id from "user" where email = ${approverEmail}`
    await sql`insert into org_memberships (id, org_id, user_id, role) values (${crypto.randomUUID()}, ${o!.org_id}, ${a!.id}, 'approver')`
    await sql`delete from org_memberships where user_id = ${a!.id} and org_id <> ${o!.org_id}`
    // A second valid fixture differs only in identity and creation time. The content hash stays
    // valid because none of the approved content changes. Both records remain in this test's org.
    const [original] = await sql`select id from response_proposals where org_id = ${o!.org_id} and status = 'pending'`
    const secondId = crypto.randomUUID()
    await sql`insert into response_proposals
      select (jsonb_populate_record(null::response_proposals,
        to_jsonb(p) || jsonb_build_object('id', ${secondId}::text, 'created_at', p.created_at + interval '1 second'))).*
      from response_proposals p where p.id = ${original!.id}`
    await page.goto(`/app/approvals/${original!.id}`)
    await page.waitForLoadState('networkidle')
    const originalUrl = page.url()
    await page.evaluate(() => { (window as Window & { __routeStateProbe?: boolean }).__routeStateProbe = true })
    const comment = page.getByPlaceholder('Why you approve or reject')
    await comment.fill('Comment for the first proposal only')
    await page.keyboard.press('ControlOrMeta+k')
    const navigationPalette = page.getByRole('dialog', { name: 'Command palette' })
    await navigationPalette.getByRole('combobox').fill('[DEMO] Isolate demo-wks-001')
    const options = navigationPalette.getByRole('option', { name: /Approvals waiting/ })
    await expect(options).toHaveCount(2)
    // Palette orders newest first, so this selects the clone without leaving the detail route.
    await options.first().click()
    await expect(page).toHaveURL(new RegExp(`/app/approvals/${secondId}$`))
    await expect(comment).toHaveValue('')
    await expect(page.getByRole('alertdialog')).toBeHidden()
    await comment.fill('Comment for the second proposal only')
    await page.getByRole('button', { name: 'Reject…', exact: true }).click()
    await expect(page.getByRole('alertdialog')).toBeVisible()
    // Browser Back can change records while a modal is open, even though shortcuts cannot (#125).
    await page.goBack()
    await expect(page).toHaveURL(originalUrl)
    await expect(comment).toHaveValue('')
    await expect(page.getByRole('alertdialog')).toBeHidden()
    await page.goForward()
    await expect(page).toHaveURL(new RegExp(`/app/approvals/${secondId}$`))
    await expect(comment).toHaveValue('')
    await expect(page.getByRole('alertdialog')).toBeHidden()
    await page.goBack()
    await expect(page).toHaveURL(originalUrl)
    expect(await page.evaluate(() => (window as Window & { __routeStateProbe?: boolean }).__routeStateProbe)).toBe(true)
    await page.getByRole('button', { name: 'Approve…' }).click()
    const confirm = page.getByRole('alertdialog')
    await expect(confirm).toContainText('Approve "[DEMO] Isolate demo-wks-001"?')
    await expect(confirm).toContainText('demo-wks-001')
    // Confirmation owns the keyboard: no navigation, search, help or palette over it (#127).
    const approvalUrl = page.url()
    const approve = page.getByRole('button', { name: 'Approve…', exact: true })
    const cancel = confirm.getByRole('button', { name: 'Cancel', exact: true })
    await expect(cancel).toBeFocused()
    for (const key of ['g', 'w', '/', 'Shift+Slash', 'Control+k', 'Meta+k']) {
      await page.keyboard.press(key)
      await expect(confirm).toBeVisible()
      await expect(cancel).toBeFocused()
      await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeHidden()
      await expect(page.getByRole('heading', { name: 'Keyboard shortcuts' })).toBeHidden()
    }
    await page.waitForLoadState('networkidle')
    await expect(page).toHaveURL(approvalUrl)

    // Tab moves between dialog actions. At a boundary Chromium may focus browser chrome,
    // represented by body, but must never reach a background control.
    await page.keyboard.press('Tab')
    await expect(confirm.getByRole('button', { name: /Approve demo-wks-001/ })).toBeFocused()
    await page.keyboard.press('Shift+Tab')
    await expect(cancel).toBeFocused()
    for (const key of ['Shift+Tab', 'Shift+Tab', 'Tab', 'Tab', 'Tab']) {
      await page.keyboard.press(key)
      expect(await page.evaluate(() => {
        const active = document.activeElement
        return active === document.body || Boolean(active?.closest('dialog[open][role="alertdialog"]'))
      })).toBe(true)
    }
    await cancel.focus()
    await approve.evaluate((button) => button.focus())
    await expect(cancel).toBeFocused() // native modal prevents focus moving into the background
    await page.keyboard.press('Escape')
    await expect(confirm).toBeHidden()
    await expect(approve).toBeFocused()

    // Enter on a newly opened confirmation cancels. Explicit Cancel also restores the opener.
    await approve.click()
    await expect(cancel).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(confirm).toBeHidden()
    await expect(approve).toBeFocused()
    const reject = page.getByRole('button', { name: 'Reject…', exact: true })
    await reject.click()
    await expect(cancel).toBeFocused()
    await cancel.click()
    await expect(reject).toBeFocused()

    // Palette still opens once confirmation has closed, including from a text field.
    await page.getByPlaceholder('Why you approve or reject').focus()
    await page.keyboard.press('ControlOrMeta+k')
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible()
    await page.keyboard.press('Escape')
    await approve.click()
    await confirm.getByRole('button', { name: /Approve demo-wks-001/ }).click()
    await expect(page.getByLabel('Action context').getByText('Approved', { exact: true })).toBeVisible()
    await approverCtx.close()
  } finally {
    await sql.end()
  }
})
