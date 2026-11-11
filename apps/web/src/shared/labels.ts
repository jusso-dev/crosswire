/**
 * Plain words for stored keys, shared by every screen so two pages can never describe the same thing
 * differently. Pure, safe in client code.
 */

/** Response proposal events, matching the `response_events.event` column. A missing label is a type error. */
export type ResponseEventKind = 'created' | 'dry_run' | 'approved' | 'rejected' | 'expired' | 'execute_attempt' | 'executed' | 'execute_failed' | 'rollback_proposed'

export const RESPONSE_EVENT_LABEL: Record<ResponseEventKind, string> = {
  created: 'Proposed',
  dry_run: 'Dry run',
  approved: 'Approved',
  rejected: 'Rejected',
  expired: 'Expired',
  execute_attempt: 'Execution started',
  executed: 'Executed',
  execute_failed: 'Execution failed',
  rollback_proposed: 'Rollback proposed',
}

export function responseEventLabel(kind: string) {
  return (RESPONSE_EVENT_LABEL as Record<string, string>)[kind] ?? kind.replaceAll('_', ' ')
}

/**
 * What a response proposal does, in words. Reads the payload, because one action type can do
 * opposite things: graph_containment with `action: 'unisolate'` releases a device.
 */
export function responseActionLabel(actionType: string, payload?: Record<string, unknown> | null) {
  const action = typeof payload?.action === 'string' ? payload.action : undefined
  switch (actionType) {
    case 'sentinel_playbook':
      return 'Run a Sentinel playbook'
    case 'logic_app':
      return 'Run a Logic App'
    case 'graph_containment':
      return action === 'unisolate' ? 'Release a device from isolation' : 'Isolate a device'
    case 'other':
      return action === 'manual_rollback' ? 'Manual rollback' : 'Manual action'
    default:
      return actionType.replaceAll('_', ' ')
  }
}

/** Status words for response proposals and hunts. Unknown values are humanised, never shown raw. */
export const STATUS_WORD: Record<string, string> = {
  run: 'Ran',
  proposed: 'Needs review',
  approved: 'Approved',
  failed: 'Failed',
  rejected: 'Rejected',
  expired: 'Expired',
  open: 'Open',
  closed: 'Closed',
  pending: 'Pending',
  executed: 'Executed',
  in_progress: 'In progress',
  succeeded: 'Succeeded',
  planned: 'Planned',
  blocked: 'Refused',
  partial: 'Partly succeeded',
}

export function statusWord(status: string) {
  return STATUS_WORD[status] ?? status.replaceAll('_', ' ')
}
