import { expect, test } from '@playwright/test'
import { releaseMock, testId } from '../support/helpers'

/**
 * Chat (ChatGPT-style). Runs against the deterministic mock model in e2e/support/mock-model.mjs
 * (started by playwright.config.ts). Its answer is fixed (a list and a table) and paced, so
 * streaming is observable. Messages carry a `[t:<id>]` marker so this test releases only its own
 * held replies. Uses the shared owner from global-setup.ts.
 */
test('chat streams a markdown reply, shows tool steps, persists, and supports stop and keyboard', async ({ page, request }, info) => {
  test.setTimeout(120_000)
  const key = testId(info, 'chat')
  const first = `What is new for Fortinet? [t:${key}]`
  await page.setViewportSize({ width: 1280, height: 860 })

  await page.goto('/app/chat')
  await page.waitForLoadState('networkidle')
  await page.getByRole('button', { name: /Chat with Intel/ }).click()
  await page.waitForURL(/\/app\/chat\/.+/)
  await expect(page).toHaveTitle('New thread · Crosswire')
  const input = page.getByRole('textbox', { name: /Message to Intel/ })
  await expect(input).toBeFocused()

  // Enter sends; the reply streams in (partial text appears before the final text).
  await input.fill(first)
  await page.keyboard.press('Enter')
  const reply = page.locator('.cw-turn[data-role="assistant"]').last()
  // Streaming: the mock pauses mid-answer until released, so the partial text is observable on any runner.
  await expect(reply.locator('.cw-md[data-streaming]')).toContainText('Here is what I found', { timeout: 30_000 })
  await expect(reply.locator('.cw-md[data-streaming]')).not.toContainText('Next step')
  expect((await releaseMock(request, key)).released).toBe(true)
  // Finished: the full fixed answer rendered as markdown, including its table.
  await expect(reply.locator('.cw-md[data-streaming]')).toHaveCount(0, { timeout: 30_000 })
  await expect(reply.getByRole('table')).toBeVisible()
  await expect(reply.getByRole('cell', { name: 'CISA KEV' })).toBeVisible()
  await expect(reply.getByText('Fortinet', { exact: false }).first()).toBeVisible()

  // Tool step chip and the copy action appear after the reply finishes.
  await expect(page.getByRole('list', { name: 'Steps taken' }).last()).toContainText('Searched threat intel')
  await expect(reply.getByRole('button', { name: 'Copy' })).toBeVisible()

  // The browser tab follows the first-message title without needing a reload (#173).
  await expect(page).toHaveTitle(`${first} · Crosswire`)

  // Reload: the conversation is persisted and titled from the first message.
  await page.reload()
  await expect(page.getByRole('heading', { level: 1, name: first })).toBeVisible()
  await expect(page).toHaveTitle(`${first} · Crosswire`)
  await expect(page.locator('.cw-turn[data-role="assistant"]')).toHaveCount(1)

  // Stop: start a reply (it pauses at the gate) and stop it mid-stream.
  await page.getByRole('textbox', { name: /Message to Intel/ }).fill(`Tell me again [t:${key}]`)
  await page.getByRole('button', { name: 'Send' }).click()
  await page.getByRole('button', { name: 'Stop reply' }).click()
  await releaseMock(request, key)
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible({ timeout: 15_000 })

  // Shift+Enter adds a new line instead of sending.
  const box = page.getByRole('textbox', { name: /Message to Intel/ })
  await box.fill('line one')
  await box.press('Shift+Enter')
  await box.type('line two')
  await expect(box).toHaveValue('line one\nline two')
})
