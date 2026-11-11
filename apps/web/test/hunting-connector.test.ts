import { describe, expect, it, vi } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { getDb } from '../src/server/db/client'
import { auditEvents, orgConnectors } from '../src/server/db/schema'
import { HuntingNotConfiguredError, TokenBroker, allowedSecretRefPrefix, resolveClientSecret, setTokenBroker, upsertConnector, type Sts } from '../src/server/hunting/broker'
import { HuntingClient } from '../src/server/hunting/client'
import { ResponseTokenBroker, upsertResponseConnector } from '../src/server/response/connector'
import { plainMessage } from '../src/shared/messages'
import { refusalMessage } from '../src/server/hunting/errors'
import { StateError } from '../src/server/hunting/hunts'
import { UnsafeQueryError } from '../src/server/hunting/safety'
import { makeOrg, makeUser, member } from './helpers'

const TENANT = '0f0e0d0c-0b0a-0908-0706-050403020100'
const CLIENT = '01020304-0506-0708-090a-0b0c0d0e0f10'
const SECRET = 'stored-hunting-secret-value'

async function stored(orgId: string) {
  const [row] = await getDb().select().from(orgConnectors).where(eq(orgConnectors.orgId, orgId))
  return row!
}

async function connectorAudit(orgId: string) {
  return getDb()
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.orgId, orgId), eq(auditEvents.action, 'hunting_connector_saved')))
}

describe('hunting connector save keeps the stored secret (#122)', () => {
  it('saving with blank secret fields keeps the secret, and hunting still gets a token', async () => {
    const org = await makeOrg('KeepSecret')
    const owner = await makeUser()
    await member(org, owner, 'owner')
    await upsertConnector(org, { tenantId: TENANT, clientId: CLIENT, clientSecret: SECRET }, owner)
    const before = await stored(org)

    // The settings form sends blank secret fields as undefined when only the workspace changes.
    await upsertConnector(org, { tenantId: TENANT, clientId: CLIENT, sentinelWorkspaceName: 'soc-ws' }, owner)
    const after = await stored(org)
    expect(after.clientSecretEnc).toBe(before.clientSecretEnc)
    expect(after.sentinelWorkspaceName).toBe('soc-ws')
    expect(resolveClientSecret(after)).toBe(SECRET)

    const sts: Sts = { clientCredentials: vi.fn(async (i) => ({ accessToken: `tok-${i.clientSecret === SECRET}`, expiresAt: Date.now() + 3600_000 })) }
    expect(await new TokenBroker(sts).acquire({ orgId: org, scope: 's' })).toBe('tok-true')
  })

  it('keeps a stored secret reference the same way', async () => {
    const org = await makeOrg('KeepRef')
    const ref = `env:${allowedSecretRefPrefix(org)}SECRET`
    await upsertConnector(org, { tenantId: TENANT, clientId: CLIENT, clientSecretRef: ref })
    await upsertConnector(org, { tenantId: TENANT, clientId: CLIENT })
    expect((await stored(org)).clientSecretRef).toBe(ref)
  })

  it('a new secret replaces the old one; clearSecret removes it', async () => {
    const org = await makeOrg('ClearSecret')
    await upsertConnector(org, { tenantId: TENANT, clientId: CLIENT, clientSecret: SECRET })
    const ref = `env:${allowedSecretRefPrefix(org)}OTHER`
    await upsertConnector(org, { tenantId: TENANT, clientId: CLIENT, clientSecretRef: ref })
    expect((await stored(org)).clientSecretEnc).toBeNull()
    expect((await stored(org)).clientSecretRef).toBe(ref)

    await upsertConnector(org, { tenantId: TENANT, clientId: CLIENT, clientSecret: SECRET })
    await upsertConnector(org, { tenantId: TENANT, clientId: CLIENT, clearSecret: true })
    const row = await stored(org)
    expect(row.clientSecretEnc).toBeNull()
    expect(row.clientSecretRef).toBeNull()
    await expect(new TokenBroker({ clientCredentials: vi.fn() }).acquire({ orgId: org, scope: 's' })).rejects.toBeInstanceOf(HuntingNotConfiguredError)
  })

  it('writes an audit record naming who and which fields changed, never a value', async () => {
    const org = await makeOrg('AuditConn')
    const owner = await makeUser()
    await member(org, owner, 'owner')
    await upsertConnector(org, { tenantId: TENANT, clientId: CLIENT, clientSecret: SECRET }, owner)
    await upsertConnector(org, { tenantId: TENANT, clientId: CLIENT, sentinelWorkspaceId: '11111111-2222-3333-4444-555555555555' }, owner)
    await upsertConnector(org, { tenantId: TENANT, clientId: CLIENT, sentinelWorkspaceId: '11111111-2222-3333-4444-555555555555', clearSecret: true }, owner)

    const rows = await connectorAudit(org)
    expect(rows).toHaveLength(3)
    for (const r of rows) {
      expect(r.category).toBe('hunt')
      expect(r.actorType).toBe('user')
      expect(r.actorId).toBe(owner)
      expect(r.createdAt).toBeInstanceOf(Date)
    }
    const all = JSON.stringify(rows.map((r) => r.data))
    expect(all).not.toContain(SECRET)
    expect(all).not.toContain('11111111-2222-3333-4444-555555555555')
    expect(all).not.toContain(TENANT)
    expect(all).not.toContain(CLIENT)
    const changes = rows.map((r) => (r.data as { changed: string[] }).changed)
    expect(changes).toContainEqual(expect.arrayContaining(['tenantId', 'clientId', 'secret']))
    expect(changes).toContainEqual(['sentinelWorkspaceId'])
    expect(changes).toContainEqual(['secret removed'])
  })
})

describe('hunting errors shown to the analyst (#129)', () => {
  it('HuntingNotConfiguredError carries no organisation id in its message', async () => {
    const org = await makeOrg('NoIdInMessage')
    const err = await new TokenBroker({ clientCredentials: vi.fn() }).acquire({ orgId: org, scope: 's' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HuntingNotConfiguredError)
    expect((err as Error).message).not.toContain(org)
    expect((err as HuntingNotConfiguredError).orgId).toBe(org)
  })

  it('rule errors keep their message; anything else becomes a plain sentence with a reference', () => {
    expect(refusalMessage(new StateError('Only a pending proposal can be rejected.'), 'reject_kql')).toBe('Only a pending proposal can be rejected.')
    expect(refusalMessage(new UnsafeQueryError('Blocked in hunting queries: externaldata.'), 'propose_kql')).toBe('Blocked in hunting queries: externaldata.')
    const raw = 'duplicate key value violates unique constraint "kql_proposals_pkey" org 5b1c'
    const shown = refusalMessage(new Error(raw), 'approve_kql')
    expect(shown).not.toContain('duplicate key')
    expect(shown).not.toContain('5b1c')
    expect(shown).toMatch(/^Something went wrong on the server\. .*reference: [0-9a-f]{8}\.$/)
  })
})

describe('Microsoft API errors on a failed search (#129)', () => {
  it('keep the plain hint, drop request ids and cap the detail', async () => {
    const org = await makeOrg('GraphError')
    await upsertConnector(org, { tenantId: TENANT, clientId: CLIENT, clientSecret: 'x' })
    setTokenBroker(new TokenBroker({ clientCredentials: async () => ({ accessToken: 't', expiresAt: Date.now() + 3600_000 }) }))
    const body = { error: { code: 'BadRequest', message: `Query failed. request-id: 9f1c2d3e-4b5a-6789-abcd-ef0123456789 ${'x'.repeat(400)}` } }
    const client = new HuntingClient((async () => Response.json(body, { status: 400 })) as unknown as typeof fetch)
    const err = (await client.runAdvancedHunting({ orgId: org, kql: 'T | take 1' }).then(() => new Error('expected a failure'), (e: unknown) => e)) as Error
    expect(err.message).toMatch(/^The query was rejected\. Check the KQL syntax and table names\. \(HTTP 400, BadRequest: Query failed\./)
    expect(err.message).not.toContain('9f1c2d3e')
    expect(err.message.length).toBeLessThan(300)
    expect(plainMessage(err)).toBe(err.message)
  })
})

describe('token caches follow connector changes in every process (#194)', () => {
  const stsFor = (prefix: string) => {
    const calls: Array<{ tenantId: string; clientId: string }> = []
    const sts: Sts = {
      clientCredentials: vi.fn(async (i) => {
        calls.push({ tenantId: i.tenantId, clientId: i.clientId })
        return { accessToken: `${prefix}-${i.tenantId}-${calls.length}`, expiresAt: Date.now() + 3600_000 }
      }),
    }
    return { sts, calls }
  }
  const OTHER_TENANT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

  it('a broker in another process gets a new token for the new tenant, not the cached one', async () => {
    const org = await makeOrg('HuntTenantSwap')
    await upsertConnector(org, { tenantId: TENANT, clientId: CLIENT, clientSecret: SECRET })
    // The worker's broker: a separate instance that upsertConnector's clear() never reaches.
    const { sts, calls } = stsFor('hunt')
    const worker = new TokenBroker(sts)
    const first = await worker.acquire({ orgId: org, scope: 's' })
    expect(await worker.acquire({ orgId: org, scope: 's' })).toBe(first)
    expect(calls).toHaveLength(1)

    await upsertConnector(org, { tenantId: OTHER_TENANT, clientId: CLIENT })
    const second = await worker.acquire({ orgId: org, scope: 's' })
    expect(second).not.toBe(first)
    expect(calls).toHaveLength(2)
    expect(calls[1]!.tenantId).toBe(OTHER_TENANT)
  })

  it('a removed secret stops a cached token from being used anywhere', async () => {
    const org = await makeOrg('HuntSecretGone')
    await upsertConnector(org, { tenantId: TENANT, clientId: CLIENT, clientSecret: SECRET })
    const worker = new TokenBroker(stsFor('hunt').sts)
    await worker.acquire({ orgId: org, scope: 's' })
    await upsertConnector(org, { tenantId: TENANT, clientId: CLIENT, clearSecret: true })
    await expect(worker.acquire({ orgId: org, scope: 's' })).rejects.toBeInstanceOf(HuntingNotConfiguredError)
  })

  it('a new secret for the same tenant and app also gets a new token', async () => {
    const org = await makeOrg('HuntSecretSwap')
    await upsertConnector(org, { tenantId: TENANT, clientId: CLIENT, clientSecret: SECRET })
    const { sts, calls } = stsFor('hunt')
    const worker = new TokenBroker(sts)
    await worker.acquire({ orgId: org, scope: 's' })
    await upsertConnector(org, { tenantId: TENANT, clientId: CLIENT, clientSecret: 'rotated-secret' })
    await worker.acquire({ orgId: org, scope: 's' })
    expect(calls).toHaveLength(2)
  })

  it('the response broker in another process does the same', async () => {
    const org = await makeOrg('RespTenantSwap')
    const owner = await makeUser()
    await member(org, owner, 'owner')
    await upsertResponseConnector(org, owner, { tenantId: TENANT, clientId: CLIENT, clientSecret: SECRET })
    const { sts, calls } = stsFor('resp')
    const worker = new ResponseTokenBroker(sts)
    const first = await worker.acquire({ orgId: org, scope: 's' })
    expect(await worker.acquire({ orgId: org, scope: 's' })).toBe(first)

    await upsertResponseConnector(org, owner, { tenantId: OTHER_TENANT, clientId: CLIENT })
    expect(await worker.acquire({ orgId: org, scope: 's' })).not.toBe(first)
    expect(calls.map((c) => c.tenantId)).toEqual([TENANT, OTHER_TENANT])
  })
})
