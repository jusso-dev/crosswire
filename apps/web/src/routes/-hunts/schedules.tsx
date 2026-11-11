import { useState } from 'react'
import { useRouter } from '@tanstack/react-router'
import { createScheduleFn, disableScheduleFn, reapproveScheduleFn } from '../../fns/hunts'
import { fmtTime, plural } from '../../components/format'
import { Notice, TableWrap } from '../../components/ui'
import { useAction } from '../../components/action'
import { ConfirmDialog } from '../../components/confirm'
import { plainMessage } from '../../shared/messages'
import { Freshness, TARGET_LABEL } from '../../components/signals'
import type { Data, Schedule } from './model'
import { intervalText, personName } from './helpers'

export function Schedules({ data }: { data: Data }) {
  const router = useRouter()
  const { run, busy, error, setError } = useAction()
  const ran = data.proposals.filter((p) => p.status === 'run')
  const [every, setEvery] = useState(1440)
  const [picked, setPick] = useState<string | null>(null)
  const [reapproving, setReapproving] = useState<Schedule | null>(null)
  // Derived each render, so a search that ran after the page opened is selectable and submitted correctly.
  const pick = picked && ran.some((p) => p.id === picked) ? picked : (ran[0]?.id ?? '')

  const pause = (s: Schedule) =>
    run(`pause:${s.id}`, async () => {
      const r = await disableScheduleFn({ data: { id: s.id } })
      await router.invalidate()
      return r
    })
  const reapprove = async (s: Schedule) => {
    const r = await run(`reapprove:${s.id}`, async () => {
      const r = await reapproveScheduleFn({ data: { id: s.id } })
      await router.invalidate()
      return r
    })
    if (r?.ok) setReapproving(null)
  }
  const create = () =>
    run('create', async () => {
      const r = await createScheduleFn({ data: { proposalId: pick, intervalMinutes: every } })
      await router.invalidate()
      return r
    })

  return (
    <section className="cw-panel2" aria-labelledby="sched-title">
      <div className="cw-panel2-head">
        <h2 id="sched-title">Repeat searches</h2>
        <span className="cw-muted">Re-run an approved search on a schedule. Approval lasts up to 30 days.</span>
      </div>
      <div className="cw-panel2-body">
        {error && !reapproving && (
          <Notice tone="error" title="That step did not complete">
            {error}
          </Notice>
        )}
        {data.schedules.length === 0 ? (
          <p className="cw-empty">No repeat searches.</p>
        ) : (
          <TableWrap label="Repeat searches">
            <table className="cw-table">
              <caption className="cw-sr-only">Repeat searches on this hunt</caption>
              <thead>
                <tr>
                  <th scope="col">Query</th>
                  <th scope="col">Runs</th>
                  <th scope="col">State</th>
                  <th scope="col">Last run</th>
                  <th scope="col">Approval until</th>
                  <th scope="col">
                    <span className="cw-sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.schedules.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <code className="cw-ellipsis cw-maxw-44ch" title={s.kql}>
                        {s.kql}
                      </code>
                      <span className="cw-muted">{TARGET_LABEL[s.target]}</span>
                    </td>
                    <td>{intervalText(s.intervalMinutes)}</td>
                    <td>
                      {s.enabled ? <span className="cw-badge" data-tone="ok">Active</span> : <span className="cw-badge">Paused</span>}
                      {!s.enabled && s.disabledReason && <div className="cw-muted">{s.disabledReason}</div>}
                      {s.enabled && <div className="cw-muted">next {fmtTime(s.nextRunAt)}</div>}
                    </td>
                    <td>
                      {s.lastRunAt ? (
                        <>
                          <Freshness at={s.lastRunAt} /> {s.lastRowCount !== null && <span className="num">· {plural(s.lastRowCount, 'row')}</span>}
                        </>
                      ) : (
                        <span className="cw-muted">not run yet</span>
                      )}
                      {s.lastError && <p className="cw-field-error cw-mt-2xs">{plainMessage(s.lastError)}</p>}
                    </td>
                    <td>
                      {fmtTime(s.approvalExpiresAt)}
                      <div className="cw-muted">by {personName(data.people, s.approvedBy)}</div>
                    </td>
                    <td>
                      {!data.canApprove ? (
                        <span className="cw-muted">Approvers manage this</span>
                      ) : s.enabled ? (
                        <button type="button" className="cw-btn" data-variant="ghost" data-size="sm" disabled={busy !== null} aria-busy={busy === `pause:${s.id}` || undefined} onClick={() => pause(s)}>
                          {busy === `pause:${s.id}` ? 'Working…' : 'Pause'}
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="cw-btn"
                          data-variant="ghost"
                          data-size="sm"
                          disabled={busy !== null}
                          onClick={() => {
                            setError(null)
                            setReapproving(s)
                          }}
                        >
                          Re-approve and resume…
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
        {ran.length > 0 &&
          (data.canApprove ? (
            <div className="cw-row cw-mt-sm">
              <label className="cw-grow cw-maxw-420">
                Search to repeat
                <select value={pick} onChange={(e) => setPick(e.target.value)}>
                  {ran.map((p) => (
                    <option key={p.id} value={p.id}>
                      {TARGET_LABEL[p.target]}: {p.kql.slice(0, 70)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Every
                <select value={every} onChange={(e) => setEvery(Number(e.target.value))}>
                  <option value={60}>hour</option>
                  <option value={360}>6 hours</option>
                  <option value={1440}>day</option>
                  <option value={10080}>week</option>
                </select>
              </label>
              <button type="button" className="cw-btn" data-variant="ghost" disabled={busy !== null || !pick} aria-busy={busy === 'create' || undefined} onClick={create}>
                {busy === 'create' ? 'Working…' : 'Schedule (30-day approval)'}
              </button>
            </div>
          ) : (
            <p className="cw-muted cw-mt-sm">
              Approvers and owners can turn a search that ran into a repeat search. Your role is {data.role}.
            </p>
          ))}
      </div>
      <ConfirmDialog
        open={reapproving !== null}
        title="Re-approve and resume this repeat search?"
        body={
          reapproving && (
            <>
              <p>
                This search will run in {TARGET_LABEL[reapproving.target]} {intervalText(reapproving.intervalMinutes)} for up to 30 days, approved by you. Read the full query before you approve it.
              </p>
              <pre aria-label="Query that will repeat">{reapproving.kql}</pre>
            </>
          )
        }
        confirmLabel="Re-approve and resume"
        busy={reapproving !== null && busy === `reapprove:${reapproving.id}`}
        error={reapproving ? error : null}
        onCancel={() => setReapproving(null)}
        onConfirm={() => reapproving && void reapprove(reapproving)}
      />
    </section>
  )
}
