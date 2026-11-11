import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { confirmText, executeButtonLabel, listTargets, targetCount, targetSentence } from '../src/routes/-approvals/confirm-text'
import { executionIntro, executionState, outcomeTone } from '../src/routes/-approvals/execution-text'
import { COMMENT_MAX, decisionControls } from '../src/routes/-approvals/controls'

/**
 * Approval path screen rules (#121, #125, #126, #127, #177). There is no component test set-up, so
 * the words and the control rules live in pure modules tested here; the route files only render them.
 */

const one = { title: 'Isolate demo-wks-001', actionType: 'graph_containment', payload: { action: 'isolate' }, targets: { devices: ['demo-wks-001'] } }
const seven = { title: 'Isolate seven', actionType: 'graph_containment', payload: {}, targets: { devices: ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'] } }
const release = { title: 'Rollback: release 2 device(s)', actionType: 'graph_containment', payload: { action: 'unisolate' }, targets: { devices: ['a', 'b'] } }
const all = (t: ReturnType<typeof confirmText>) => [t.title, t.lead, t.effect, t.confirmLabel, ...t.targets].join(' ')

describe('confirmation text (#126)', () => {
  it('approve names the action and the one target, and says it does not run yet', () => {
    const t = confirmText('approve', one, 'on')
    expect(t.title).toBe('Approve "Isolate demo-wks-001"?')
    expect(t.lead).toBe('Action: Isolate a device. Targets: demo-wks-001.')
    expect(t.effect).toMatch(/does not run it/)
    expect(t.confirmLabel).toBe('Approve demo-wks-001')
    expect(t.tone).toBe('accent')
  })

  it('reject names the action and targets and says nothing is sent', () => {
    for (const mode of ['on', 'dry-run'] as const) {
      const t = confirmText('reject', seven, mode)
      expect(t.title).toBe('Reject "Isolate seven"?')
      expect(t.lead).toBe('Action: Isolate a device. Targets: d1, d2, d3, d4, d5 and 2 more.')
      expect(t.targets).toEqual(['d1', 'd2', 'd3', 'd4', 'd5', 'and 2 more'])
      expect(t.effect).toMatch(/Nothing is sent/)
      expect(t.tone).toBe('danger')
    }
  })

  it('live execute names targets, warns it changes the tenant, and counts them on the button', () => {
    const t = confirmText('exec', seven, 'on')
    expect(t.title).toBe('Execute "Isolate seven" in your tenant?')
    expect(t.effect).toMatch(/sends the calls to your tenant now/)
    expect(t.confirmLabel).toBe('Execute on 7 devices')
    expect(confirmText('exec', one, 'on').confirmLabel).toBe('Execute on 1 device')
    expect(t.tone).toBe('danger')
  })

  it('dry-run execute reads "Record dry run" and never claims a change', () => {
    const t = confirmText('exec', one, 'dry-run')
    expect(t.confirmLabel).toBe('Record dry run')
    expect(t.title).toBe('Record a dry run of "Isolate demo-wks-001"?')
    expect(t.lead).toContain('demo-wks-001')
    expect(t.effect).toMatch(/Nothing is sent to your tenant/)
    expect(all(t)).not.toMatch(/Execute on|changes these targets/)
  })

  it('the live and dry-run execute buttons cannot be mistaken for each other', () => {
    expect(executeButtonLabel('on', seven.targets)).toBe('Execute on 7 devices…')
    expect(executeButtonLabel('dry-run', seven.targets)).toBe('Record dry run…')
    expect(executeButtonLabel('off', seven.targets)).toMatch(/off/)
    expect(confirmText('exec', seven, 'on').confirmLabel).not.toBe(confirmText('exec', seven, 'dry-run').confirmLabel)
  })

  it('an unisolate proposal never calls itself "Isolate" in any confirmation (#124)', () => {
    for (const kind of ['approve', 'reject', 'exec'] as const) {
      for (const mode of ['on', 'dry-run'] as const) {
        const t = confirmText(kind, release, mode)
        expect(t.lead).toContain('Release a device from isolation')
        expect(t.lead).not.toMatch(/Isolate a device/)
      }
    }
  })

  it('mixed targets and lists read as sentences', () => {
    expect(targetCount({ devices: ['a'], users: ['u'] })).toBe('2 targets')
    expect(targetCount({ users: ['u1', 'u2'] })).toBe('2 users')
    expect(targetCount({ incidents: ['i'] })).toBe('1 incident')
    expect(targetSentence(['a'])).toBe('a')
    expect(targetSentence(['a', 'b', 'c'])).toBe('a, b and c')
    expect(targetSentence([])).toBe('no named target')
    expect(listTargets(['a', 'b'])).toEqual(['a', 'b'])
    expect(confirmText('approve', { ...one, targets: { devices: ['a'], users: ['u'] } }, 'on').confirmLabel).toBe('Approve 2 targets')
  })

  it('no confirmation text uses an em dash', () => {
    for (const kind of ['approve', 'reject', 'exec'] as const) for (const mode of ['on', 'dry-run'] as const) expect(all(confirmText(kind, seven, mode))).not.toContain('—')
  })
})

describe('execution state (#121)', () => {
  const claim = { status: 'in_progress', mode: 'live', by: 'u1', at: '2026-11-11T01:00:00.000Z' }

  it('an in-progress claim is its own state and never says dry run or "Nothing was sent"', () => {
    expect(executionState(claim)).toBe('in_progress')
    // Claims written before this fix have no mode. They must not read as a dry run either.
    for (const c of [claim, { status: 'in_progress', by: 'u1', at: claim.at }]) {
      const intro = executionIntro(c, '12:00 pm AEDT', 'amy@example.test')
      expect(intro).toBe('Execution started at 12:00 pm AEDT by amy@example.test. Result not recorded yet.')
      expect(intro).not.toMatch(/dry.run|Nothing was sent/i)
    }
    expect(outcomeTone('in_progress')).toBe('warn')
  })

  it('a missing mode is unknown, not dry run', () => {
    const intro = executionIntro({ status: 'succeeded' }, 'x', 'y')
    expect(executionState({ status: 'succeeded' })).toBe('unknown')
    expect(intro).not.toMatch(/Nothing was sent/)
  })

  it('a stale claim swept to failed reads as outcome unknown', () => {
    const swept = { ...claim, status: 'failed', error: 'Outcome unknown.' }
    expect(executionState(swept)).toBe('outcome_unknown')
    expect(executionIntro(swept, 't', 'w')).toMatch(/never recorded/)
    expect(executionIntro(swept, 't', 'w')).not.toMatch(/Nothing was sent/)
  })

  it('only an explicit dry-run record says nothing was sent', () => {
    expect(executionIntro({ mode: 'dry-run', status: 'planned', calls: [] }, 't', 'w')).toBe('Recorded in dry-run mode. Nothing was sent.')
    expect(executionIntro({ mode: 'live', status: 'failed', calls: [] }, 't', 'w')).toBe('Calls sent to your tenant and their responses.')
  })
})

describe('decision controls (#177)', () => {
  const base = { status: 'pending' as const, canApprove: true, isRequester: false, selfApprovalAllowed: false, hasExecution: false, executorMode: 'on' as const }

  it('a requester sees no approve or reject controls on their own proposal when self-approval is off', () => {
    const c = decisionControls({ ...base, isRequester: true })
    expect(c.blockedSelf).toBe(true)
    expect(c.decide).toBe(false)
    expect(c.dryRun).toBe(true)
    expect(decisionControls({ ...base, isRequester: true, selfApprovalAllowed: true }).decide).toBe(true)
  })

  it('analysts get no controls; execute only for approved, unclaimed proposals; off disables it', () => {
    expect(decisionControls({ ...base, canApprove: false })).toMatchObject({ decide: false, dryRun: false, execute: false })
    expect(decisionControls({ ...base, status: 'approved' })).toMatchObject({ decide: false, execute: true, executeDisabled: false })
    expect(decisionControls({ ...base, status: 'approved', hasExecution: true }).execute).toBe(false)
    expect(decisionControls({ ...base, status: 'approved', executorMode: 'off' }).executeDisabled).toBe(true)
    for (const status of ['rejected', 'expired', 'executed', 'failed'] as const) expect(decisionControls({ ...base, status })).toMatchObject({ decide: false, execute: false, dryRun: false })
  })

  it('the comment limit matches the server (1,000 characters)', () => {
    expect(COMMENT_MAX).toBe(1000)
    expect(readFileSync(path.resolve(__dirname, '../src/fns/approvals.ts'), 'utf8')).toContain('comment: z.string().max(1000)')
  })
})

describe('approval route wiring (#125, #127, #170)', () => {
  const read = (f: string) => readFileSync(path.resolve(__dirname, '../src/routes', f), 'utf8')

  it('the detail route remounts when the proposal id changes, so no comment or confirmation carries over', () => {
    expect(read('app.approvals.$id.tsx')).toMatch(/remountDeps:\s*\(\{ params \}\) => params/)
  })

  it('every approval confirmation is the shared modal dialog, not an inline alertdialog div', () => {
    const decision = read('-approvals/decision.tsx')
    expect(decision).toContain('<ConfirmDialog')
    for (const f of ['app.approvals.$id.tsx', '-approvals/decision.tsx']) expect(read(f)).not.toMatch(/role="alertdialog"|ConfirmBox/)
  })

  it('the detail page does not load the inbox; the layout route has no loader', () => {
    expect(read('app.approvals.tsx')).not.toMatch(/loader|fetchInbox|fetchProposals/)
    expect(read('app.approvals.$id.tsx')).not.toMatch(/fetchInbox|fetchProposals/)
    expect(read('app.approvals.index.tsx')).toContain('fetchInbox')
  })
})
