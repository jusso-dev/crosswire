import { exportBundleFn } from '../../fns/approvals'
import { useAction } from '../../components/action'
import { fmtTimeExact } from '../../components/format'
import { Notice } from '../../components/ui'
import { responseEventLabel } from '../../shared/labels'

type TimelineEvent = { id: string; event: string; actorType: string; actorId: string | null; data: Record<string, unknown>; createdAt: string }

/** Every step on a proposal, oldest first, with plain labels and exact times. */
export function Timeline({ proposalId, events, isOwner, who }: { proposalId: string; events: TimelineEvent[]; isOwner: boolean; who: (type: string, id: string | null) => string }) {
  const { run, busy, error } = useAction()
  const download = () =>
    run('bundle', async () => {
      const bundle = await exportBundleFn({ data: { id: proposalId } })
      const url = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }))
      const a = document.createElement('a')
      a.href = url
      a.download = `crosswire-action-${proposalId}.json`
      a.click()
      URL.revokeObjectURL(url)
    })
  return (
    <section className="cw-panel2" aria-labelledby="tl-title">
      <div className="cw-panel2-head">
        <h2 id="tl-title">Timeline</h2>
        <span className="cw-muted">Every step, oldest first.</span>
        <span className="cw-spacer" />
        {isOwner ? (
          <button type="button" className="cw-btn" data-variant="ghost" data-size="sm" disabled={busy !== null} onClick={() => void download()}>
            {busy ? 'Preparing…' : 'Download audit bundle'}
          </button>
        ) : (
          <span className="cw-muted">Owners can download the audit bundle.</span>
        )}
      </div>
      <div className="cw-panel2-body">
        {error && (
          <Notice tone="error" title="The audit bundle did not download">
            {error}
          </Notice>
        )}
        <ol className="cw-timeline">
          {events.map((e) => {
            const comment = typeof e.data.comment === 'string' ? e.data.comment : ''
            return (
              <li key={e.id} data-kind={e.event === 'executed' ? 'result' : e.event === 'execute_failed' || e.event === 'rejected' ? 'failed' : undefined}>
                <span className="cw-ev-label">{e.event === 'execute_failed' && e.data.reason === 'stale_claim' ? 'Execution outcome unknown' : responseEventLabel(e.event)}</span>
                <span className="cw-tl-time">
                  <time dateTime={e.createdAt}>{fmtTimeExact(e.createdAt)}</time> · {who(e.actorType, e.actorId)}
                </span>
                {comment && <p>“{comment}”</p>}
                {Object.keys(e.data).length > 0 && (
                  <details>
                    <summary>Technical details</summary>
                    <pre>{JSON.stringify(e.data, null, 2)}</pre>
                  </details>
                )}
              </li>
            )
          })}
        </ol>
      </div>
    </section>
  )
}
