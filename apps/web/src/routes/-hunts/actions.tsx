import { useState } from 'react'
import { useRouter } from '@tanstack/react-router'
import { approveKqlFn, huntReportFn, setHuntStatusFn } from '../../fns/hunts'
import { plural } from '../../components/format'
import { Notice } from '../../components/ui'
import { useAction } from '../../components/action'
import { ConfirmDialog } from '../../components/confirm'
import { plainMessage } from '../../shared/messages'
import { answerText } from '../../shared/indicator-playbooks'
import { coverageFor, type Proposal } from './model'
import { approveAllPlan, type ApproveAllItem, type KqlEdits } from './helpers'

type Outcome = { item: ApproveAllItem; ok: boolean; reason?: string }

/**
 * Approve every pending search (#123). Each search sends exactly the text its panel shows, edits
 * included; the confirmation says how many will run and how many were edited. Every search is tried,
 * and the result lists which ran and which did not. The server applies every KQL approval rule to
 * each one, as for a single approval. `allowed` hides the button (canApproveEveryProposal), but the
 * component stays mounted so the outcome is still shown once nothing is left to approve.
 */
export function ApproveAllButton({ allowed, proposals, edits }: { allowed: boolean; proposals: Proposal[]; edits: KqlEdits }) {
  const router = useRouter()
  const { run, busy, error } = useAction()
  const [confirming, setConfirming] = useState(false)
  const [outcomes, setOutcomes] = useState<Outcome[] | null>(null)
  const plan = approveAllPlan(proposals, edits)
  const editedCount = plan.filter((i) => i.edited).length

  const approveAll = async () => {
    const results: Outcome[] = []
    await run('approve-all', async () => {
      try {
        for (const item of plan) {
          try {
            const r = await approveKqlFn({ data: { proposalId: item.proposalId, kql: item.kql } })
            if (!r.ok) results.push({ item, ok: false, reason: plainMessage(r.error) })
            else if (r.status === 'failed') results.push({ item, ok: false, reason: plainMessage(r.error) })
            else results.push({ item, ok: true })
          } catch (err) {
            results.push({ item, ok: false, reason: plainMessage(err) })
          }
        }
      } finally {
        setOutcomes(results)
        setConfirming(false)
        await router.invalidate()
      }
    })
  }

  const failed = outcomes?.filter((o) => !o.ok) ?? []
  return (
    <>
      {(allowed || busy !== null) && (
        <button type="button" className="cw-btn" disabled={busy !== null || plan.length === 0} aria-busy={busy !== null || undefined} onClick={() => setConfirming(true)}>
          {busy ? 'Running…' : `Approve all checks (${plan.length})…`}
        </button>
      )}
      <ConfirmDialog
        open={confirming && allowed}
        title={`Approve and run ${plural(plan.length, 'search', 'searches')}?`}
        body={
          <>
            <p>
              {plural(plan.length, 'search', 'searches')} will run in your tenant, one after another, exactly as shown on this page.
              {editedCount > 0 ? ` ${plural(editedCount, 'search was', 'searches were')} edited, and the edited text is what will run.` : ' None were edited.'}
            </p>
            <ul>
              {plan.map((i) => (
                <li key={i.proposalId}>
                  {i.name}
                  {i.edited ? ' (edited)' : ''}
                </li>
              ))}
            </ul>
          </>
        }
        confirmLabel={`Approve and run ${plan.length}`}
        busy={busy !== null}
        onCancel={() => setConfirming(false)}
        onConfirm={() => void approveAll()}
      />
      {error && <span className="cw-field-error">{error}</span>}
      {outcomes && (
        <div className="cw-approveall-result" role="status">
          <Notice tone={failed.length ? 'warn' : 'ok'} title={failed.length ? `${outcomes.length - failed.length} of ${outcomes.length} searches ran` : `All ${plural(outcomes.length, 'search', 'searches')} ran`}>
            <ul>
              {outcomes.map((o) => (
                <li key={o.item.proposalId}>
                  {o.item.name}: {o.ok ? 'ran' : `did not run. ${o.reason ?? ''}`}
                </li>
              ))}
            </ul>
            <button type="button" className="cw-linkbtn" onClick={() => setOutcomes(null)}>
              Dismiss
            </button>
          </Notice>
        </div>
      )}
    </>
  )
}

/** Close or reopen the hunt. Closing pauses every repeat search on it, so it asks first (#130). */
export function HuntStatusButton({ hunt, activeSchedules, canManage }: { hunt: { id: string; title: string; status: string }; activeSchedules: number; canManage: boolean }) {
  const router = useRouter()
  const { run, busy, error, setError } = useAction()
  const [confirming, setConfirming] = useState(false)
  const closing = hunt.status === 'open'
  // The server refuses anyone else; say so here instead of offering a button that fails.
  if (!canManage) return <span className="cw-muted">An owner or approver can {closing ? 'close' : 'reopen'} this hunt.</span>

  const apply = async () => {
    const r = await run('status', async () => {
      const r = await setHuntStatusFn({ data: { huntId: hunt.id, status: closing ? 'closed' : 'open' } })
      if (r.ok) await router.invalidate()
      return r
    })
    if (r?.ok) setConfirming(false)
  }

  return (
    <>
      <button
        type="button"
        className="cw-btn"
        data-variant="ghost"
        disabled={busy !== null}
        aria-busy={busy !== null || undefined}
        onClick={() => {
          setError(null)
          if (closing) setConfirming(true)
          else void apply()
        }}
      >
        {busy && !confirming ? 'Working…' : closing ? 'Close hunt…' : 'Reopen hunt'}
      </button>
      {error && !confirming && <span className="cw-field-error">{error}</span>}
      <ConfirmDialog
        open={confirming}
        tone="danger"
        title={`Close the hunt "${hunt.title}"?`}
        body={
          <p>
            {activeSchedules > 0
              ? `${plural(activeSchedules, 'repeat search', 'repeat searches')} on this hunt will stop. Reopening the hunt does not restart them: an approver must re-approve each one.`
              : 'No repeat searches are running on this hunt. You can reopen it later.'}
          </p>
        }
        confirmLabel="Close hunt"
        busy={busy !== null}
        error={confirming ? error : null}
        onCancel={() => setConfirming(false)}
        onConfirm={() => void apply()}
      />
    </>
  )
}

export function CopyAnswerButton({ proposals }: { proposals: Proposal[] }) {
  const [copied, setCopied] = useState(false)
  const [failed, setFailed] = useState(false)
  return (
    <button
      type="button"
      className="cw-btn"
      data-variant="ghost"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(answerText(coverageFor(proposals)))
          setFailed(false)
          setCopied(true)
          window.setTimeout(() => setCopied(false), 2000)
        } catch {
          setFailed(true)
        }
      }}
    >
      {copied ? 'Copied' : failed ? 'Copy failed: clipboard not available' : 'Copy answer'}
    </button>
  )
}

export function ExportButton({ huntId }: { huntId: string }) {
  const { run, busy, error } = useAction()
  return (
    <>
      <button
        type="button"
        className="cw-btn"
        data-variant="ghost"
        disabled={busy !== null}
        aria-busy={busy !== null || undefined}
        onClick={() =>
          void run('export', async () => {
            const r = await huntReportFn({ data: { huntId } })
            const url = URL.createObjectURL(new Blob([r.markdown], { type: 'text/markdown' }))
            const a = document.createElement('a')
            a.href = url
            a.download = r.filename
            a.click()
            URL.revokeObjectURL(url)
          })
        }
      >
        {busy ? 'Exporting…' : 'Export report'}
      </button>
      {error && <span className="cw-field-error">{error}</span>}
    </>
  )
}
