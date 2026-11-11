import { Link, createFileRoute, notFound, useRouter } from '@tanstack/react-router'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { decideFn, dryRunFn, executeFn, exportBundleFn, fetchProposal, proposeRollbackFn } from '../fns/approvals'
import { fmtTime } from '../components/format'
import { ModeTag, StatusTag } from '../components/signals'
import { Breadcrumbs, Notice, SkeletonPage, Term } from '../components/ui'
import { plainMessage } from '../shared/messages'
import { pageTitle } from '../components/errors'

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
  pendingComponent: () => <SkeletonPage rows={4} label="Loading this action" />,
  errorComponent: ({ error }) => (
    <Notice tone="error" title="This action did not load">
      {plainMessage(error)} Refresh to try again, or <Link to="/app/approvals">go back to approvals</Link>.
    </Notice>
  ),
  notFoundComponent: () => (
    <>
      <h1>Action not found</h1>
      <p className="cw-muted">It may have expired, or it belongs to another organisation.</p>
      <Link to="/app/approvals">Back to approvals</Link>
    </>
  ),
  head: ({ loaderData }) => ({ meta: [{ title: pageTitle(loaderData?.proposal.title, 'Approval') }] }),
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
  const { proposal: p, events, executorMode, canApprove, isRequester, rollback, people, isOwner, selfApprovalAllowed, onBehalfOf, binding } = Route.useLoaderData()
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
  const [confirming, setConfirming] = useState<'approve' | 'reject' | 'exec' | null>(null)
  const blockedSelf = isRequester && !selfApprovalAllowed
  const targetNames = [...(p.targets.devices ?? []), ...(p.targets.users ?? []), ...(p.targets.incidents ?? [])]
  const targetText = targetNames.length <= 3 ? targetNames.join(', ') : `${targetNames.slice(0, 3).join(', ')} and ${targetNames.length - 3} more`
  const [now] = useState(() => Date.now())
  const expiresIn = new Date(p.expiresAt).getTime() - now

  const act = async (label: string, fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setBusy(label)
    setError(null)
    try {
      const r = await fn()
      if (!r.ok) setError(r.error ?? 'The server refused this step.')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
      setConfirming(null)
    }
    await router.invalidate().catch(() => {})
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
          <p>
            <strong>{ACTION_LABEL[p.actionType] ?? p.actionType}</strong> on {targetText || 'no named target'}. Read what it reaches, run a dry run to see the exact calls, then decide.
          </p>
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
          <dd>
            {p.requesterType === 'agent' ? (
              <>
                <span className="mono">{p.requesterId}</span>
                {onBehalfOf && <span className="cw-muted"> for {onBehalfOf}</span>}
              </>
            ) : (
              who('user', p.requesterId)
            )}
          </dd>
        </div>
        <div>
          <dt>Created</dt>
          <dd>{fmtTime(p.createdAt)}</dd>
        </div>
        <div>
          <dt>Expires</dt>
          <dd>
            {fmtTime(p.expiresAt)}
            {p.status === 'pending' && expiresIn > 0 && expiresIn < 3 * 3_600_000 && <span className="cw-badge" data-tone="warn">soon</span>}
          </dd>
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
        <Notice tone="error" title="The server did not accept that step">
          {plainMessage(error)}
        </Notice>
      )}

      <ol className="cw-answers" aria-label="What to check before deciding">
        <li>
          <Section title="1. What will happen">
            <p>
              {ACTION_LABEL[p.actionType] ?? p.actionType}. {executorMode === 'on' ? 'If approved and executed, this changes your tenant.' : 'The executor is not live, so executing records the planned calls only.'}
            </p>
            {Object.keys(p.payload).filter((k) => k !== 'demo').length > 0 && (
              <details>
                <summary>Details sent with the action</summary>
                <pre>{JSON.stringify(p.payload, null, 2)}</pre>
              </details>
            )}
          </Section>
        </li>
        <li>
          <Section title="2. To what">
            <dl className="cw-provenance">
              {targets.map(([label, list]) => (
                <div key={label} className="cw-contents">
                  <dt>{label}</dt>
                  <dd>{list && list.length ? <span className="mono">{list.join(', ')}</span> : <span className="cw-muted">none</span>}</dd>
                </div>
              ))}
            </dl>
          </Section>
        </li>
        <li>
          <Section title={<>3. <Term k="blastRadius">Blast radius</Term></>}>
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
        </li>
        <li>
          <Section title="4. Who asked">
            <p>
              {p.requesterType === 'agent' ? (
                <>
                  The <span className="mono">{p.requesterId}</span> agent drafted it{onBehalfOf ? <> for {onBehalfOf}</> : null}. Agents can only propose.
                </>
              ) : (
                <>{who('user', p.requesterId)} asked for it.</>
              )}{' '}
              The person who asked cannot approve it{selfApprovalAllowed ? ' unless self-approval is turned on (it is on in this deployment)' : ''}.
            </p>
          </Section>
        </li>
        <li>
          <Section title="5. What the dry run showed">
            {dry ? (
              <p>
                {dry.blocked && dry.blocked.length > 0 ? `It would be refused: ${dry.blocked.join(' ')}` : `${dry.calls?.length ?? 0} call${dry.calls?.length === 1 ? '' : 's'} planned.`} Full detail is below.
              </p>
            ) : (
              <p className="cw-muted">No dry run yet. Run one before deciding. It lists every call without changing anything.</p>
            )}
          </Section>
        </li>
        <li>
          <Section title="6. How to roll back">
            {p.rollbackNotes ? <pre className="cw-pre-flush" tabIndex={0} aria-label="Rollback notes">{p.rollbackNotes}</pre> : <p className="cw-muted">Rollback notes appear after a dry run. Crosswire cannot undo an action by itself; a rollback is a new action that also needs approval.</p>}
          </Section>
        </li>
        <li>
          <Section title="7. When it expires">
            <p>
              {p.status === 'pending' ? (expiresIn > 0 ? <>Decide before {fmtTime(p.expiresAt)}. After that it expires and cannot run.</> : 'This action has expired and cannot run.') : <>Expiry was {fmtTime(p.expiresAt)}.</>}
            </p>
          </Section>
        </li>
      </ol>

      <section className="cw-panel2" aria-labelledby="bind-title">
        <div className="cw-panel2-head">
          <h2 id="bind-title">What your decision is bound to</h2>
        </div>
        <div className="cw-panel2-body">
          {binding.sha256 ? (
            <>
              <p>
                Approval covers this exact title, action, targets, blast radius and details. If any of them change, execution is refused and a new action is needed.
              </p>
              <dl className="cw-provenance">
                <dt>Content fingerprint</dt>
                <dd>
                  <code className="cw-hash">{binding.sha256}</code>
                </dd>
                <dt>Format version</dt>
                <dd className="num">{binding.schemaVersion}</dd>
                <dt>Check now</dt>
                <dd>
                  {binding.matches ? (
                    <span className="cw-badge" data-tone="ok">
                      Matches the stored content
                    </span>
                  ) : (
                    <span className="cw-badge" data-tone="danger">
                      Does not match. Execution will be refused
                    </span>
                  )}
                </dd>
                {!binding.enforced && (
                  <>
                    <dt>Enforcement</dt>
                    <dd>
                      <span className="cw-badge" data-tone="warn">
                        Off (APPROVAL_BINDING=legacy)
                      </span>
                    </dd>
                  </>
                )}
              </dl>
            </>
          ) : (
            <Notice tone="warn" title="Not bound">
              This action was created before content binding, so it has no fingerprint. {binding.enforced ? 'Execution will be refused. Ask for a new action.' : 'Binding enforcement is off in this deployment.'}
            </Notice>
          )}
        </div>
      </section>

      {canApprove ? (
        <section className="cw-panel2" aria-labelledby="decide-title">
          <div className="cw-panel2-head">
            <h2 id="decide-title">Your decision</h2>
            <span className="cw-muted">Safe mode: nothing runs in your tenant unless the executor is live.</span>
          </div>
          <div className="cw-panel2-body">
            {p.status === 'pending' && blockedSelf && (
              <Notice tone="warn" title="You cannot approve this one">
                You asked for this action, so another approver must decide it. This keeps two people on every change.
              </Notice>
            )}
            {!dry && p.status !== 'executed' && <p className="cw-muted">Start with a dry run. It lists every call without changing anything.</p>}
            <div className="cw-row cw-decide">
              {(p.status === 'pending' || p.status === 'approved') && (
                <button type="button" className="cw-btn" data-variant="ghost" disabled={busy !== null} onClick={() => act('dry', () => dryRunFn({ data: { id: p.id } }))}>
                  {busy === 'dry' ? 'Running dry run…' : 'Dry run'}
                </button>
              )}
              {p.status === 'pending' && !blockedSelf && (
                <>
                  <label className="cw-grow">
                    Comment (optional, saved with your decision)
                    <input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Why you approve or reject" />
                  </label>
                  <button type="button" className="cw-btn" disabled={busy !== null || confirming !== null} onClick={() => setConfirming('approve')}>
                    Approve…
                  </button>
                  <button type="button" className="cw-btn" data-variant="danger" disabled={busy !== null || confirming !== null} onClick={() => setConfirming('reject')}>
                    Reject…
                  </button>
                </>
              )}
              {p.status === 'approved' && !p.execution && (
                <button type="button" className="cw-btn" data-variant="danger" disabled={busy !== null || executorMode === 'off' || confirming !== null} aria-describedby="exec-help" onClick={() => setConfirming('exec')}>
                  {executorMode === 'on' ? 'Execute in tenant…' : executorMode === 'dry-run' ? 'Execute (records a dry run)…' : 'Execute'}
                </button>
              )}
            </div>
            {confirming && (
              <ConfirmBox
                tone={confirming === 'approve' ? 'accent' : 'danger'}
                title={confirming === 'approve' ? `Approve "${p.title}"?` : confirming === 'reject' ? `Reject "${p.title}"?` : `Execute "${p.title}"?`}
                body={
                  confirming === 'approve'
                    ? `Approving lets an approver execute ${ACTION_LABEL[p.actionType]?.toLowerCase() ?? 'this action'} on ${targetText || 'its targets'}. It does not run yet.`
                    : confirming === 'reject'
                      ? 'Rejecting closes this action. It cannot be approved later; a new action would be needed.'
                      : executorMode === 'on'
                        ? `This sends the calls to your tenant now and changes ${targetText || 'its targets'}.`
                        : 'The executor is in dry-run mode, so this records the planned calls only.'
                }
                confirmLabel={confirming === 'approve' ? `Approve ${targetNames.length === 1 ? targetNames[0] : 'action'}` : confirming === 'reject' ? 'Reject action' : 'Execute now'}
                busy={busy !== null}
                onCancel={() => setConfirming(null)}
                onConfirm={() =>
                  confirming === 'exec'
                    ? act('exec', () => executeFn({ data: { id: p.id } }))
                    : act(confirming, () => decideFn({ data: { id: p.id, decision: confirming, comment } }))
                }
              />
            )}
            {p.status === 'approved' && !p.execution && (
              <p id="exec-help" className="cw-muted cw-mt-xs">
                {executorMode === 'off' ? 'The executor for this action type is off, so it cannot run. An admin changes this through a change ticket.' : executorMode === 'dry-run' ? 'The executor is in dry-run mode: executing records the planned calls only.' : 'The executor is live: this will change your tenant.'}
              </p>
            )}
          </div>
        </section>
      ) : (
        <Notice tone="info">Only owners and approvers can decide or execute actions. You can still read everything here.</Notice>
      )}

      {dry && <Outcome id="dry-title" title="Last dry run" outcome={dry} intro="The calls Crosswire would make. Nothing was sent." />}
      {exec && <Outcome id="exec-title" title="Execution" outcome={exec} intro={exec.mode === 'live' ? 'Calls sent to your tenant and their responses.' : 'Recorded in dry-run mode. Nothing was sent.'} />}

      {canRollback && !rollbackOpen && (
        <p>
          <button
            type="button"
            className="cw-btn"
            data-variant="ghost"
            disabled={busy !== null}
            onClick={async () => {
              setBusy('rollback')
              try {
                const r = await proposeRollbackFn({ data: { id: p.id } })
                if (!r.ok) return setError(r.error)
                await navigate({ to: '/app/approvals/$id', params: { id: r.result.id } })
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err))
              } finally {
                setBusy(null)
              }
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
          <span className="cw-spacer" />
          {isOwner ? (
            <button
              type="button"
              className="cw-btn"
              data-variant="ghost"
              data-size="sm"
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
            <span className="cw-muted">Owners can download the audit bundle.</span>
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

/** Inline confirmation that names the target. Focus lands on Cancel, never on the destructive choice. */
function ConfirmBox({ tone, title, body, confirmLabel, busy, onCancel, onConfirm }: { tone: 'accent' | 'danger'; title: string; body: string; confirmLabel: string; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  const cancel = useRef<HTMLButtonElement>(null)
  useEffect(() => cancel.current?.focus(), [])
  return (
    <div className="cw-confirm" role="alertdialog" aria-labelledby="confirm-title" aria-describedby="confirm-body" data-tone={tone} onKeyDown={(e) => e.key === 'Escape' && onCancel()}>
      <p id="confirm-title" className="cw-confirm-title">
        {title}
      </p>
      <p id="confirm-body">{body}</p>
      <div className="cw-row">
        <button ref={cancel} type="button" className="cw-btn" data-variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="cw-btn" data-variant={tone === 'danger' ? 'danger' : undefined} onClick={onConfirm} disabled={busy}>
          {busy ? 'Working…' : confirmLabel}
        </button>
      </div>
    </div>
  )
}

function Section({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <section className="cw-card">
      <h2 className="cw-card-title">{title}</h2>
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
            <ul className="cw-flush">
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
                        <code className="cw-wrap-any">
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
