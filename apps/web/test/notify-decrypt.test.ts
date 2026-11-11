import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDb } from '../src/server/db/client'
import { orgNotificationChannels } from '../src/server/db/schema'
import { resetEnvForTests } from '../src/server/env'
import { addChannel, notify, setNotifyFetch, testChannel } from '../src/server/notify/notify'
import { team } from './helpers'

afterEach(() => {
  setNotifyFetch((...a) => fetch(...a))
  resetEnvForTests()
})

const hook = (n: number) => `https://hooks.slack.com/services/T000/B000/notifyDecrypt${n}`

describe('a channel whose URL cannot be decrypted (#212 review)', () => {
  it('fails that channel only, and the other channels still get the message', async () => {
    const t = await team()
    const broken = await addChannel(t.orgId, t.owner, { kind: 'slack', name: 'Broken', url: hook(1), events: ['approval_pending'] })
    await addChannel(t.orgId, t.owner, { kind: 'slack', name: 'Working', url: hook(2), events: ['approval_pending'] })
    // Simulate a value copied from another organisation's row: it no longer decrypts here.
    const other = await team()
    const foreign = await addChannel(other.orgId, other.owner, { kind: 'slack', name: 'Other', url: hook(3), events: ['approval_pending'] })
    const [src] = await getDb().select().from(orgNotificationChannels).where(eq(orgNotificationChannels.id, foreign))
    await getDb().update(orgNotificationChannels).set({ urlEnc: src!.urlEnc }).where(eq(orgNotificationChannels.id, broken))

    const urls: string[] = []
    setNotifyFetch(vi.fn(async (u: string | URL | Request) => (urls.push(String(u)), new Response('ok'))) as unknown as typeof fetch)
    const r = await notify(t.orgId, 'approval_pending', { title: 'Test', lines: [], link: '/app/approvals' })

    expect(r).toEqual({ sent: 1, failed: 1 })
    expect(urls).toEqual([hook(2)])
    const [row] = await getDb().select().from(orgNotificationChannels).where(eq(orgNotificationChannels.id, broken))
    expect(row!.lastStatus).toBe('stored URL could not be decrypted')

    const tested = await testChannel(t.orgId, broken)
    expect(tested).toEqual({ ok: false, status: 'stored URL could not be decrypted' })
  })
})
