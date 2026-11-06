import { createFileRoute, notFound, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { decideFn, dryRunFn, executeFn, exportBundleFn, fetchProposal } from '../fns/approvals'
import { fmtTime, statusTone } from '../components/format'

export const Route = createFileRoute('/app/approvals/$id')({
  loader: async ({ params }) => {
    const p = await fetchProposal({ data: { id: params.id } })
    if (!p) throw notFound()
    return p
  },
  component: ProposalDetail,
})

function ProposalDetail() {
  const { proposal: p, events, executorMode, canApprove, isRequester } = Route.useLoaderData()
  const router = useRouter()
  const [comment, setComment] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const act = async (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setBusy(true)
    setError(null)
    const r = await fn()
    setBusy(false)
    if (!r.ok) setError(r.error ?? 'Action failed')
    await router.invalidate()
  }

  return (
    <>
      <h1>{p.title}</h1>
      {p.payload.demo === true && <p className="cw-banner">Demo fixture: not a real proposal. Executors never contact a tenant for demo data in dry-run.</p>}
      <p>
        <span className="cw-badge" data-tone={statusTone(p.status)}>
          {p.status}
        </span>{' '}
        <span className="cw-muted">
          {p.actionType} · executor {executorMode} · expires {fmtTime(p.expiresAt)} · requested by {p.requesterType === 'agent' ? `agent ${p.requesterId}` : 'analyst'}
        </span>
      </p>
      <div className="cw-grid">
        <section className="cw-card">
          <h3>Blast radius</h3>
          <p>{p.blastRadius.summary}</p>
          <p className="cw-muted">
            {p.blastRadius.devices} devices · {p.blastRadius.users} users · {p.blastRadius.incidents} incidents
          </p>
        </section>
        <section className="cw-card">
          <h3>Targets</h3>
          <pre>{JSON.stringify(p.targets, null, 2)}</pre>
        </section>
        <section className="cw-card">
          <h3>Payload</h3>
          <pre>{JSON.stringify(p.payload, null, 2)}</pre>
        </section>
      </div>

      {error && (
        <p className="cw-error" role="alert">
          {error}
        </p>
      )}

      {canApprove ? (
        <section className="cw-card" style={{ marginTop: 16 }}>
          <h3>Decision</h3>
          {p.status === 'pending' && isRequester && <p className="cw-banner">You requested this proposal. Self-approval is off by default; another approver must decide.</p>}
          <div className="cw-row">
            {(p.status === 'pending' || p.status === 'approved') && (
              <button className="cw-btn" data-variant="ghost" disabled={busy} onClick={() => act(() => dryRunFn({ data: { id: p.id } }))}>
                Dry run
              </button>
            )}
            {p.status === 'pending' && (
              <>
                <label style={{ flex: 1 }}>
                  Comment
                  <input value={comment} onChange={(e) => setComment(e.target.value)} />
                </label>
                <button className="cw-btn" disabled={busy} onClick={() => act(() => decideFn({ data: { id: p.id, decision: 'approve', comment } }))}>
                  Approve
                </button>
                <button className="cw-btn" data-variant="danger" disabled={busy} onClick={() => act(() => decideFn({ data: { id: p.id, decision: 'reject', comment } }))}>
                  Reject
                </button>
              </>
            )}
            {p.status === 'approved' && !p.execution && (
              <button className="cw-btn" data-variant="danger" disabled={busy || executorMode === 'off'} onClick={() => act(() => executeFn({ data: { id: p.id } }))}>
                {executorMode === 'on' ? 'Execute' : executorMode === 'dry-run' ? 'Execute (flag is dry-run)' : 'Executor off'}
              </button>
            )}
          </div>
          {!p.lastDryRun && p.status !== 'executed' && <p className="cw-muted">Run a dry run before executing to see the exact calls.</p>}
        </section>
      ) : (
        <p className="cw-muted">Only owners and approvers can decide or execute proposals.</p>
      )}

      {p.lastDryRun && (
        <>
          <h2>Last dry run</h2>
          <pre>{JSON.stringify(p.lastDryRun, null, 2)}</pre>
        </>
      )}
      {p.execution && (
        <>
          <h2>Execution</h2>
          <pre>{JSON.stringify(p.execution, null, 2)}</pre>
        </>
      )}
      {p.rollbackNotes && (
        <>
          <h2>Rollback notes</h2>
          <pre>{p.rollbackNotes}</pre>
        </>
      )}

      <h2>Timeline</h2>
      <ol className="cw-timeline">
        {events.map((e) => (
          <li key={e.id}>
            <strong>{e.event}</strong> <span className="cw-muted">by {e.actorType} {e.actorId ?? ''} · {fmtTime(e.createdAt)}</span>
            {Object.keys(e.data).length > 0 && <pre>{JSON.stringify(e.data, null, 2)}</pre>}
          </li>
        ))}
      </ol>
      <p>
        <button
          className="cw-btn"
          data-variant="ghost"
          onClick={async () => {
            try {
              const bundle = await exportBundleFn({ data: { id: p.id } })
              const url = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }))
              const a = document.createElement('a')
              a.href = url
              a.download = `crosswire-proposal-${p.id}.json`
              a.click()
              URL.revokeObjectURL(url)
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err))
            }
          }}
        >
          Download audit bundle (owners)
        </button>
      </p>
    </>
  )
}
