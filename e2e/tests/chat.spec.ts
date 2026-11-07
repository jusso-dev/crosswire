import { expect, test } from '@playwright/test'

/**
 * Chat (ChatGPT-style). Needs the app configured with MODEL_PROVIDER=openai-compatible (or azure)
 * pointed at a model endpoint that streams (a local mock is fine) and calls
 * search_intel when offered it.
 */
const stamp = Date.now()

test('chat streams a markdown reply, shows tool steps, persists, and supports stop and keyboard', async ({ page }) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1280, height: 860 })
  await page.goto('/sign-in')
  await page.getByRole('button', { name: 'Create an account' }).click()
  await page.getByLabel('Email').fill(`chat-${stamp}@example.test`)
  await page.getByLabel('Password').fill('correct horse battery staple')
  await page.getByRole('button', { name: 'Create account' }).click()
  await page.waitForURL(/\/app/)

  await page.goto('/app/chat')
  await page.getByRole('button', { name: /Chat with Intel/ }).click()
  await page.waitForURL(/\/app\/chat\/.+/)
  const input = page.getByRole('textbox', { name: /Message to Intel/ })
  await expect(input).toBeFocused()

  // Enter sends; the reply streams in (partial text appears before the final text).
  await input.fill('What is new for Fortinet?')
  await page.keyboard.press('Enter')
  const reply = page.locator('.cw-turn[data-role="assistant"]').last()
  await expect(reply.locator('.cw-md[data-streaming]')).toBeVisible({ timeout: 30_000 })
  const partial = await reply.locator('.cw-md').innerText()
  await expect(reply.getByRole('table')).toBeVisible({ timeout: 30_000 }) // markdown table rendered
  const full = await reply.locator('.cw-md').innerText()
  expect(full.length).toBeGreaterThan(partial.length)
  await expect(reply.locator('.cw-md[data-streaming]')).toHaveCount(0)
  await expect(reply.getByText('Fortinet', { exact: false }).first()).toBeVisible()

  // Tool step chip and the copy action appear after the reply finishes.
  await expect(page.getByRole('list', { name: 'Steps taken' }).last()).toContainText('Searched threat intel')
  await expect(reply.getByRole('button', { name: 'Copy' })).toBeVisible()

  // Reload: the conversation is persisted and titled from the first message.
  await page.reload()
  await expect(page.getByRole('heading', { level: 1, name: 'What is new for Fortinet?' })).toBeVisible()
  await expect(page.locator('.cw-turn[data-role="assistant"]')).toHaveCount(1)

  // Stop: start a reply and stop it mid-stream.
  await page.getByRole('textbox', { name: /Message to Intel/ }).fill('Tell me again')
  await page.getByRole('button', { name: 'Send' }).click()
  await page.getByRole('button', { name: 'Stop reply' }).click()
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible({ timeout: 15_000 })

  // Shift+Enter adds a new line instead of sending.
  const box = page.getByRole('textbox', { name: /Message to Intel/ })
  await box.fill('line one')
  await box.press('Shift+Enter')
  await box.type('line two')
  await expect(box).toHaveValue('line one\nline two')
})
