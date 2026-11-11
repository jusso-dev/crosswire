import { useState } from 'react'
import { useRouter } from '@tanstack/react-router'
import { decideFn, dryRunFn, executeFn } from '../../fns/approvals'
import { ConfirmDialog } from '../../components/confirm'
import { useAction } from '../../components/action'
import { Notice } from '../../components/ui'
import type { ResponseProposalView } from '../../shared/response'
import { confirmText, executeButtonLabel, type ConfirmKind, type ExecutorMode } from './confirm-text'
import { COMMENT_MAX, decisionControls } from './controls'

/**
 * "Your decision": dry run, approve, reject and execute. Every tenant-changing step goes through a
 * modal confirmation that names the action and its targets. The server re-checks role, requester
 * separation, status, expiry, content binding and the executor flag on every call.
 */
export function DecisionPanel({
  p,
  executorMode,
  canApprove,
  isRequester,
  selfApprovalAllowed,
  hasDryRun,
}: {
  p: ResponseProposalView
  executorMode: ExecutorMode
  canApprove: boolean
  isRequester: boolean
  selfApprovalAllowed: boolean
  hasDryRun: boolean
}) {
  const router = useRouter()
  const { run, busy, error, setError } = useAction()
  const [comment, setComment] = useState('')
  const [confirming, setConfirming] = useState<ConfirmKind | null>(null)
  const c = decisionControls({ status: p.status, canApprove, isRequester, selfApprovalAllowed, hasExecution: p.execution !== null, executorMode })

  if (!canApprove) return <Notice tone="info">Only owners and approvers can decide or execute actions. You can still read everything here.</Notice>

  const step = async (label: string, fn: () => Promise<{ ok: boolean }>) => {
    const r = await run(label, fn)
    // Close the confirmation only when the step went through; a refusal stays visible inside it.
    if (r?.ok) {
      setConfirming(null)
      setComment('')
    }
    await router.invalidate().catch(() => {})
  }

  const text = confirming ? confirmText(confirming, p, executorMode) : null

  return (
    <section className="cw-panel2" aria-labelledby="decide-title">
      <div className="cw-panel2-head">
        <h2 id="decide-title">Your decision</h2>
        <span className="cw-muted">{executorMode === 'on' ? 'The executor is live. Executing changes your tenant.' : 'Safe mode: nothing runs in your tenant unless the executor is live.'}</span>
      </div>
      <div className="cw-panel2-body">
        {p.status === 'pending' && c.blockedSelf && (
          <Notice tone="warn" title="You cannot approve this one">
            You asked for this action, so another approver must decide it. This keeps two people on every change.
          </Notice>
        )}
        {error && !confirming && (
          <Notice tone="error" title="The server did not accept that step">
            {error}
          </Notice>
        )}
        {!hasDryRun && p.status !== 'executed' && <p className="cw-muted">Start with a dry run. It lists every call without changing anything.</p>}
        <div className="cw-row cw-decide">
          {c.dryRun && (
            <button type="button" className="cw-btn" data-variant="ghost" disabled={busy !== null} onClick={() => void step('dry', () => dryRunFn({ data: { id: p.id } }))}>
              {busy === 'dry' ? 'Running dry run…' : 'Dry run'}
            </button>
          )}
          {c.decide && (
            <>
              <label className="cw-grow">
                Comment (optional, saved with your decision)
                <input value={comment} maxLength={COMMENT_MAX} aria-describedby="decide-comment-count" onChange={(e) => setComment(e.target.value)} placeholder="Why you approve or reject" />
                <span id="decide-comment-count" className="cw-muted cw-approvals-count" aria-live="polite">
                  {comment.length} of {COMMENT_MAX} characters
                </span>
              </label>
              <button type="button" className="cw-btn" disabled={busy !== null} onClick={() => (setError(null), setConfirming('approve'))}>
                Approve…
              </button>
              <button type="button" className="cw-btn" data-variant="danger" disabled={busy !== null} onClick={() => (setError(null), setConfirming('reject'))}>
                Reject…
              </button>
            </>
          )}
          {c.execute && (
            <button type="button" className="cw-btn" data-variant={executorMode === 'on' ? 'danger' : 'ghost'} disabled={busy !== null || c.executeDisabled} aria-describedby="exec-help" onClick={() => (setError(null), setConfirming('exec'))}>
              {executeButtonLabel(executorMode, p.targets)}
            </button>
          )}
        </div>
        {c.execute && (
          <p id="exec-help" className="cw-muted cw-mt-xs">
            {executorMode === 'off' ? 'The executor for this action type is off, so it cannot run. An admin changes this through a change ticket.' : executorMode === 'dry-run' ? 'The executor is in dry-run mode: this records the planned calls only. Nothing is sent.' : 'The executor is live: this will change your tenant.'}
          </p>
        )}
        <ConfirmDialog
          open={text !== null}
          tone={text?.tone ?? 'accent'}
          title={text?.title ?? ''}
          body={
            text && (
              <>
                <p>{text.lead}</p>
                {text.targets.length > 1 && (
                  <ul aria-label="Targets">
                    {text.targets.map((t) => (
                      <li key={t} className={t.startsWith('and ') ? undefined : 'mono'}>
                        {t}
                      </li>
                    ))}
                  </ul>
                )}
                <p>{text.effect}</p>
                {confirming !== 'exec' && comment.trim() && <p className="cw-muted">Your comment is saved with the decision.</p>}
              </>
            )
          }
          confirmLabel={text?.confirmLabel ?? ''}
          busy={busy !== null}
          error={confirming ? error : null}
          onCancel={() => setConfirming(null)}
          onConfirm={() => {
            if (confirming === 'exec') void step('exec', () => executeFn({ data: { id: p.id } }))
            else if (confirming) void step(confirming, () => decideFn({ data: { id: p.id, decision: confirming, comment } }))
          }}
        />
      </div>
    </section>
  )
}
