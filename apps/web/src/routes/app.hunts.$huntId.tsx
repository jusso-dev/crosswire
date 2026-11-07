import { Link, createFileRoute, notFound, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { addNote, approveKqlFn, createScheduleFn, disableScheduleFn, fetchHunt, huntReportFn, proposeKqlFn, reapproveScheduleFn, rejectKqlFn, setHuntStatusFn } from '../fns/hunts'
import { fmtTime, statusTone } from '../components/format'

export const Route = createFileRoute('/app/hunts/$huntId')({
  loader: async ({ params }) => {
    const h = await fetchHunt({ data: { huntId: params.huntId } })
    if (!h) throw notFound()
    return h
  },
  component: HuntDetail,
})

type Loaded = ReturnType<typeof Route.useLoaderData>

function HuntDetail() {
  const { hunt, evidence, proposals, demoMode, schedules, canApprove } = Route.useLoaderData()
  const router = useRouter()
  const [note, setNote] = useState('')
  const [kql, setKql] = useState('')
  const [target, setTarget] = useState<'defender' | 'sentinel'>('defender')
  const [error, setError] = useState<string | null>(null)

  return (
    <>
      <p>
        <Link to="/app/hunts">← Hunts</Link>
      </p>
      <h1>{hunt.title}</h1>
      <p>
        <span className="cw-badge" data-tone={statusTone(hunt.status)}>
          {hunt.status}
        </span>{' '}
        <button
          className="cw-btn"
          data-variant="ghost"
          onClick={async () => {
            await setHuntStatusFn({ data: { huntId: hunt.id, status: hunt.status === 'open' ? 'closed' : 'open' } })
            await router.invalidate()
          }}
        >
          {hunt.status === 'open' ? 'Close case' : 'Reopen case'}
        </button>{' '}
        <button
          className="cw-btn"
          data-variant="ghost"
          onClick={async () => {
            try {
              const r = await huntReportFn({ data: { huntId: hunt.id } })
              const url = URL.createObjectURL(new Blob([r.markdown], { type: 'text/markdown' }))
              const a = document.createElement('a')
              a.href = url
              a.download = r.filename
              a.click()
              URL.revokeObjectURL(url)
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err))
            }
          }}
        >
          Export report (Markdown)
        </button>
      </p>
      {hunt.hypothesis && <p>{hunt.hypothesis}</p>}
      {demoMode && <p className="cw-banner">Demo mode: no hunting connector is configured for this org, so queries return labelled fixture data, not tenant data.</p>}
      {error && (
        <p className="cw-error" role="alert">
          {error}
        </p>
      )}

      <h2>KQL proposals</h2>
      <p className="cw-muted">Proposed queries never run until a person reviews, optionally edits, and approves them. The stored query is exactly what ran.</p>
      {proposals.length === 0 && <p className="cw-empty">No proposals yet. Ask Hunter in chat, or propose one below.</p>}
      {proposals.map((p) => (
        <ProposalCard key={p.id} p={p} onError={setError} canSchedule={canApprove} />
      ))}

      <h2>Scheduled runs</h2>
      <p className="cw-muted">An approver can schedule a query that already ran. The stored query is frozen; approval lasts up to 30 days, then the schedule stops until someone re-approves it.</p>
      {schedules.length === 0 ? (
        <p className="cw-empty">No schedules.</p>
      ) : (
        <table className="cw-table">
          <thead>
            <tr>
              <th>Query</th>
              <th>Every</th>
              <th>Status</th>
              <th>Approval until</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {schedules.map((s) => (
              <tr key={s.id}>
                <td>
                  <span className="cw-muted">{s.target}</span>
                  <pre>{s.kql}</pre>
                </td>
                <td>{s.intervalMinutes} min</td>
                <td>
                  {s.enabled ? `enabled · next ${fmtTime(s.nextRunAt)}` : `disabled: ${s.disabledReason ?? ''}`}
                  {s.lastRunAt && (
                    <div className="cw-muted">
                      last {s.lastStatus} {fmtTime(s.lastRunAt)}
                      {s.lastRowCount !== null ? ` · ${s.lastRowCount} rows` : ''}
                    </div>
                  )}
                  {s.lastError && <div className="cw-error">{s.lastError}</div>}
                </td>
                <td>{fmtTime(s.approvalExpiresAt)}</td>
                <td>
                  {canApprove && (
                    <button
                      className="cw-btn"
                      data-variant="ghost"
                      onClick={async () => {
                        const r = s.enabled ? await disableScheduleFn({ data: { id: s.id } }) : await reapproveScheduleFn({ data: { id: s.id } })
                        setError(r.ok ? null : r.error)
                        await router.invalidate()
                      }}
                    >
                      {s.enabled ? 'Disable' : 'Re-approve and enable'}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <form
        className="cw-form"
        style={{ maxWidth: '100%' }}
        onSubmit={async (e) => {
          e.preventDefault()
          const r = await proposeKqlFn({ data: { huntId: hunt.id, target, kql } })
          if (!r.ok) setError(r.error)
          else setKql('')
          await router.invalidate()
        }}
      >
        <div className="cw-row">
          <label>
            Target
            <select value={target} onChange={(e) => setTarget(e.target.value as 'defender' | 'sentinel')}>
              <option value="defender">Defender XDR (Advanced Hunting)</option>
              <option value="sentinel">Sentinel (Log Analytics)</option>
            </select>
          </label>
        </div>
        <label>
          KQL
          <textarea className="mono" rows={5} value={kql} onChange={(e) => setKql(e.target.value)} required />
        </label>
        <div>
          <button className="cw-btn" type="submit">
            Propose query
          </button>
        </div>
      </form>

      <h2>Evidence trail</h2>
      <ol className="cw-timeline">
        {evidence.map((e) => (
          <li key={e.id}>
            <strong>{e.type}</strong>{' '}
            <span className="cw-muted">
              {e.actorType} {e.actorId ?? ''} · {fmtTime(e.createdAt)}
            </span>
            <EvidenceBody payload={e.payload} />
          </li>
        ))}
      </ol>
      <form
        className="cw-form"
        onSubmit={async (e) => {
          e.preventDefault()
          await addNote({ data: { huntId: hunt.id, note } })
          setNote('')
          await router.invalidate()
        }}
      >
        <label>
          Add note
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} required />
        </label>
        <div>
          <button className="cw-btn" data-variant="ghost" type="submit">
            Add note
          </button>
        </div>
      </form>
    </>
  )
}

function EvidenceBody({ payload }: { payload: Record<string, unknown> }) {
  if (typeof payload.note === 'string') return <p>{payload.note}</p>
  if (typeof payload.rowCount === 'number') {
    const sample = (payload.sample as Array<Record<string, unknown>> | undefined) ?? []
    const cols = (payload.columns as string[] | undefined) ?? []
    return (
      <div>
        <p className="cw-muted">
          {String(payload.mode)} · {payload.rowCount as number} rows{payload.truncated ? ' (truncated to cap)' : ''} · approved by {String(payload.approvedBy ?? '')}
        </p>
        {typeof payload.kql === 'string' && <pre>{payload.kql}</pre>}
        {sample.length > 0 && (
          <div style={{ overflow: 'auto' }}>
            <table className="cw-table">
              <thead>
                <tr>
                  {cols.map((c) => (
                    <th key={c}>{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sample.slice(0, 10).map((r, i) => (
                  <tr key={i}>
                    {cols.map((c) => (
                      <td key={c}>{String(r[c] ?? '')}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    )
  }
  return <pre>{JSON.stringify(payload, null, 2)}</pre>
}

function ProposalCard({ p, onError, canSchedule }: { p: Loaded['proposals'][number]; onError: (e: string | null) => void; canSchedule: boolean }) {
  const router = useRouter()
  const [kql, setKql] = useState(p.kql)
  const [every, setEvery] = useState(1440)
  const [busy, setBusy] = useState(false)
  const pending = p.status === 'proposed'
  return (
    <section className="cw-card" style={{ marginBottom: 12 }}>
      <div className="cw-msg-meta">
        <span className="cw-badge" data-tone={statusTone(p.status)}>
          {p.status}
        </span>
        <span>{p.target}</span>
        <span>
          by {p.proposedByType} {p.proposedById}
        </span>
        <span>expires {fmtTime(p.expiresAt)}</span>
      </div>
      {p.rationale && <p>{p.rationale}</p>}
      {pending ? (
        <label>
          Review and edit before running
          <textarea className="mono" rows={5} value={kql} onChange={(e) => setKql(e.target.value)} />
        </label>
      ) : (
        <pre>{p.kql}</pre>
      )}
      {pending && kql !== p.originalKql && <p className="cw-muted">Edited from the original proposal.</p>}
      {p.error && <p className="cw-error">{p.error}</p>}
      {p.status === 'run' && canSchedule && (
        <div className="cw-row">
          <label>
            Run this exact query every
            <select aria-label="Schedule interval" value={every} onChange={(e) => setEvery(Number(e.target.value))}>
              <option value={60}>hour</option>
              <option value={360}>6 hours</option>
              <option value={1440}>day</option>
              <option value={10080}>week</option>
            </select>
          </label>
          <button
            className="cw-btn"
            data-variant="ghost"
            onClick={async () => {
              const r = await createScheduleFn({ data: { proposalId: p.id, intervalMinutes: every } })
              onError(r.ok ? null : r.error)
              await router.invalidate()
            }}
          >
            Schedule (30-day approval)
          </button>
        </div>
      )}
      {pending && (
        <div className="cw-row">
          <button
            className="cw-btn"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              const r = await approveKqlFn({ data: { proposalId: p.id, kql } })
              setBusy(false)
              onError(r.ok ? (r.status === 'failed' ? r.error : null) : r.error)
              await router.invalidate()
            }}
          >
            Approve and run
          </button>
          <button
            className="cw-btn"
            data-variant="ghost"
            disabled={busy}
            onClick={async () => {
              const r = await rejectKqlFn({ data: { proposalId: p.id } })
              onError(r.ok ? null : r.error)
              await router.invalidate()
            }}
          >
            Reject
          </button>
        </div>
      )}
    </section>
  )
}
