import { describe, expect, it } from 'vitest'
import { approveAndRunKql, getHunt } from '../src/server/hunting/hunts'
import { deletePlaybook, savePlaybook, startPlaybook } from '../src/server/hunting/playbooks'
import { huntReportMarkdown } from '../src/server/hunting/report'
import { BUILTIN_PLAYBOOKS, coverageOf, fillIndicator, normaliseIndicator } from '../src/shared/indicator-playbooks'
import { assertSafeKql } from '../src/server/hunting/safety'
import { makeOrg, makeUser, member } from './helpers'

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
    await expect(deletePlaybook(other, saved.id)).rejects.toThrow(/not found/i)
    await expect(savePlaybook(org, user, { name: 'Edge IP', indicatorKind: 'ip', checks: [{ name: 'Network', target: 'defender', kql: "x | where y == '{{indicator}}'" }] })).rejects.toThrow(/already has a playbook/)
    await expect(savePlaybook(org, user, { name: 'Bad', indicatorKind: 'ip', checks: [{ name: 'Nope', target: 'defender', kql: 'externaldata(a:string)["{{indicator}}"]' }] })).rejects.toThrow(/Blocked/)
    const started = await startPlaybook(org, user, { playbookId: saved.id, indicator: '203.0.113.10' })
    expect(started.proposalIds).toHaveLength(1)
    await deletePlaybook(org, saved.id)
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
