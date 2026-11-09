import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { getDb } from '../src/server/db/client'
import { agentUsage } from '../src/server/db/schema'
import { budgetSnapshot } from '../src/server/agents/budgets'
import { approveDirective, approvedDirectiveBlock, createDirective, retireDirective } from '../src/server/agents/directives'
import { appendMemory, describeMemory, findMemory, promptMembership, rememberOperator, replaceMemory, supersedeMemory } from '../src/server/agents/memory'
import { makeOrg, makeUser } from './helpers'

describe('agent desk', () => {
  it('finds held-back memory in this organisation and says whether it is in the prompt', async () => {
    const org = await makeOrg('Desk')
    const other = await makeOrg('Other desk')
    const author = await makeUser()
    const approver = await makeUser()
    const held = await appendMemory({ orgId: org, agentKey: 'hunter', body: 'Desk quarantine phrase alpha', sourceType: 'remember', authorId: author })
    await appendMemory({ orgId: other, agentKey: 'hunter', body: 'Desk quarantine phrase alpha', sourceType: 'remember', authorId: author })
    const live = await rememberOperator(org, approver, 'hunter', 'Do not drop the desk operator phrase beta.')
    const hits = await findMemory(org, 'Desk quarantine')
    expect(hits.map((row) => row.id)).toEqual([held.id])
    const injected = await promptMembership(org, ['hunter'])
    expect(describeMemory(held, injected).inPrompt).toBe(false)
    expect(describeMemory(held, injected).reason).toMatch(/Quarantined/)
    expect(describeMemory(live, injected).inPrompt).toBe(true)
    await expect(supersedeMemory(org, live.id, held.id)).resolves.toMatchObject({ tombstonedAt: expect.any(Date) })
    const replaced = await replaceMemory(org, approver, held.id, 'Desk replacement phrase')
    expect(replaced.body).toContain('Desk replacement')
    const after = await findMemory(org, 'Desk quarantine phrase')
    expect(describeMemory(after[0]!, await promptMembership(org, ['hunter'])).reason).toMatch(/Tombstoned/)
  })

  it('keeps only the 20 newest non-safety notes in the prompt', async () => {
    const org = await makeOrg('Cap')
    const user = await makeUser()
    const ids: string[] = []
    for (let i = 0; i < 21; i++) ids.push((await rememberOperator(org, user, 'intel', `cap-note-${i}`)).id)
    const injected = await promptMembership(org, ['intel'])
    expect(injected.has(ids[0]!)).toBe(false)
    expect(injected.has(ids[20]!)).toBe(true)
  })

  it('refuses a replacement from another organisation', async () => {
    const org = await makeOrg('Home')
    const other = await makeOrg('Away')
    const user = await makeUser()
    const home = await rememberOperator(org, user, 'lead', 'home note for supersede')
    const away = await rememberOperator(other, user, 'lead', 'away note for supersede')
    await expect(supersedeMemory(org, home.id, away.id)).rejects.toThrow(/not found in this organisation/)
  })

  it('injects an approved directive and drops it when retired', async () => {
    const org = await makeOrg('Directives')
    const author = await makeUser()
    const approver = await makeUser()
    const draft = await createDirective({ orgId: org, title: 'Name the ticket', body: 'Write the ticket id in the summary.', createdBy: author })
    expect(await approvedDirectiveBlock(org)).not.toContain('ticket id')
    await expect(approveDirective(org, draft.id, author)).rejects.toThrow(/cannot approve your own/)
    await approveDirective(org, draft.id, approver)
    expect(await approvedDirectiveBlock(org)).toContain('ticket id')
    await retireDirective(org, draft.id, approver)
    expect(await approvedDirectiveBlock(org)).not.toContain('ticket id')
  })

  it('reads usage from Postgres for this organisation only', async () => {
    const org = await makeOrg('Usage')
    const other = await makeOrg('Usage other')
    await getDb().insert(agentUsage).values({ orgId: org, agentKey: 'lead', provider: 'test', model: 'test', inputTokens: 1000, outputTokens: 1000, observed: true })
    await getDb().insert(agentUsage).values({ orgId: other, agentKey: 'lead', provider: 'test', model: 'test', inputTokens: 50_000, outputTokens: 50_000, observed: true })
    const snap = await budgetSnapshot(org)
    expect(snap.inputTokens).toBe(1000)
    expect(snap.outputTokens).toBe(1000)
    expect(snap.context?.occupiedTokens).toBe(2000)
    expect(snap.context?.warning).toBe(false)
    expect(snap.dailyInputCap).toBeGreaterThan(0)
    const rows = await getDb().select().from(agentUsage).where(eq(agentUsage.orgId, org))
    expect(rows).toHaveLength(1)
  })
})
