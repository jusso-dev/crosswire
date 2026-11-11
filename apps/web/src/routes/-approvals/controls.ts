import type { ResponseStatus } from '../../shared/response'
import type { ExecutorMode } from './confirm-text'

/**
 * Which decision controls the approval page shows. Pure, so the screen rules are tested. The server
 * enforces every one of them again (role, requester separation, status, executor flag); this only
 * keeps the page from offering a step the server would refuse.
 */
export interface ControlInput {
  status: ResponseStatus
  canApprove: boolean
  isRequester: boolean
  selfApprovalAllowed: boolean
  hasExecution: boolean
  executorMode: ExecutorMode
}

export interface Controls {
  /** The person asked for this action and self-approval is off, so they see why instead of buttons. */
  blockedSelf: boolean
  dryRun: boolean
  decide: boolean
  execute: boolean
  /** Execute is shown but cannot be pressed (executor off). */
  executeDisabled: boolean
}

export function decisionControls(c: ControlInput): Controls {
  const blockedSelf = c.isRequester && !c.selfApprovalAllowed
  const execute = c.canApprove && c.status === 'approved' && !c.hasExecution
  return {
    blockedSelf,
    dryRun: c.canApprove && (c.status === 'pending' || c.status === 'approved'),
    decide: c.canApprove && c.status === 'pending' && !blockedSelf,
    execute,
    executeDisabled: execute && c.executorMode === 'off',
  }
}

export const COMMENT_MAX = 1000
