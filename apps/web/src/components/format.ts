/** Display timestamps in the viewer's local zone; storage is always UTC. */
export function fmtTime(iso: string | null | undefined) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

export function statusTone(status: string): 'ok' | 'warn' | 'danger' | undefined {
  if (['approved', 'executed', 'run', 'success', 'open'].includes(status)) return 'ok'
  if (['pending', 'proposed', 'dry-run'].includes(status)) return 'warn'
  if (['rejected', 'failed', 'expired', 'failure'].includes(status)) return 'danger'
  return undefined
}
