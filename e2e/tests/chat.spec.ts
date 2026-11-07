import { expect, test } from '@playwright/test'

/**
 * Chat (ChatGPT-style). Runs against the deterministic mock model in e2e/support/mock-model.mjs:
 * start it with `node e2e/support/mock-model.mjs` and run the app with MODEL_PROVIDER=openai-compatible,
 * OPENAI_BASE_URL=http://127.0.0.1:18099/v1, OPENAI_MODEL=mock-model, OPENAI_API_KEY=any.
 * Its answer is fixed (a list and a table) and paced, so streaming is observable.
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
  // Streaming: the first words are on screen while the reply is still marked as streaming.
  await expect(reply.locator('.cw-md[data-streaming]')).toContainText('Here is what I found', { timeout: 30_000 })
  await expect(reply.locator('.cw-md[data-streaming]')).not.toContainText('Next step')
  // Finished: the full fixed answer rendered as markdown, including its table.
  await expect(reply.locator('.cw-md[data-streaming]')).toHaveCount(0, { timeout: 30_000 })
  await expect(reply.getByRole('table')).toBeVisible()
  await expect(reply.getByRole('cell', { name: 'CISA KEV' })).toBeVisible()
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
