import { describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { getDb } from '../src/server/db/client'
import { account, auditEvents, entraRoleMappings, orgs } from '../src/server/db/schema'
import { addEntraMapping, listEntraMappings, removeEntraMapping, setEntraRequireMappedGroup } from '../src/server/auth/entra-mappings'
import { MemberChangeError } from '../src/server/orgs'
import { makeUser, member, team } from './helpers'

const GROUP = '1b2c3d4e-0000-1111-2222-333344445555'

async function tenantTeam() {
  const t = await team()
  await getDb().update(orgs).set({ entraTenantId: crypto.randomUUID() }).where(eq(orgs.id, t.orgId))
  return t
}

function idToken(claims: Record<string, unknown>) {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${enc({ alg: 'none' })}.${enc(claims)}.sig`
}

describe('Entra mapping editor (owner request)', () => {
  it('only owners add or remove mappings; each change is audited', async () => {
    const { orgId, owner, approver, analyst } = await tenantTeam()
    for (const who of [approver, analyst]) {
      await expect(addEntraMapping(orgId, who, { kind: 'group', value: GROUP, role: 'owner' })).rejects.toBeInstanceOf(MemberChangeError)
    }
    const { id } = await addEntraMapping(orgId, owner, { kind: 'group', value: GROUP.toUpperCase(), role: 'approver' })
    const view = await listEntraMappings(orgId)
    expect(view.mappings).toMatchObject([{ kind: 'group', value: GROUP, role: 'approver' }])
    await expect(removeEntraMapping(orgId, approver, id)).rejects.toThrow(/Only owners/)
    await removeEntraMapping(orgId, owner, id)
    const audit = await getDb().select().from(auditEvents).where(eq(auditEvents.orgId, orgId))
    expect(audit.map((a) => a.action)).toEqual(['entra_mapping_added', 'entra_mapping_removed'])
    expect(audit[0]).toMatchObject({ actorId: owner, data: { kind: 'group', value: GROUP, role: 'approver' } })
  })

  it('an owner of another org cannot touch this org or its mappings', async () => {
    const a = await tenantTeam()
    const b = await tenantTeam()
    await expect(addEntraMapping(a.orgId, b.owner, { kind: 'app_role', value: 'X', role: 'owner' })).rejects.toThrow(/Only owners/)
    const { id } = await addEntraMapping(a.orgId, a.owner, { kind: 'app_role', value: 'Crosswire.Owner', role: 'owner' })
    await expect(removeEntraMapping(b.orgId, b.owner, id)).rejects.toThrow(/no longer exists/)
    expect(await getDb().select().from(entraRoleMappings).where(eq(entraRoleMappings.id, id))).toHaveLength(1)
  })

  it('validates values and refuses duplicates', async () => {
    const { orgId, owner } = await tenantTeam()
    await expect(addEntraMapping(orgId, owner, { kind: 'group', value: 'SOC Analysts', role: 'analyst' })).rejects.toThrow(/Object ID/)
    await expect(addEntraMapping(orgId, owner, { kind: 'app_role', value: 'has space', role: 'analyst' })).rejects.toThrow(/Spaces/)
    await addEntraMapping(orgId, owner, { kind: 'group', value: GROUP, role: 'analyst' })
    await expect(addEntraMapping(orgId, owner, { kind: 'group', value: GROUP, role: 'owner' })).rejects.toThrow(/already mapped/)
  })

  it('require-group cannot be turned on so it locks the owner out, and its last mapping cannot be removed', async () => {
    const { orgId, owner, analyst } = await tenantTeam()
    await expect(setEntraRequireMappedGroup(orgId, analyst, true)).rejects.toThrow(/Only owners/)
    await expect(setEntraRequireMappedGroup(orgId, owner, true)).rejects.toThrow(/at least one/)
    const { id } = await addEntraMapping(orgId, owner, { kind: 'group', value: GROUP, role: 'owner' })
    // No Microsoft sign-in on record for the owner: refused.
    await expect(setEntraRequireMappedGroup(orgId, owner, true)).rejects.toThrow(/lock you out/)
    await getDb().insert(account).values({ id: crypto.randomUUID(), accountId: crypto.randomUUID(), providerId: 'microsoft', userId: owner, idToken: idToken({ groups: [GROUP] }) })
    await setEntraRequireMappedGroup(orgId, owner, true)
    expect((await listEntraMappings(orgId)).requireMappedGroup).toBe(true)
    await expect(removeEntraMapping(orgId, owner, id)).rejects.toThrow(/last mapping/)
    await setEntraRequireMappedGroup(orgId, owner, false)
    await removeEntraMapping(orgId, owner, id)
    const audit = await getDb().select().from(auditEvents).where(and(eq(auditEvents.orgId, orgId), eq(auditEvents.action, 'entra_require_mapped_group_changed')))
    expect(audit.map((a) => a.data)).toEqual([{ to: true }, { to: false }])
  })

  it('a personal workspace has no tenant, so mappings do not apply', async () => {
    const [p] = await getDb().insert(orgs).values({ name: 'P', slug: `p-${crypto.randomUUID().slice(0, 8)}`, isPersonal: true }).returning()
    const u = await makeUser()
    await member(p!.id, u, 'owner')
    expect((await listEntraMappings(p!.id)).tenantBound).toBe(false)
  })
})
