import { beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { and, eq } from 'drizzle-orm'
import { auth, resetAuthForTests } from '../src/server/auth/auth'
import { resetEnvForTests } from '../src/server/env'
import { getDb } from '../src/server/db/client'
import { huntEvidence, orgConnectors, orgs, pwnChanges, pwnIncidents, pwnTags, watchHits } from '../src/server/db/schema'
import { ingestPwnWatch, feedUrl } from '../src/server/ti/pwnwatch'
import { addWatch } from '../src/server/ti/watchlists'
import { runMatcher } from '../src/server/ti/matcher'
import { upsertConnector } from '../src/server/hunting/broker'
import { createHunt } from '../src/server/hunting/hunts'
import { connectorHealth, dismissSetup, restoreSetup, safetyStatus, setupChecklist } from '../src/server/ops/setup'
import { onboardingSteps } from '../src/server/ops/onboarding'
import { SIGN_IN_FAILED, SIGN_UP_NEUTRAL, signInOutcome, signUpOutcome } from '../src/routes/-sign-in/messages'
import { roleChangeNeedsConfirm } from '../src/routes/-settings/members'
import { team } from './helpers'

const BASE = 'http://localhost:3000'

async function call(p: string, body: unknown) {
  return auth().handler(new Request(`${BASE}/api/auth${p}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify(body) }))
}

/** What better-auth's client hands the page: `{ data, error }` with the error's code and status. */
async function clientResult(res: Response) {
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null
  return res.ok ? { data: body as { token?: string | null }, error: null } : { data: null, error: { code: body?.code as string, message: body?.message as string, status: res.status } }
}

beforeAll(() => {
  resetEnvForTests()
  resetAuthForTests()
})

describe('sign-up and sign-in messages (#164)', () => {
  it('a new address and an already registered one show the same text when no session comes back', async () => {
    const email = `dup-${crypto.randomUUID().slice(0, 8)}@example.test`
    const first = await clientResult(await call('/sign-up/email', { email, password: 'correct horse battery staple', name: 'Dup' }))
    expect(signUpOutcome(first)).toEqual({ kind: 'signed-in' })

    // Better Auth 1.7.18 with autoSignIn on answers a duplicate with USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL.
    const again = await clientResult(await call('/sign-up/email', { email, password: 'another long password 1', name: 'Dup' }))
    expect(again.error?.code).toBe('USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL')
    const duplicate = signUpOutcome(again)
    // With email verification on, a new address gets a user and no session: the same words.
    const newNoSession = signUpOutcome({ data: { token: null }, error: null })
    expect(duplicate).toEqual({ kind: 'message', text: SIGN_UP_NEUTRAL })
    expect(newNoSession).toEqual(duplicate)
    expect(SIGN_UP_NEUTRAL).not.toMatch(/exist|already|registered/i)
  })

  it('keeps a specific message for password rules only', async () => {
    const short = await clientResult(await call('/sign-up/email', { email: `short-${crypto.randomUUID().slice(0, 8)}@example.test`, password: 'short', name: 'S' }))
    expect(short.error?.code).toBe('PASSWORD_TOO_SHORT')
    expect(signUpOutcome(short)).toMatchObject({ kind: 'message', field: 'password', text: expect.stringMatching(/at least 12 characters/i) })
    expect(signUpOutcome({ error: { code: 'FAILED_TO_CREATE_USER', status: 422 } })).toEqual({ kind: 'message', text: SIGN_UP_NEUTRAL })
    expect(signUpOutcome({ error: { message: 'User already exists. Use another email.' } })).toEqual({ kind: 'message', text: SIGN_UP_NEUTRAL })
  })

  it('sign-in gives one generic failure', () => {
    expect(signInOutcome({ error: { code: 'INVALID_EMAIL_OR_PASSWORD', status: 401 } })).toEqual({ kind: 'message', text: SIGN_IN_FAILED })
    expect(signInOutcome({ error: { code: 'USER_NOT_FOUND', status: 401 } })).toEqual({ kind: 'message', text: SIGN_IN_FAILED })
    expect(signInOutcome({ error: null })).toEqual({ kind: 'signed-in' })
  })
})

describe('feed links are checked at ingest (#131)', () => {
  it('stores only http and https links; javascript:, data: and relative links become empty', async () => {
    expect(feedUrl('https://pwn.watch/i/x')).toBe('https://pwn.watch/i/x')
    expect(feedUrl('javascript:alert(1)')).toBeNull()
    expect(feedUrl('data:text/html,<script>alert(1)</script>')).toBeNull()
    expect(feedUrl('/i/relative')).toBeNull()
    expect(feedUrl(undefined)).toBeNull()

    const slug = `bad-links-${crypto.randomUUID().slice(0, 8)}`
    const incidents = JSON.stringify({
      incidents: [
        { slug: `${slug}-js`, title: 'JS link', url: 'javascript:alert(1)', product: 'Linkcheckvendor', tags: [] },
        { slug: `${slug}-data`, title: 'Data link', url: 'data:text/html,hi', tags: [] },
        { slug: `${slug}-rel`, title: 'Relative link', url: '/i/relative', tags: [] },
        { slug: `${slug}-ok`, title: 'Good link', url: 'https://pwn.watch/i/ok', tags: [] },
      ],
    })
    const changes = JSON.stringify({ changes: [{ incident: `${slug}-js`, title: `Change ${slug}`, url: 'javascript:alert(1)', sourceUrl: 'data:,x' }] })
    const tags = JSON.stringify({ tags: [{ id: `tag-${slug}`, label: 'T', url: '/t/relative' }] })
    const stats = await ingestPwnWatch({ incidents, changes, tags })
    expect(stats.skipped).toBe(0)

    const db = getDb()
    const url = async (s: string) => (await db.select({ url: pwnIncidents.url }).from(pwnIncidents).where(eq(pwnIncidents.slug, s)))[0]!.url
    expect(await url(`${slug}-js`)).toBe('')
    expect(await url(`${slug}-data`)).toBe('')
    expect(await url(`${slug}-rel`)).toBe('')
    expect(await url(`${slug}-ok`)).toBe('https://pwn.watch/i/ok')
    const [change] = await db.select().from(pwnChanges).where(eq(pwnChanges.title, `Change ${slug}`))
    expect(change!.url).toBeNull()
    expect(change!.upstreamSourceUrl).toBeNull()
    const [tag] = await db.select().from(pwnTags).where(eq(pwnTags.id, `tag-${slug}`))
    expect(tag!.url).toBeNull()

    // A watch hit built from the bad incident carries no link either.
    const t = await team()
    await addWatch(t.orgId, t.owner, { type: 'vendor', value: 'linkcheckvendor' })
    await runMatcher({ orgId: t.orgId })
    const [hit] = await db.select().from(watchHits).where(and(eq(watchHits.orgId, t.orgId), eq(watchHits.sourceId, `${slug}-js`)))
    expect(hit).toBeTruthy()
    expect(hit!.url).toBeNull()
  })
})

const TENANT = '0f0e0d0c-0b0a-0908-0706-050403020100'
const CLIENT = '01020304-0506-0708-090a-0b0c0d0e0f10'

async function evidence(orgId: string, huntId: string, type: 'kql_result' | 'kql_failed' | 'scheduled_result' | 'scheduled_failed', payload: Record<string, unknown>, at: Date) {
  await getDb().insert(huntEvidence).values({ orgId, huntId, type, payload, actorType: 'system', actorId: null, createdAt: at })
}

describe('connector health and setup steps (#165)', () => {
  it('a saved connector is "not tested" until a live search works, and "failing" after a token error', async () => {
    const t = await team()
    expect(await connectorHealth(t.orgId)).toEqual({ state: 'none' })
    await upsertConnector(t.orgId, { tenantId: TENANT, clientId: CLIENT, clientSecret: 'wrong-secret' })
    const saved = await connectorHealth(t.orgId)
    expect(saved.state).toBe('untested')
    expect((await onboardingSteps(t.orgId)).tenant).toBe(false)
    expect((await setupChecklist(t.orgId)).items.find((i) => i.key === 'hunting')!.done).toBe(false)

    const hunt = await createHunt(t.orgId, t.owner, { title: 'Health check' })
    const base = Date.now() + 1000
    // Demo results never count as the connector working.
    await evidence(t.orgId, hunt.id, 'kql_result', { mode: 'demo', rowCount: 3 }, new Date(base))
    expect((await connectorHealth(t.orgId)).state).toBe('untested')
    // A bad KQL error says nothing about the secret.
    await evidence(t.orgId, hunt.id, 'kql_failed', { error: 'The query was rejected. Check the KQL syntax and table names. (HTTP 400)' }, new Date(base + 1000))
    expect((await connectorHealth(t.orgId)).state).toBe('untested')
    // A rejected token does.
    await evidence(t.orgId, hunt.id, 'kql_failed', { error: 'Token request failed (401): invalid_client' }, new Date(base + 2000))
    const failing = await connectorHealth(t.orgId)
    expect(failing).toEqual({ state: 'failing', since: new Date(base + 2000).toISOString(), lastOkAt: null })
    expect((await setupChecklist(t.orgId)).items.find((i) => i.key === 'hunting')!.done).toBe(false)

    await evidence(t.orgId, hunt.id, 'scheduled_result', { mode: 'live', rowCount: 0 }, new Date(base + 3000))
    expect(await connectorHealth(t.orgId)).toEqual({ state: 'working', lastOkAt: new Date(base + 3000).toISOString() })
    expect((await onboardingSteps(t.orgId)).tenant).toBe(true)
    expect((await setupChecklist(t.orgId)).items.find((i) => i.key === 'hunting')!.done).toBe(true)

    // A later failure turns it to failing again, keeping the last success.
    await evidence(t.orgId, hunt.id, 'scheduled_failed', { error: 'Permission denied. Check admin consent. (HTTP 403)' }, new Date(base + 4000))
    expect(await connectorHealth(t.orgId)).toEqual({ state: 'failing', since: new Date(base + 4000).toISOString(), lastOkAt: new Date(base + 3000).toISOString() })

    // Saving the connector again starts over at "not tested".
    await getDb().update(orgConnectors).set({ updatedAt: new Date(base + 5000) }).where(eq(orgConnectors.orgId, t.orgId))
    expect((await connectorHealth(t.orgId)).state).toBe('untested')
  })

  it('an owner can hide the setup steps and bring them back', async () => {
    const t = await team()
    expect((await setupChecklist(t.orgId)).dismissed).toBe(false)
    await dismissSetup(t.orgId)
    expect((await setupChecklist(t.orgId)).dismissed).toBe(true)
    await restoreSetup(t.orgId)
    expect((await setupChecklist(t.orgId)).dismissed).toBe(false)
    const [org] = await getDb().select({ at: orgs.setupDismissedAt }).from(orgs).where(eq(orgs.id, t.orgId))
    expect(org!.at).toBeNull()
  })

  it('response safety lamp and words come from one value, in plain words', () => {
    const safe = safetyStatus({ dryRun: true, executors: { sentinel: 'off', logicapp: 'dry-run', graph: 'off' } })
    expect(safe.state).toBe('ok')
    expect(safe.label).toBe('Safe mode on')
    expect(safe.detail).not.toMatch(/=/)
    expect(safe.detail).toMatch(/Logic Apps: dry run only/)
    const live = safetyStatus({ dryRun: false, executors: { sentinel: 'off', logicapp: 'off', graph: 'on' } })
    expect(live).toMatchObject({ state: 'warn', label: 'Live actions on' })
    expect(live.detail).toMatch(/Defender device actions: live/)
    const off = safetyStatus({ dryRun: false, executors: { sentinel: 'off', logicapp: 'off', graph: 'off' } })
    expect(off).toMatchObject({ state: 'warn', label: 'Safe mode off' })
  })
})

describe('role change confirmation (#130)', () => {
  it('asks before granting Approver or Owner, or removing Owner', () => {
    expect(roleChangeNeedsConfirm('analyst', 'approver')).toBe(true)
    expect(roleChangeNeedsConfirm('analyst', 'owner')).toBe(true)
    expect(roleChangeNeedsConfirm('owner', 'analyst')).toBe(true)
    expect(roleChangeNeedsConfirm('owner', 'approver')).toBe(true)
    expect(roleChangeNeedsConfirm('approver', 'analyst')).toBe(false)
    expect(roleChangeNeedsConfirm('analyst', 'analyst')).toBe(false)
  })

  it('the server rules on who may change roles are unchanged', () => {
    // UI-only change: setRoleFn still refuses non-owners and self-changes.
    const src = readFileSync(path.resolve(__dirname, '../src/fns/settings.ts'), 'utf8')
    expect(src).toContain("if (context.session.org.role !== 'owner') throw new Error('Only owners can change roles.')")
    expect(src).toContain("if (data.userId === context.session.user.id) throw new Error('You cannot change your own role.')")
  })
})
