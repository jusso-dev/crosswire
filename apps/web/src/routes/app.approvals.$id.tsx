import { Link, createFileRoute, notFound, useRouter } from '@tanstack/react-router'
import { useState, type ReactNode } from 'react'
import { decideFn, dryRunFn, executeFn, exportBundleFn, fetchProposal, proposeRollbackFn } from '../fns/approvals'
import { fmtTime } from '../components/format'
import { ModeTag, StatusTag } from '../components/signals'
import { Breadcrumbs, Notice, Term } from '../components/ui'

/**
 * Approval detail: what the action does, how far it reaches, the exact calls a dry run would make,
 * and who decided. Every decision is enforced server-side (role, requester != approver, executor flags).
 */
export const Route = createFileRoute('/app/approvals/$id')({
  loader: async ({ params }) => {
    const p = await fetchProposal({ data: { id: params.id } })
    if (!p) throw notFound()
    return p
  },
  pendingComponent: () => <p className="cw-muted">Loading action…</p>,
  errorComponent: ({ error }) => (
    <Notice tone="error" title="Could not load this action">
      {error instanceof Error ? error.message : String(error)} <Link to="/app/approvals">Back to approvals</Link>
    </Notice>
  ),
  notFoundComponent: () => (
    <>
      <h1>Action not found</h1>
      <p className="cw-muted">It may have expired, or it belongs to another organisation.</p>
      <Link to="/app/approvals">Back to approvals</Link>
    </>
  ),
  component: ProposalDetail,
})

const ACTION_LABEL: Record<string, string> = { sentinel_playbook: 'Run a Sentinel playbook', logic_app: 'Run a Logic App', graph_containment: 'Isolate a device', other: 'Manual action' }
const EVENT_LABEL: Record<string, string> = {
  created: 'Proposed',
  dry_run: 'Dry run',
  approved: 'Approved',
  rejected: 'Rejected',
  executed: 'Executed',
  execution_failed: 'Execution failed',
  expired: 'Expired',
  rollback_proposed: 'Rollback proposed',
}

type Call = { method: string; url: string; target?: { kind: string; id: string }; body?: unknown }
type Result = { url: string; ok: boolean; status: number | null; error?: string; target?: { kind: string; id: string } }
type Outcome = { mode?: string; status?: string; calls?: Call[]; blocked?: string[]; results?: Result[]; error?: string; at?: string }

function ProposalDetail() {
  const { proposal: p, events, executorMode, canApprove, isRequester, rollback, people, isOwner } = Route.useLoaderData()
  const who = (type: string, id: string | null) => (type === 'agent' ? (id ?? 'agent') : type === 'user' ? ((id && people[id]) ?? 'a former member') : 'Crosswire')
  const router = useRouter()
  const navigate = Route.useNavigate()
  const dry = p.lastDryRun as Outcome | null
  const exec = p.execution as Outcome | null
  const canRollback = canApprove && !p.rollbackOfId && (p.status === 'executed' || p.status === 'failed') && exec?.mode === 'live' && (exec.results ? exec.results.some((r) => r.ok) : exec.status === 'succeeded')
  const rollbackOpen = rollback && (rollback.status === 'pending' || rollback.status === 'approved' || rollback.status === 'executed')
  const [comment, setComment] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const act = async (label: string, fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setBusy(label)
    setError(null)
    const r = await fn()
    setBusy(null)
    if (!r.ok) setError(r.error ?? 'Action failed')
    await router.invalidate()
  }

  const targets: Array<[string, string[] | undefined]> = [
    ['Devices', p.targets.devices],
    ['Users', p.targets.users],
    ['Incidents', p.targets.incidents],
  ]

  return (
    <>
      <Breadcrumbs items={[{ label: 'Approvals', to: '/app/approvals' }, { label: p.title }]} />
      <header className="cw-pagehead">
        <div>
          <h1>{p.title}</h1>
          <p>{ACTION_LABEL[p.actionType] ?? p.actionType}. Check what it reaches, run a dry run to see the exact calls, then decide.</p>
        </div>
      </header>
      <dl className="cw-ctxbar" aria-label="Action context">
        <div>
          <dt>Status</dt>
          <dd>
            <StatusTag status={p.status} />
          </dd>
        </div>
        <div>
          <dt>Asked by</dt>
          <dd>{p.requesterType === 'agent' ? <span className="mono">{p.requesterId}</span> : who('user', p.requesterId)}</dd>
        </div>
        <div>
          <dt>Created</dt>
          <dd>{fmtTime(p.createdAt)}</dd>
        </div>
        <div>
          <dt>Expires</dt>
          <dd>{fmtTime(p.expiresAt)}</dd>
        </div>
        <div>
          <dt>
            <Term k="executor">Executor</Term>
          </dt>
          <dd>{executorMode === 'on' ? 'Live' : executorMode === 'dry-run' ? 'Dry run only' : 'Off'}</dd>
        </div>
        {p.huntId && (
          <div>
            <dt>Hunt</dt>
            <dd>
              <Link to="/app/hunts/$huntId" params={{ huntId: p.huntId }}>
                Open hunt
              </Link>
            </dd>
          </div>
        )}
      </dl>

      {p.payload.demo === true && <Notice tone="demo">Demo fixture, not a real request. In dry-run mode no executor contacts a tenant for demo data.</Notice>}
      {p.rollbackOfId && (
        <Notice tone="info">
          This is a rollback of{' '}
          <Link to="/app/approvals/$id" params={{ id: p.rollbackOfId }}>
            the original action
          </Link>
          . It needs its own approval by someone other than the requester.
        </Notice>
      )}
      {rollback && (
        <Notice tone="info">
          A rollback has been proposed:{' '}
          <Link to="/app/approvals/$id" params={{ id: rollback.id }}>
            {rollback.status}
          </Link>
        </Notice>
      )}
      {error && (
        <Notice tone="error" title="That did not work">
          {error}
        </Notice>
      )}

      <div className="cw-grid" style={{ marginBottom: 'var(--space-md)' }}>
        <Section title={<Term k="blastRadius">Blast radius</Term>}>
          <p>{p.blastRadius.summary}</p>
          <dl className="cw-runstats">
            <div>
              <dt>Devices</dt>
              <dd className="num">{p.blastRadius.devices}</dd>
            </div>
            <div>
              <dt>Users</dt>
              <dd className="num">{p.blastRadius.users}</dd>
            </div>
            <div>
              <dt>Incidents</dt>
              <dd className="num">{p.blastRadius.incidents}</dd>
            </div>
          </dl>
        </Section>
        <Section title="What it acts on">
          <dl className="cw-provenance">
            {targets.map(([label, list]) => (
              <div key={label} style={{ display: 'contents' }}>
                <dt>{label}</dt>
                <dd>{list && list.length ? <span className="mono">{list.join(', ')}</span> : <span className="cw-muted">none</span>}</dd>
              </div>
            ))}
          </dl>
          {Object.keys(p.payload).filter((k) => k !== 'demo').length > 0 && (
            <details style={{ marginTop: 'var(--space-xs)' }}>
              <summary>Details sent with the action</summary>
              <pre>{JSON.stringify(p.payload, null, 2)}</pre>
            </details>
          )}
        </Section>
      </div>

      {canApprove ? (
        <section className="cw-panel2" aria-labelledby="decide-title">
          <div className="cw-panel2-head">
            <h2 id="decide-title">Your decision</h2>
            <span className="cw-muted">Safe mode: nothing runs in your tenant unless the executor is live.</span>
          </div>
          <div className="cw-panel2-body">
            {p.status === 'pending' && isRequester && <Notice tone="warn">You asked for this action. Another approver must decide it.</Notice>}
            {!dry && p.status !== 'executed' && <p className="cw-muted">Start with a dry run. It lists every call without changing anything.</p>}
            <div className="cw-row">
              {(p.status === 'pending' || p.status === 'approved') && (
                <button type="button" className="cw-btn" data-variant="ghost" disabled={busy !== null} onClick={() => act('dry', () => dryRunFn({ data: { id: p.id } }))}>
                  {busy === 'dry' ? 'Running dry run…' : 'Dry run'}
                </button>
              )}
              {p.status === 'pending' && (
                <>
                  <label className="cw-grow">
                    Comment (optional)
                    <input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Why you approve or reject" />
                  </label>
                  <button type="button" className="cw-btn" disabled={busy !== null} onClick={() => act('approve', () => decideFn({ data: { id: p.id, decision: 'approve', comment } }))}>
                    {busy === 'approve' ? 'Approving…' : 'Approve'}
                  </button>
                  <button type="button" className="cw-btn" data-variant="danger" disabled={busy !== null} onClick={() => act('reject', () => decideFn({ data: { id: p.id, decision: 'reject', comment } }))}>
                    {busy === 'reject' ? 'Rejecting…' : 'Reject'}
                  </button>
                </>
              )}
              {p.status === 'approved' && !p.execution && (
                <button type="button" className="cw-btn" data-variant="danger" disabled={busy !== null || executorMode === 'off'} aria-describedby="exec-help" onClick={() => act('exec', () => executeFn({ data: { id: p.id } }))}>
                  {executorMode === 'on' ? 'Execute in tenant' : executorMode === 'dry-run' ? 'Execute (records a dry run)' : 'Execute'}
                </button>
              )}
            </div>
            {p.status === 'approved' && !p.execution && (
              <p id="exec-help" className="cw-muted" style={{ marginTop: 'var(--space-xs)' }}>
                {executorMode === 'off' ? 'The executor for this action type is off, so it cannot run. An admin changes this through a change ticket.' : executorMode === 'dry-run' ? 'The executor is in dry-run mode: executing records the planned calls only.' : 'The executor is live: this will change your tenant.'}
              </p>
            )}
          </div>
        </section>
      ) : (
        <Notice tone="info">Only owners and approvers can decide or execute actions. You can still read everything here.</Notice>
      )}

      {dry && (
        <Outcome
          id="dry-title"
          title="Last dry run"
          outcome={dry}
          intro="The calls Crosswire would make. Nothing was sent."
        />
      )}
      {exec && <Outcome id="exec-title" title="Execution" outcome={exec} intro={exec.mode === 'live' ? 'Calls sent to your tenant and their responses.' : 'Recorded in dry-run mode. Nothing was sent.'} />}

      {p.rollbackNotes && (
        <Section title="Rollback notes">
          <pre style={{ margin: 0 }}>{p.rollbackNotes}</pre>
        </Section>
      )}
      {canRollback && !rollbackOpen && (
        <p>
          <button
            type="button"
            className="cw-btn"
            data-variant="ghost"
            disabled={busy !== null}
            onClick={async () => {
              setBusy('rollback')
              const r = await proposeRollbackFn({ data: { id: p.id } })
              setBusy(null)
              if (!r.ok) return setError(r.error)
              await navigate({ to: '/app/approvals/$id', params: { id: r.result.id } })
            }}
          >
            Propose rollback (needs approval)
          </button>
        </p>
      )}

      <section className="cw-panel2" aria-labelledby="tl-title">
        <div className="cw-panel2-head">
          <h2 id="tl-title">Timeline</h2>
          <span className="cw-muted">Every step, oldest first.</span>
          {isOwner ? (
          <button
            type="button"
            className="cw-btn"
            data-variant="ghost"
            data-size="sm"
            style={{ marginLeft: 'auto' }}
            onClick={async () => {
              try {
                const bundle = await exportBundleFn({ data: { id: p.id } })
                const url = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }))
                const a = document.createElement('a')
                a.href = url
                a.download = `crosswire-action-${p.id}.json`
                a.click()
                URL.revokeObjectURL(url)
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err))
              }
            }}
          >
            Download audit bundle
          </button>
          ) : (
            <span className="cw-muted" style={{ marginLeft: 'auto' }}>
              Owners can download the audit bundle.
            </span>
          )}
        </div>
        <div className="cw-panel2-body">
          <ol className="cw-timeline">
            {events.map((e) => (
              <li key={e.id} data-kind={e.event === 'executed' ? 'result' : e.event.includes('fail') || e.event === 'rejected' ? 'failed' : undefined}>
                <span className="cw-ev-label">{EVENT_LABEL[e.event] ?? e.event.replace(/_/g, ' ')}</span>
                <span className="cw-tl-time">
                  <time dateTime={e.createdAt}>{fmtTime(e.createdAt)}</time> · {who(e.actorType, e.actorId)}
                </span>
                {typeof (e.data as Record<string, unknown>).comment === 'string' && (e.data as Record<string, string>).comment && <p>“{(e.data as Record<string, string>).comment}”</p>}
                {Object.keys(e.data).length > 0 && (
                  <details>
                    <summary>Technical details</summary>
                    <pre>{JSON.stringify(e.data, null, 2)}</pre>
                  </details>
                )}
              </li>
            ))}
          </ol>
        </div>
      </section>
    </>
  )
}

function Section({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <section className="cw-card">
      <h2 style={{ fontSize: 'var(--text-body)', margin: '0 0 var(--space-xs)' }}>{title}</h2>
      {children}
    </section>
  )
}

function Outcome({ id, title, intro, outcome }: { id: string; title: string; intro: string; outcome: Outcome }) {
  // Results are recorded in call order, so match by position (URLs can repeat).
  const results = outcome.results ?? []
  return (
    <section className="cw-panel2" aria-labelledby={id}>
      <div className="cw-panel2-head">
        <h2 id={id}>{title}</h2>
        <ModeTag mode={outcome.mode === 'live' ? 'live' : 'dry-run'} />
        {outcome.status && <span className="cw-badge" data-tone={outcome.status === 'succeeded' ? 'ok' : outcome.status === 'planned' ? 'info' : 'danger'}>{outcome.status}</span>}
        {outcome.at && <span className="cw-muted">{fmtTime(outcome.at)}</span>}
      </div>
      <div className="cw-panel2-body">
        <p className="cw-muted">{intro}</p>
        {outcome.blocked && outcome.blocked.length > 0 && (
          <Notice tone="warn" title="Would be refused">
            <ul style={{ margin: 0 }}>
              {outcome.blocked.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          </Notice>
        )}
        {outcome.error && <Notice tone="error">{outcome.error}</Notice>}
        {outcome.calls && outcome.calls.length > 0 ? (
          <div className="cw-tablewrap">
            <table className="cw-table">
              <caption className="cw-sr-only">{title}: calls</caption>
              <thead>
                <tr>
                  <th scope="col">Target</th>
                  <th scope="col">Call</th>
                  {outcome.results && <th scope="col">Result</th>}
                </tr>
              </thead>
              <tbody>
                {outcome.calls.map((c, i) => {
                  const r = results[i]
                  return (
                    <tr key={`${c.url}-${i}`}>
                      <td className="mono">{c.target ? `${c.target.kind} ${c.target.id}` : 'all targets'}</td>
                      <td>
                        <code style={{ overflowWrap: 'anywhere' }}>
                          {c.method} {c.url}
                        </code>
                      </td>
                      {outcome.results && (
                        <td>
                          {r ? (
                            <span className="cw-badge" data-tone={r.ok ? 'ok' : 'danger'}>
                              {r.ok ? 'OK' : 'Failed'} {r.status ?? ''}
                            </span>
                          ) : (
                            <span className="cw-muted">no response recorded</span>
                          )}
                          {r?.error && <div className="cw-muted">{r.error}</div>}
                        </td>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="cw-empty">No calls planned.</p>
        )}
        <details>
          <summary>Raw record</summary>
          <pre>{JSON.stringify(outcome, null, 2)}</pre>
        </details>
      </div>
    </section>
  )
}
