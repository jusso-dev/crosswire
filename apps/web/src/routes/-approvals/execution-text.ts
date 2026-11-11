/**
 * What the Execution panel says (#121). Pure, so the rule is tested: dry-run wording appears only when
 * the recorded mode is explicitly a dry run. A claim that is still in progress, or a record with no
 * mode, never says "Nothing was sent", because calls may already have reached the tenant.
 */

export type ExecutionState = 'in_progress' | 'outcome_unknown' | 'live' | 'dry-run' | 'unknown'

export interface ExecutionRecord {
  mode?: unknown
  status?: unknown
  by?: unknown
  at?: unknown
  error?: unknown
  calls?: unknown
}

export function executionState(exec: ExecutionRecord): ExecutionState {
  if (exec.status === 'in_progress') return 'in_progress'
  // A claim the worker marked failed because no result was ever written: no calls are on record.
  if (exec.status === 'failed' && exec.mode !== 'dry-run' && !Array.isArray(exec.calls)) return 'outcome_unknown'
  if (exec.mode === 'live') return 'live'
  if (exec.mode === 'dry-run') return 'dry-run'
  return 'unknown'
}

/**
 * Intro line for the panel. `when` and `who` are already formatted for display.
 */
export function executionIntro(exec: ExecutionRecord, when: string, who: string) {
  switch (executionState(exec)) {
    case 'in_progress':
      return `Execution started at ${when} by ${who}. Result not recorded yet.`
    case 'outcome_unknown':
      return `Execution started at ${when} by ${who}, but the result was never recorded. Calls may have reached your tenant.`
    case 'live':
      return 'Calls sent to your tenant and their responses.'
    case 'dry-run':
      return 'Recorded in dry-run mode. Nothing was sent.'
    case 'unknown':
      return 'Crosswire did not record whether this ran live or as a dry run. Check the tenant before doing anything else.'
  }
}

/** Badge tone for an execution or dry-run status. In progress is a warning, never a success or a failure. */
export function outcomeTone(status: unknown): 'ok' | 'info' | 'warn' | 'danger' {
  if (status === 'succeeded') return 'ok'
  if (status === 'planned') return 'info'
  if (status === 'in_progress' || status === 'blocked') return 'warn'
  return 'danger'
}
