import { describe, expect, it } from 'vitest'
import { approveAndRunKql, getHunt } from '../src/server/hunting/hunts'
import { deletePlaybook, listSavedPlaybooks, savePlaybook, startPlaybook } from '../src/server/hunting/playbooks'
import { huntReportMarkdown } from '../src/server/hunting/report'
import { BUILTIN_PLAYBOOKS, answerText, builtinForKind, coverageOf, detectIndicator, fillIndicator, normaliseIndicator } from '../src/shared/indicator-playbooks'
import { canApproveEveryProposal } from '../src/shared/kql-approval'
import { assertSafeKql } from '../src/server/hunting/safety'
import { makeOrg, makeUser, member, team } from './helpers'

const HASH = 'ab'.repeat(32)

describe('indicator playbooks', () => {
  it('accepts one IP, domain, or hash and rejects anything that could break out of the KQL string', () => {
    expect(normaliseIndicator('ip', '203.0.113.10')).toBe('203.0.113.10')
    expect(normaliseIndicator('ip', '2001:db8::1')).toBe('2001:db8::1')
    expect(normaliseIndicator('domain', 'Evil.Example')).toBe('evil.example')
    expect(normaliseIndicator('hash', HASH.toUpperCase())).toBe(HASH)
    expect(normaliseIndicator('ip', "203.0.113.10' or true")).toBeNull()
    expect(normaliseIndicator('domain', 'evil.example/path')).toBeNull()
    expect(normaliseIndicator('hash', 'zzzz')).toBeNull()
  })

  it('detects an IP, a hash, then a domain, and names the built-in playbook', () => {
    expect(detectIndicator('203.0.113.10')).toEqual({ kind: 'ip', value: '203.0.113.10' })
    expect(detectIndicator(HASH.toUpperCase())).toEqual({ kind: 'hash', value: HASH })
    expect(detectIndicator('Evil.Example')).toEqual({ kind: 'domain', value: 'evil.example' })
    expect(detectIndicator('not an indicator')).toBeNull()
    expect(builtinForKind('domain')?.id).toBe('builtin:domain')
  })

  it('writes a clipboard answer and hides approve-all when a second person is required', () => {
    const coverage = coverageOf([
      { rationale: 'Check: Defender network events', kql: 'T | take 1', target: 'defender', status: 'run', resultSummary: { rowCount: 2 } },
    ])
    expect(answerText(coverage)).toBe('Any hits? Yes. At least one check returned rows.\n1 of 1 checks ran.\nDefender network events: Hit (2 rows)')
    const pending = { status: 'proposed', requestedBy: 'user-a', proposedByType: 'user' as const, proposedById: 'user-a' }
    expect(canApproveEveryProposal('member', { userId: 'user-a', role: 'analyst' }, [pending])).toBe(true)
    expect(canApproveEveryProposal('second-person', { userId: 'user-b', role: 'approver' }, [pending])).toBe(false)
    expect(canApproveEveryProposal('approver', { userId: 'user-b', role: 'analyst' }, [pending])).toBe(false)
    expect(canApproveEveryProposal('approver', { userId: 'user-b', role: 'owner' }, [pending, { ...pending, status: 'run' }])).toBe(true)
    expect(canApproveEveryProposal('member', { userId: 'user-a', role: 'analyst' }, [])).toBe(false)
  })

  it('built-in templates fill the indicator and stay inside the KQL blocklist', () => {
    const samples = { ip: '203.0.113.10', domain: 'example.invalid', hash: HASH }
    for (const playbook of BUILTIN_PLAYBOOKS) {
      for (const check of playbook.checks) {
        const kql = assertSafeKql(fillIndicator(check.kql, samples[playbook.indicatorKind]))
        expect(kql).toContain(samples[playbook.indicatorKind])
        expect(kql).not.toContain('{{indicator}}')
      }
    }
  })

  it('proposes every check and does not run them', async () => {
    const org = await makeOrg('Playbook')
    const user = await makeUser()
    await member(org, user)
    const started = await startPlaybook(org, user, { playbookId: 'builtin:ip', indicator: '203.0.113.10' })
    expect(started.proposalIds).toHaveLength(BUILTIN_PLAYBOOKS[0]!.checks.length)
    const before = await huntReportMarkdown(org, started.huntId, user)
    expect(before!.markdown).toContain('Any hits:** Not fully checked')
    expect(before!.markdown).toContain('Defender network events')
    expect(before!.markdown).toContain('Not run')
    const proposed = (await getHunt(org, started.huntId))!.proposals
    expect(proposed.every((proposal) => proposal.status === 'proposed')).toBe(true)
    expect(proposed.some((proposal) => proposal.kql.includes("RemoteIP == '203.0.113.10'"))).toBe(true)
    expect(proposed.some((proposal) => proposal.kql.includes('{{indicator}}'))).toBe(false)

    await approveAndRunKql(org, user, started.proposalIds[0]!)
    const after = await huntReportMarkdown(org, started.huntId, user)
    expect(after!.markdown).toContain('Any hits:** Yes')
    expect(after!.markdown).toContain('| Defender network events | Defender XDR | run |')
  })

  it('keeps a saved playbook inside the organisation', async () => {
    const org = await makeOrg('Saved')
    const other = await makeOrg('Other')
    const user = await makeUser()
    await member(org, user)
    await member(other, user)
    const saved = await savePlaybook(org, user, {
      name: 'Edge IP',
      indicatorKind: 'ip',
      checks: [{ name: 'Network', target: 'defender', kql: "DeviceNetworkEvents\n| where RemoteIP == '{{indicator}}'\n| take 5" }],
    })
    await expect(startPlaybook(other, user, { playbookId: saved.id, indicator: '203.0.113.10' })).rejects.toThrow(/not found/i)
    await expect(deletePlaybook(other, { userId: user, role: 'owner' }, saved.id)).rejects.toThrow(/not found/i)
    await expect(savePlaybook(org, user, { name: 'Edge IP', indicatorKind: 'ip', checks: [{ name: 'Network', target: 'defender', kql: "x | where y == '{{indicator}}'" }] })).rejects.toThrow(/already has a playbook/)
    await expect(savePlaybook(org, user, { name: 'Bad', indicatorKind: 'ip', checks: [{ name: 'Nope', target: 'defender', kql: 'externaldata(a:string)["{{indicator}}"]' }] })).rejects.toThrow(/Blocked/)
    const started = await startPlaybook(org, user, { playbookId: saved.id, indicator: '203.0.113.10' })
    expect(started.proposalIds).toHaveLength(1)
    await deletePlaybook(org, { userId: user, role: 'owner' }, saved.id)
  })

  it('lets only owners and approvers delete a shared playbook', async () => {
    const t = await team()
    const saved = await savePlaybook(t.orgId, t.analyst, {
      name: 'Shared domain',
      indicatorKind: 'domain',
      checks: [{ name: 'DNS', target: 'defender', kql: "DeviceNetworkEvents\n| where RemoteUrl has '{{indicator}}'\n| take 5" }],
    })
    // The analyst who wrote it cannot delete it either: it belongs to the organisation.
    await expect(deletePlaybook(t.orgId, { userId: t.analyst, role: 'analyst' }, saved.id)).rejects.toThrow(/Only owners and approvers/)
    expect((await listSavedPlaybooks(t.orgId)).map((p) => p.id)).toContain(saved.id)
    await deletePlaybook(t.orgId, { userId: t.approver, role: 'approver' }, saved.id)
    expect((await listSavedPlaybooks(t.orgId)).map((p) => p.id)).not.toContain(saved.id)
  })
})

describe('coverage answers', () => {
  it('says no only when every check ran and returned nothing', () => {
    const row = (status: string, rowCount: number | null) => ({ rationale: 'Check: One', kql: 'T', target: 'defender', status, resultSummary: rowCount === null ? null : { rowCount } })
    expect(coverageOf([row('run', 0), row('run', 0)]).answer).toBe('no')
    expect(coverageOf([row('run', 0), row('run', 2)]).answer).toBe('yes')
    expect(coverageOf([row('run', 0), row('proposed', null)]).answer).toBe('incomplete')
    expect(coverageOf([row('failed', null)]).answer).toBe('incomplete')
  })
})
