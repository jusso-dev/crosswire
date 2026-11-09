import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'

/**
 * UI polish pass: command palette, shortcuts, run view with Stop, chat to run link, and the
 * approval confirmation. Needs the app with demo fixtures and the mock model
 * (e2e/support/mock-model.mjs, MODEL_PROVIDER=openai-compatible). See chat.spec.ts for setup.
 */
const stamp = Date.now()
const MOCK = process.env.MOCK_MODEL_URL ?? 'http://127.0.0.1:18099'

async function signUp(page: Page, tag: string) {
  await page.goto('/sign-in')
  await page.waitForLoadState('networkidle')
  await page.getByRole('button', { name: 'Create an account' }).click()
  await page.getByLabel('Email').fill(`${tag}-${stamp}@example.test`)
  await page.getByLabel('Password').fill('correct horse battery staple')
  await page.getByRole('button', { name: 'Create account' }).click()
  await page.waitForURL(/\/app/)
  await page.waitForLoadState('networkidle')
}

test('palette, shortcuts, run view with Stop, and a deliberate approval', async ({ page, request }) => {
  test.setTimeout(150_000)
  await page.setViewportSize({ width: 1280, height: 900 })
  await signUp(page, 'polish')
  await page.getByRole('button', { name: 'Load demo data' }).click()
  await expect(page.getByText(/Demo data loaded/)).toBeVisible()

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
  await page.getByRole('textbox', { name: /Message to Intel/ }).fill('What is new for Fortinet?')
  await page.keyboard.press('Enter')
  const bar = page.locator('.cw-livebar')
  await expect(bar).toContainText('Intel is working', { timeout: 30_000 })
  await expect(bar.getByText('Running')).toBeVisible({ timeout: 15_000 })
  await bar.getByRole('button', { name: 'Stop run' }).click()
  // Confirmation lands on the safe choice.
  await expect(bar.getByRole('button', { name: 'Yes, stop it' })).toBeFocused()
  await bar.getByRole('button', { name: 'Yes, stop it' }).click()
  await request.post(`${MOCK}/__release`)
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

test('a second approver approves through a confirmation that names the target', async ({ browser }) => {
  test.setTimeout(120_000)
  // Owner loads demo data; the demo action is requested on the owner's behalf.
  const ownerCtx = await browser.newContext()
  const owner = await ownerCtx.newPage()
  await signUp(owner, 'polish-owner')
  await owner.getByRole('button', { name: 'Load demo data' }).click()
  await expect(owner.getByText(/Demo data loaded/)).toBeVisible()
  const ownerEmail = `polish-owner-${stamp}@example.test`
  await ownerCtx.close()

  // No invite flow exists in the UI, so this check runs only when the test can make a second
  // approver in the same org through PG_E2E_URL (the disposable database). Skipped otherwise.
  const url = process.env.PG_E2E_URL
  test.skip(!url, 'Set PG_E2E_URL to the disposable database to add a second approver.')
  // Reuse the web app's postgres client rather than adding a dependency to the e2e package.
  const postgres = createRequire(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../apps/web/package.json'))('postgres') as typeof import('postgres')
  const sql = postgres(url!)
  try {
    const approverCtx = await browser.newContext()
    const page = await approverCtx.newPage()
    await signUp(page, 'polish-approver')
    const [o] = await sql`select m.org_id from org_memberships m join "user" u on u.id = m.user_id where u.email = ${ownerEmail}`
    const [a] = await sql`select id from "user" where email = ${`polish-approver-${stamp}@example.test`}`
    await sql`insert into org_memberships (id, org_id, user_id, role) values (${crypto.randomUUID()}, ${o!.org_id}, ${a!.id}, 'approver')`
    await sql`delete from org_memberships where user_id = ${a!.id} and org_id <> ${o!.org_id}`
    await page.goto('/app/approvals')
    await page.waitForLoadState('networkidle')
    await page.getByRole('link', { name: /\[DEMO\] Isolate/ }).first().click()
    await page.getByRole('button', { name: 'Approve…' }).click()
    const confirm = page.getByRole('alertdialog')
    await expect(confirm).toContainText('Approve "[DEMO] Isolate demo-wks-001"?')
    await expect(confirm).toContainText('demo-wks-001')
    // No default focus on Approve.
    await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused()
    await confirm.getByRole('button', { name: /Approve demo-wks-001/ }).click()
    await expect(page.getByLabel('Action context').getByText('Approved', { exact: true })).toBeVisible()
    await approverCtx.close()
  } finally {
    await sql.end()
  }
})
