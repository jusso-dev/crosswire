import { responseActionLabel } from '../../shared/labels'
import type { ResponseTargets } from '../../shared/response'

/**
 * Words for the approve, reject and execute confirmations (#126). Pure, so every text is tested.
 * Each body names the action and its targets. The execute button says what pressing it does:
 * "Execute on 3 devices" when the executor is live, "Record dry run" when it is not.
 */

export type ConfirmKind = 'approve' | 'reject' | 'exec'
export type ExecutorMode = 'on' | 'dry-run' | 'off'

export interface ConfirmSubject {
  title: string
  actionType: string
  payload?: Record<string, unknown> | null
  targets: ResponseTargets
}

export interface ConfirmText {
  title: string
  /** One sentence naming the action and what the decision does. */
  lead: string
  /** Up to five target names, then "and N more". */
  targets: string[]
  /** What happens next, in one sentence. */
  effect: string
  confirmLabel: string
  tone: 'accent' | 'danger'
}

const MAX_LISTED = 5

/** Every named target, devices first, then users, then incidents. */
export function targetNames(t: ResponseTargets) {
  return [...(t.devices ?? []), ...(t.users ?? []), ...(t.incidents ?? [])]
}

/** "demo-wks-001", or "a, b, c, d, e and 2 more". */
export function listTargets(names: string[], max = MAX_LISTED): string[] {
  if (names.length <= max) return names
  return [...names.slice(0, max), `and ${names.length - max} more`]
}

/** Sentence form of a list: "a", "a and b", "a, b and c", "a, b, c, d, e and 2 more". */
export function targetSentence(names: string[], max = MAX_LISTED) {
  if (names.length === 0) return 'no named target'
  const shown = names.slice(0, max)
  const rest = names.length - shown.length
  if (rest > 0) return `${shown.join(', ')} and ${rest} more`
  return shown.length === 1 ? shown[0]! : `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}`
}

/** "3 devices", "1 user", "2 targets" (mixed kinds). */
export function targetCount(t: ResponseTargets) {
  const kinds: Array<[number, string, string]> = [
    [t.devices?.length ?? 0, 'device', 'devices'],
    [t.users?.length ?? 0, 'user', 'users'],
    [t.incidents?.length ?? 0, 'incident', 'incidents'],
  ]
  const present = kinds.filter(([n]) => n > 0)
  const total = present.reduce((sum, [n]) => sum + n, 0)
  if (present.length === 1) {
    const [n, one, many] = present[0]!
    return `${n} ${n === 1 ? one : many}`
  }
  return `${total} ${total === 1 ? 'target' : 'targets'}`
}

export function confirmText(kind: ConfirmKind, p: ConfirmSubject, executorMode: ExecutorMode): ConfirmText {
  const action = responseActionLabel(p.actionType, p.payload)
  const names = targetNames(p.targets)
  const targets = listTargets(names)
  const on = names.length === 0 ? 'its targets' : names.length === 1 ? names[0]! : targetCount(p.targets)
  switch (kind) {
    case 'approve':
      return {
        title: `Approve "${p.title}"?`,
        lead: `Action: ${action}. Targets: ${targetSentence(names)}.`,
        targets,
        effect: 'Approving does not run it. An approver still has to execute it before it expires.',
        confirmLabel: `Approve ${on}`,
        tone: 'accent',
      }
    case 'reject':
      return {
        title: `Reject "${p.title}"?`,
        lead: `Action: ${action}. Targets: ${targetSentence(names)}.`,
        targets,
        effect: 'Rejecting closes this action. Nothing is sent. It cannot be approved later, so a new action would be needed.',
        confirmLabel: 'Reject action',
        tone: 'danger',
      }
    case 'exec':
      return executorMode === 'on'
        ? {
            title: `Execute "${p.title}" in your tenant?`,
            lead: `Action: ${action}. Targets: ${targetSentence(names)}.`,
            targets,
            effect: 'This sends the calls to your tenant now and changes these targets. It cannot be undone from here. A rollback is a new action that needs its own approval.',
            confirmLabel: `Execute on ${targetCount(p.targets)}`,
            tone: 'danger',
          }
        : {
            title: `Record a dry run of "${p.title}"?`,
            lead: `Action: ${action}. Targets: ${targetSentence(names)}.`,
            targets,
            effect: 'The executor is in dry-run mode, so this records the planned calls only. Nothing is sent to your tenant.',
            confirmLabel: 'Record dry run',
            tone: 'accent',
          }
  }
}

/** Label of the button that opens the execute confirmation. */
export function executeButtonLabel(executorMode: ExecutorMode, t: ResponseTargets) {
  if (executorMode === 'on') return `Execute on ${targetCount(t)}…`
  if (executorMode === 'dry-run') return 'Record dry run…'
  return 'Execute (executor off)'
}
