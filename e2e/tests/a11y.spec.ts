import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { horizontalOverflow } from '../support/helpers'

/**
 * Automated WCAG 2.2 AA scan (axe-core) of every app page in light and dark themes.
 * Automated checks catch roughly a third of issues; keyboard and screen-reader behaviour is
 * covered by hunt-workspace.spec.ts and manual review. Uses the shared owner with [DEMO] data
 * from global-setup.ts.
 */
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']

async function scan(page: Page, label: string) {
  const r = await new AxeBuilder({ page }).withTags(TAGS).analyze()
  const summary = r.violations.map((v) => `${label} · ${v.id} (${v.impact}): ${v.help}\n    ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join('\n    ')}`)
  return summary
}

test('every page passes axe WCAG 2.2 AA in light and dark', async ({ page, browser }) => {
  test.setTimeout(240_000)
  await page.setViewportSize({ width: 1280, height: 900 })
  const problems: string[] = []

  // Sign-in page, signed out (a fresh context without the shared session).
  const anon = await browser.newContext({ storageState: { cookies: [], origins: [] } })
  const anonPage = await anon.newPage()
  await anonPage.goto('/sign-in')
  await anonPage.waitForLoadState('networkidle')
  problems.push(...(await scan(anonPage, 'sign-in')))
  await anon.close()

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
      const overflow = await horizontalOverflow(page)
      if (overflow.px > 1) problems.push(`${label} [${theme}] · horizontal overflow of ${overflow.px}px at 390 px (${overflow.culprit})`)
    }
    await page.setViewportSize({ width: 1280, height: 900 })
  }
  expect(problems, problems.join('\n')).toEqual([])
})

/** Measure the rendered ring, including scroll containers that can clip it (#162). */
async function expectVisibleFocus(control: Locator) {
  await expect(control).toBeFocused()
  await expect.poll(() => control.evaluate((el) => {
    const style = getComputedStyle(el)
    const width = parseFloat(style.outlineWidth)
    const outside = parseFloat(style.outlineOffset) + width
    const box = el.getBoundingClientRect()
    const clipped: Array<{ parent: string; left: number; right: number; top: number; bottom: number; scrollLeft: number; scrollWidth: number; width: number }> = []
    for (let parent = el.parentElement; parent; parent = parent.parentElement) {
      const css = getComputedStyle(parent)
      const rect = parent.getBoundingClientRect()
      const left = rect.left + parent.clientLeft
      const top = rect.top + parent.clientTop
      if ((css.overflowX !== 'visible' && (box.left - outside < left - 0.5 || box.right + outside > left + parent.clientWidth + 0.5)) ||
          (css.overflowY !== 'visible' && (box.top - outside < top - 0.5 || box.bottom + outside > top + parent.clientHeight + 0.5))) {
        clipped.push({ parent: parent.className || parent.tagName, left: box.left - outside - left, right: left + parent.clientWidth - box.right - outside, top: box.top - outside - top, bottom: top + parent.clientHeight - box.bottom - outside, scrollLeft: parent.scrollLeft, scrollWidth: parent.scrollWidth, width: parent.clientWidth })
      }
    }
    return { visible: el.matches(':focus-visible'), width, style: style.outlineStyle, clipped }
  })).toEqual({ visible: true, width: 2, style: 'solid', clipped: [] })
}

test('segments, tabs and navigation keep visible focus and selection in both themes (#162)', async ({ page }, info) => {
  page.setDefaultTimeout(10_000)
  for (const theme of ['light', 'dark']) {
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 })
      await page.goto('/app/approvals')
      await page.waitForLoadState('networkidle')
      await page.getByLabel('Theme').selectOption(theme)
      const segments = page.getByRole('group', { name: 'Show', exact: true })
      const buttons = segments.getByRole('button')
      await page.keyboard.press('Tab') // keyboard modality before programmatic focus
      await buttons.first().focus()
      for (let index = 0; index < await buttons.count(); index++) {
        const button = buttons.nth(index)
        await expectVisibleFocus(button)
        await page.keyboard.press('Space')
        await expect(button).toHaveAttribute('aria-pressed', 'true')
        const marker = await button.evaluate((el) => {
          const css = getComputedStyle(el)
          const before = getComputedStyle(el, '::before')
          // Canvas resolves OKLCH to sRGB for the WCAG luminance calculation.
          const ctx = document.createElement('canvas').getContext('2d')!
          const luminance = (colour: string) => {
            ctx.fillStyle = colour
            ctx.fillRect(0, 0, 1, 1)
            const rgb = [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3).map((byte) => {
              const value = byte / 255
              return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
            })
            return rgb[0]! * 0.2126 + rgb[1]! * 0.7152 + rgb[2]! * 0.0722
          }
          const foreground = luminance(before.color)
          const background = luminance(css.backgroundColor)
          return { content: before.content, contrast: (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05) }
        })
        expect(marker.content).toContain('✓')
        expect(marker.contrast).toBeGreaterThanOrEqual(3)
        if (index < await buttons.count() - 1) await page.keyboard.press('Tab')
      }
      await info.attach(`segments-${theme}-${width}`, { body: await segments.screenshot(), contentType: 'image/png' })

      await page.goto('/app/agents')
      await page.waitForLoadState('networkidle')
      for (const selector of ['.cw-tabs', '.cw-nav']) {
        const group = page.locator(selector)
        const links = group.getByRole('link')
        await page.keyboard.press('Tab')
        await links.first().focus()
        for (let index = 0; index < await links.count(); index++) {
          await expectVisibleFocus(links.nth(index))
          if (index < await links.count() - 1) await page.keyboard.press('Tab')
        }
        await info.attach(`${selector.slice(1)}-${theme}-${width}`, { body: await group.screenshot(), contentType: 'image/png' })
      }
    }
  }
})
