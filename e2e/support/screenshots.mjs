// Capture design screenshots (light and dark, 1440 and 390 wide) of the main screens.
// Usage: node e2e/support/screenshots.mjs <outDir>. Needs the app on BASE_URL with demo fixtures support
// and the mock model (e2e/support/mock-model.mjs) so a chat thread has tool steps.
import { chromium } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

const BASE = process.env.BASE_URL ?? 'http://localhost:3000'
const MOCK = process.env.MOCK_MODEL_URL ?? 'http://127.0.0.1:18099'
const out = process.argv[2]
if (!out) throw new Error('Pass an output directory')
fs.mkdirSync(out, { recursive: true })

const browser = await chromium.launch()
const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 } })
const page = await ctx.newPage()
const go = async (p) => {
  await page.goto(p)
  await page.waitForLoadState('networkidle')
}
const shoot = async (name) => {
  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => localStorage.setItem('cw-theme', t), theme)
    for (const [w, h, tag] of [[1440, 900, 'desktop'], [390, 844, 'mobile']]) {
      await page.setViewportSize({ width: w, height: h })
      await page.reload()
      await page.waitForLoadState('networkidle')
      await page.waitForTimeout(300)
      await page.screenshot({ path: path.join(out, `${name}-${tag}-${theme}.png`), fullPage: true })
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 })
}

await go('/sign-in')
await shoot('sign-in')
await page.getByRole('button', { name: 'Create an account' }).click()
await page.getByLabel('Email').fill(`shots-${Date.now()}@example.test`)
await page.getByLabel('Password').fill('correct horse battery staple')
await page.getByRole('button', { name: 'Create account' }).click()
await page.waitForURL(/\/app/)
await page.getByRole('button', { name: 'Load demo data' }).click()
await page.getByText(/Demo data loaded/).waitFor()

await go('/app/hunts')
const huntHref = await page.getByRole('link', { name: /\[DEMO\] Suspicious PowerShell/ }).first().getAttribute('href')
await go('/app/approvals')
const approvalHref = await page.getByRole('link', { name: /\[DEMO\] Isolate/ }).first().getAttribute('href')

// A chat thread with a tool step (mock model calls search_intel, pauses, then is released).
await go('/app/chat')
await page.getByRole('button', { name: /Chat with Intel/ }).click()
await page.waitForURL(/\/app\/chat\/.+/)
const chatHref = new URL(page.url()).pathname
await page.getByRole('textbox', { name: /Message to Intel/ }).fill('What is new for Fortinet?')
await page.keyboard.press('Enter')
await page.waitForTimeout(2500)
await fetch(`${MOCK}/__release`, { method: 'POST' }).catch(() => {})
await page.waitForTimeout(3000)

for (const [name, p] of [
  ['control-panel', '/app'],
  ['watches', '/app/watches'],
  ['digests', '/app/digests'],
  ['hunts', '/app/hunts'],
  ['hunt-workspace', huntHref],
  ['chat-index', '/app/chat'],
  ['chat-thread', chatHref],
  ['approvals', '/app/approvals'],
  ['approval-detail', approvalHref],
  ['agents', '/app/agents'],
  ['settings', '/app/settings'],
]) {
  await go(p)
  await shoot(name)
}
await browser.close()
console.log('saved to', out)
