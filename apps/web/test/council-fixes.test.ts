import { describe, expect, it, vi } from 'vitest'
import { EventType, type StreamChunk } from '@tanstack/ai'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { parseEnv } from '../src/server/env'
import { assertSafeKql, UnsafeQueryError } from '../src/server/hunting/safety'
import { allowedSecretRefPrefix, resolveClientSecret, upsertConnector } from '../src/server/hunting/broker'
import { withTimeout } from '../src/server/agents/runtime'
import { buildDigest, runDailyDigest, appDay } from '../src/server/ti/digest'
import * as mail from '../src/server/mail'
import { getDb } from '../src/server/db/client'
import { digests } from '../src/server/db/schema'
import { eq } from 'drizzle-orm'
import { makeOrg, makeUser, member } from './helpers'

const TENANT = '0f0e0d0c-0b0a-0908-0706-050403020100'
const CLIENT = '01020304-0506-0708-090a-0b0c0d0e0f10'

describe('council review regressions', () => {
  it('.env.example parses: empty placeholders are treated as unset', () => {
    const text = readFileSync(path.resolve(__dirname, '../../../.env.example'), 'utf8')
    const vars = Object.fromEntries(
      text
        .split('\n')
        .filter((l) => /^[A-Z_]+=/.test(l))
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
    )
    const e = parseEnv({ ...vars, BETTER_AUTH_SECRET: 'x'.repeat(40), APP_ENCRYPTION_KEY: 'a'.repeat(64) })
    expect(e.RESPONSE_LOGICAPP_URL).toBeUndefined()
    expect(e.OPENAI_MODEL).toBeUndefined()
  })

  it('a // inside a string literal cannot hide blocked operators', () => {
    for (const q of [
      'print u="https://x"; externaldata(a:string)[@"https://evil/x"]',
      'print "http://a" | evaluate http_request("https://evil")',
      'let x = "//"; cluster("other").database("d").T',
    ]) {
      expect(() => assertSafeKql(q), q).toThrow(UnsafeQueryError)
    }
  })

  it("connector secret refs are confined to the org's own env namespace", async () => {
    const a = await makeOrg('RefA')
    const b = await makeOrg('RefB')
    process.env[`${allowedSecretRefPrefix(b)}SECRET`] = 'org-b-secret'
    await expect(upsertConnector(a, { tenantId: TENANT, clientId: CLIENT, clientSecretRef: `env:${allowedSecretRefPrefix(b)}SECRET` })).rejects.toThrow(/must be env:/)
    await expect(upsertConnector(a, { tenantId: TENANT, clientId: CLIENT, clientSecretRef: 'env:BETTER_AUTH_SECRET' })).rejects.toThrow(/must be env:/)
    // A row written before the check (or by hand) is still refused at resolve time.
    expect(() => resolveClientSecret({ orgId: a, clientSecretEnc: null, clientSecretRef: 'env:DATABASE_URL' })).toThrow(/must be env:/)
    process.env[`${allowedSecretRefPrefix(a)}SECRET`] = 'org-a-secret'
    await upsertConnector(a, { tenantId: TENANT, clientId: CLIENT, clientSecretRef: `env:${allowedSecretRefPrefix(a)}SECRET` })
    expect(resolveClientSecret({ orgId: a, clientSecretEnc: null, clientSecretRef: `env:${allowedSecretRefPrefix(a)}SECRET` })).toBe('org-a-secret')
  })

  it('agent timeouts surface as RUN_ERROR even when the stream ends quietly on abort', async () => {
    const abort = new AbortController()
    // The stream ends quietly once the timeout aborts it, with no fixed sleep (#178).
    async function* quiet(): AsyncIterable<StreamChunk> {
      yield { type: EventType.RUN_STARTED, runId: 'r', threadId: 't', timestamp: Date.now() } as unknown as StreamChunk
      await new Promise<void>((resolve) => abort.signal.addEventListener('abort', () => resolve(), { once: true }))
    }
    vi.useFakeTimers()
    try {
      const out: string[] = []
      const done = (async () => {
        for await (const c of withTimeout(quiet(), 10, abort)) out.push(c.type)
      })()
      await vi.advanceTimersByTimeAsync(10)
      await done
      expect(abort.signal.aborted).toBe(true)
      expect(out.at(-1)).toBe(EventType.RUN_ERROR)
    } finally {
      vi.useRealTimers()
    }
  })

  it('an SMTP failure for one org does not stop other orgs, and the claim is released for retry', async () => {
    const day = appDay()
    const a = await makeOrg('MailA')
    const b = await makeOrg('MailB')
    const ua = await makeUser('mail-a@example.test')
    const ub = await makeUser('mail-b@example.test')
    await member(a, ua, 'owner')
    await member(b, ub, 'owner')
    const send = vi.spyOn(mail, 'sendMail').mockImplementation(async (to) => {
      if (to.includes('mail-a@example.test')) throw new Error('smtp down')
      return true
    })
    const r = await runDailyDigest(day)
    expect(r.failed).toBeGreaterThanOrEqual(1)
    const [da] = await getDb().select().from(digests).where(eq(digests.orgId, a))
    const [db] = await getDb().select().from(digests).where(eq(digests.orgId, b))
    expect(da!.emailedAt).toBeNull()
    expect(db!.emailedAt).not.toBeNull()
    send.mockRestore()
    expect((await buildDigest(a, day)).day).toBe(day)
  })
})

describe('daily digest send claim (#197)', () => {
  it('a concurrent run never sends the same org-day twice, and the claim is set only after the send', async () => {
    const day = appDay()
    const org = await makeOrg('MailOnce')
    const u = await makeUser('mail-once@example.test')
    await member(org, u, 'owner')
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let inSend!: () => void
    const sending = new Promise<void>((r) => (inSend = r))
    let mine = 0
    const send = vi.spyOn(mail, 'sendMail').mockImplementation(async (to) => {
      if (!to.includes('mail-once@example.test')) return true
      mine++
      inSend()
      // Hold the send open while a second run starts. (PGlite has one connection, so the second
      // run waits for this transaction; on Postgres `skip locked` makes it skip the row.)
      await gate
      return true
    })
    const first = runDailyDigest(day)
    await sending
    const second = runDailyDigest(day)
    release()
    await Promise.all([first, second])
    send.mockRestore()
    expect(mine).toBe(1)
    const [row] = await getDb().select().from(digests).where(eq(digests.orgId, org))
    expect(row!.emailedAt).not.toBeNull()
  })

  it('a send that never returns true leaves the org-day unclaimed for the next run', async () => {
    const day = appDay()
    const org = await makeOrg('MailFalse')
    const u = await makeUser('mail-false@example.test')
    await member(org, u, 'owner')
    const send = vi.spyOn(mail, 'sendMail').mockImplementation(async (to) => !to.includes('mail-false@example.test'))
    await runDailyDigest(day)
    let [row] = await getDb().select().from(digests).where(eq(digests.orgId, org))
    expect(row!.emailedAt).toBeNull()
    send.mockImplementation(async () => true)
    await runDailyDigest(day)
    ;[row] = await getDb().select().from(digests).where(eq(digests.orgId, org))
    expect(row!.emailedAt).not.toBeNull()
    send.mockRestore()
  })
})
