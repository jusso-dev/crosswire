import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

/**
 * Automated WCAG 2.2 AA scan (axe-core) of every app page in light and dark themes.
 * Automated checks catch roughly a third of issues; keyboard and screen-reader behaviour is
 * covered by hunt-workspace.spec.ts and manual review. Needs a running app with demo fixtures.
 */
const stamp = Date.now()
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']

async function scan(page: Page, label: string) {
  const r = await new AxeBuilder({ page }).withTags(TAGS).analyze()
  const summary = r.violations.map((v) => `${label} · ${v.id} (${v.impact}): ${v.help}\n    ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join('\n    ')}`)
  return summary
}

test('every page passes axe WCAG 2.2 AA in light and dark', async ({ page }) => {
  test.setTimeout(240_000)
  await page.setViewportSize({ width: 1280, height: 900 })
  const problems: string[] = []

  await page.goto('/sign-in')
  problems.push(...(await scan(page, 'sign-in')))

  await page.getByRole('button', { name: 'Create an account' }).click()
  await page.getByLabel('Email').fill(`a11y-${stamp}@example.test`)
  await page.getByLabel('Password').fill('correct horse battery staple')
  await page.getByRole('button', { name: 'Create account' }).click()
  await page.waitForURL(/\/app/)
  await page.getByRole('button', { name: 'Load demo data' }).click()
  await expect(page.getByText(/Demo data loaded/)).toBeVisible()

  await page.goto('/app/hunts')
  const huntHref = await page.getByRole('link', { name: /\[DEMO\] Suspicious PowerShell/ }).first().getAttribute('href')
  await page.goto('/app/approvals')
  const approvalHref = await page.getByRole('link', { name: /\[DEMO\] Isolate/ }).first().getAttribute('href')
  await page.goto('/app/chat')
  await page.getByRole('button', { name: /Chat with Lead/ }).click()
  await page.waitForURL(/\/app\/chat\/.+/)
  const chatHref = new URL(page.url()).pathname

  const pages: Array<[string, string]> = [
    ['control panel', '/app'],
    ['watches', '/app/watches'],
    ['digests', '/app/digests'],
    ['hunts', '/app/hunts'],
    ['hunt', huntHref!],
    ['chat', '/app/chat'],
    ['chat thread', chatHref],
    ['approvals', '/app/approvals'],
    ['approval', approvalHref!],
    ['agents', '/app/agents'],
    ['agents runs', '/app/agents?view=runs'],
    ['agents review', '/app/agents?view=review'],
    ['agents skills', '/app/agents?view=skills'],
    ['agents log', '/app/agents?view=log'],
    ['settings', '/app/settings'],
    ['compare', '/app/intel/CVE-2024-27834'],
    ['not found', '/app/does-not-exist'],
  ]
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((t) => localStorage.setItem('cw-theme', t), theme)
    for (const [label, path] of pages) {
      await page.goto(path)
      await page.waitForLoadState('networkidle')
      problems.push(...(await scan(page, `${label} [${theme}]`)))
    }
    // Hunt with results and the row inspector open.
    await page.goto(huntHref!)
    await page.locator('.cw-qitem', { hasText: 'Ran' }).first().click()
    await page.getByRole('table', { name: /sample rows/ }).locator('tbody tr').first().click()
    problems.push(...(await scan(page, `hunt inspector [${theme}]`)))
    // Command palette and shortcut sheet open.
    await page.goto('/app')
    await page.waitForLoadState('networkidle')
    await page.keyboard.press('ControlOrMeta+k')
    await page.getByRole('dialog', { name: 'Command palette' }).waitFor()
    problems.push(...(await scan(page, `command palette [${theme}]`)))
    await page.keyboard.press('Escape')
    await page.keyboard.press('Shift+Slash')
    await page.getByRole('heading', { name: 'Keyboard shortcuts' }).waitFor()
    problems.push(...(await scan(page, `shortcut sheet [${theme}]`)))
    await page.keyboard.press('Escape')
    // Narrow width: reading and approving at 390 px.
    await page.setViewportSize({ width: 390, height: 844 })
    for (const [label, path] of [['approval mobile', approvalHref!], ['control panel mobile', '/app'], ['chat thread mobile', chatHref]] as const) {
      await page.goto(path)
      await page.waitForLoadState('networkidle')
      problems.push(...(await scan(page, `${label} [${theme}]`)))
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
      if (overflow > 1) problems.push(`${label} [${theme}] · horizontal overflow of ${overflow}px at 390 px`)
    }
    await page.setViewportSize({ width: 1280, height: 900 })
  }
  expect(problems, problems.join('\n')).toEqual([])
})
