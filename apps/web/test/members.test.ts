import { describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { getDb } from '../src/server/db/client'
import { auditEvents, huntCases, huntSchedules, orgMemberRemovals, orgMemberships } from '../src/server/db/schema'
import { changeMemberRole, highestRole, isRemovedMember, listenRoleLoweredForTests, MemberChangeError, removeMember } from '../src/server/orgs'
import { makeOrg, makeUser, member, team } from './helpers'

async function roleOf(orgId: string, userId: string) {
  const [m] = await getDb().select().from(orgMemberships).where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.userId, userId)))
  return m?.role ?? null
}

const manual = (orgId: string, userId: string, role: 'owner' | 'approver' | 'analyst', actorId: string) => changeMemberRole({ orgId, userId, role, actorId, audit: { action: 'role_changed' } })

describe('role ranking', () => {
  it('highestRole picks the role with the most rights', () => {
    expect(highestRole(['analyst', 'owner', 'approver'])).toBe('owner')
    expect(highestRole(['analyst', 'approver'])).toBe('approver')
    expect(highestRole([])).toBeNull()
  })
})

describe('role changes keep an owner (#202)', () => {
  it('records from and to, and runs the lowered-role hook on a downgrade', async () => {
    const { orgId, owner, approver } = await team()
    const seen: unknown[] = []
    const stop = listenRoleLoweredForTests((e) => void seen.push(e))
    try {
      expect(await manual(orgId, approver, 'analyst', owner)).toMatchObject({ changed: true, from: 'approver', to: 'analyst' })
    } finally {
      stop()
    }
    expect(seen).toEqual([{ orgId, userId: approver, oldRole: 'approver', newRole: 'analyst' }])
    const [a] = await getDb().select().from(auditEvents).where(and(eq(auditEvents.action, 'role_changed'), eq(auditEvents.targetId, approver)))
    expect(a?.data).toEqual({ from: 'approver', to: 'analyst' })
    expect(a?.actorId).toBe(owner)
  })

  it('two owners demoting each other at once leaves one owner', async () => {
    const orgId = await makeOrg('Race')
    const a = await makeUser()
    const b = await makeUser()
    await member(orgId, a, 'owner')
    await member(orgId, b, 'owner')
    const results = await Promise.allSettled([manual(orgId, b, 'analyst', a), manual(orgId, a, 'analyst', b)])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
    expect(refused.reason).toBeInstanceOf(MemberChangeError)
    const owners = (await getDb().select().from(orgMemberships).where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.role, 'owner')))).length
    expect(owners).toBe(1)
  })

  it('refuses a non-member, yourself, a non-owner actor, and writes no audit row for them', async () => {
    const { orgId, owner, approver, analyst } = await team()
    const stranger = await makeUser()
    await expect(manual(orgId, stranger, 'approver', owner)).rejects.toThrow(/not a member/)
    await expect(manual(orgId, owner, 'analyst', owner)).rejects.toThrow(/your own role/)
    await expect(manual(orgId, analyst, 'owner', approver)).rejects.toThrow(/Only owners/)
    const rows = await getDb().select().from(auditEvents).where(eq(auditEvents.orgId, orgId))
    expect(rows).toHaveLength(0)
  })

  it('a former owner whose session still says owner cannot change roles', async () => {
    const orgId = await makeOrg('Stale')
    const a = await makeUser()
    const b = await makeUser()
    const c = await makeUser()
    await member(orgId, a, 'owner')
    await member(orgId, b, 'owner')
    await member(orgId, c, 'analyst')
    await manual(orgId, b, 'analyst', a)
    await expect(manual(orgId, c, 'owner', b)).rejects.toThrow(/Only owners/)
    expect(await roleOf(orgId, c)).toBe('analyst')
  })

  it('Entra sync never removes the last owner; it audits the refusal instead', async () => {
    const orgId = await makeOrg('LastOwner')
    const o = await makeUser()
    await member(orgId, o, 'owner')
    const r = await changeMemberRole({ orgId, userId: o, role: 'analyst', actorId: null, source: 'entra', audit: { action: 'entra_role_synced', data: { matched: [] } } })
    expect(r).toMatchObject({ changed: false, blocked: 'last_owner' })
    expect(await roleOf(orgId, o)).toBe('owner')
    const [a] = await getDb().select().from(auditEvents).where(eq(auditEvents.action, 'entra_role_synced_blocked_last_owner'))
    expect(a).toMatchObject({ result: 'failure', actorType: 'system', targetId: o, orgId })
    expect(a?.data).toEqual({ from: 'owner', to: 'analyst', matched: [] })
  })
})

describe('removing members (#195)', () => {
  it('an owner removes a member: audited, remembered, hook runs', async () => {
    const { orgId, owner, approver } = await team()
    const seen: unknown[] = []
    const stop = listenRoleLoweredForTests((e) => void seen.push(e))
    try {
      expect(await removeMember(orgId, approver, owner)).toEqual({ from: 'approver' })
    } finally {
      stop()
    }
    expect(await roleOf(orgId, approver)).toBeNull()
    expect(await isRemovedMember(orgId, approver)).toBe(true)
    expect(seen).toEqual([{ orgId, userId: approver, oldRole: 'approver', newRole: null }])
    const [a] = await getDb().select().from(auditEvents).where(eq(auditEvents.action, 'member_removed'))
    expect(a).toMatchObject({ actorId: owner, targetId: approver, orgId })
  })

  it('refuses non-owners, yourself, the last owner and non-members', async () => {
    const { orgId, owner, approver, analyst } = await team()
    await expect(removeMember(orgId, analyst, approver)).rejects.toThrow(/Only owners/)
    await expect(removeMember(orgId, owner, owner)).rejects.toThrow(/yourself/)
    await expect(removeMember(orgId, await makeUser(), owner)).rejects.toThrow(/not a member/)
    // A second owner removing the only other owner is fine; removing the last one is not possible
    // because only an owner can act, and they cannot remove themselves.
    await manual(orgId, approver, 'owner', owner)
    await removeMember(orgId, owner, approver)
    expect(await roleOf(orgId, owner)).toBeNull()
    expect(await getDb().select().from(orgMemberRemovals).where(eq(orgMemberRemovals.orgId, orgId))).toHaveLength(1)
  })
})

describe('lowered roles stop repeat searches (#189 via onRoleLowered)', () => {
  async function scheduleBy(orgId: string, approvedBy: string) {
    const [h] = await getDb().insert(huntCases).values({ orgId, title: 'H', createdBy: approvedBy }).returning()
    const now = new Date()
    const [s] = await getDb()
      .insert(huntSchedules)
      .values({ orgId, huntId: h!.id, target: 'defender', kql: 'DeviceInfo | take 1', intervalMinutes: 60, approvedBy, approvedAt: now, approvalExpiresAt: new Date(now.getTime() + 86_400_000), nextRunAt: now })
      .returning()
    return s!.id
  }
  const enabled = async (id: string) => (await getDb().select().from(huntSchedules).where(eq(huntSchedules.id, id)))[0]?.enabled

  it('a demotion to analyst and a removal disable that person\'s schedules; approver to owner does not', async () => {
    const { orgId, owner, approver } = await team()
    const other = await makeUser()
    await member(orgId, other, 'approver')
    const s1 = await scheduleBy(orgId, approver)
    const s2 = await scheduleBy(orgId, other)
    await manual(orgId, other, 'owner', owner)
    expect(await enabled(s2)).toBe(true)
    await manual(orgId, approver, 'analyst', owner)
    expect(await enabled(s1)).toBe(false)
    await removeMember(orgId, other, owner)
    expect(await enabled(s2)).toBe(false)
  })
})
