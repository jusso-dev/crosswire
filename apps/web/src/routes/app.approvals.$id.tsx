import { Link, createFileRoute, notFound } from '@tanstack/react-router'
import { useState, type ReactNode } from 'react'
import { fetchProposal, proposeRollbackFn } from '../fns/approvals'
import { fmtTime, fmtTimeExact } from '../components/format'
import { StatusTag } from '../components/signals'
import { Breadcrumbs, Notice, SkeletonPage, Term } from '../components/ui'
import { useAction } from '../components/action'
import { plainMessage } from '../shared/messages'
import { responseActionLabel, statusWord } from '../shared/labels'
import { pageTitle } from '../components/errors'
import { targetNames, targetSentence } from './-approvals/confirm-text'
import { executionIntro } from './-approvals/execution-text'
import { Outcome as OutcomePanel, type OutcomeRecord } from './-approvals/outcome'
import { DecisionPanel } from './-approvals/decision'
import { BindingPanel } from './-approvals/binding'
import { Timeline } from './-approvals/timeline'

/**
 * Approval detail: what the action does, how far it reaches, the exact calls a dry run would make,
 * and who decided. Every decision is enforced server-side (role, requester != approver, executor flags).
 */
export const Route = createFileRoute('/app/approvals/$id')({
  // A new proposal id is a new page: typed comments and open confirmations never carry over (#125).
  remountDeps: ({ params }) => params,
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

type Outcome = OutcomeRecord

function ProposalDetail() {
  const { proposal: p, events, executorMode, canApprove, isRequester, rollback, people, isOwner, selfApprovalAllowed, onBehalfOf, binding } = Route.useLoaderData()
  const who = (type: string, id: string | null) => (type === 'agent' ? (id ?? 'agent') : type === 'user' ? ((id && people[id]) ?? 'a former member') : 'Crosswire')
  const navigate = Route.useNavigate()
  const rollbackAction = useAction()
  const dry = p.lastDryRun as Outcome | null
  const exec = p.execution as Outcome | null
  const canRollback = canApprove && !p.rollbackOfId && (p.status === 'executed' || p.status === 'failed') && exec?.mode === 'live' && (exec.results ? exec.results.some((r) => r.ok) : exec.status === 'succeeded')
  const rollbackOpen = rollback && (rollback.status === 'pending' || rollback.status === 'approved' || rollback.status === 'executed')
  const action = responseActionLabel(p.actionType, p.payload)
  const targetText = targetSentence(targetNames(p.targets), 3)
  const [now] = useState(() => Date.now())
  const expiresIn = new Date(p.expiresAt).getTime() - now

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
            <strong>{action}</strong> on {targetText}. Read what it reaches, run a dry run to see the exact calls, then decide.
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
            {statusWord(rollback.status).toLowerCase()}
          </Link>
        </Notice>
      )}
      {rollbackAction.error && (
        <Notice tone="error" title="The rollback was not proposed">
          {rollbackAction.error}
        </Notice>
      )}

      <ol className="cw-answers" aria-label="What to check before deciding">
        <li>
          <Section title="1. What will happen">
            <p>
              {action}. {executorMode === 'on' ? 'If approved and executed, this changes your tenant.' : 'The executor is not live, so executing records the planned calls only.'}
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

      <BindingPanel binding={binding} />

      <DecisionPanel p={p} executorMode={executorMode} canApprove={canApprove} isRequester={isRequester} selfApprovalAllowed={selfApprovalAllowed} hasDryRun={dry !== null} />

      {dry && <OutcomePanel id="dry-title" title="Last dry run" outcome={dry} intro="The calls Crosswire would make. Nothing was sent." />}
      {exec && <OutcomePanel id="exec-title" title="Execution" outcome={exec} intro={executionIntro(exec, fmtTimeExact(exec.at), typeof exec.by === 'string' ? who('user', exec.by) : 'an approver')} />}

      {canRollback && !rollbackOpen && (
        <p>
          <button
            type="button"
            className="cw-btn"
            data-variant="ghost"
            disabled={rollbackAction.busy !== null}
            onClick={async () => {
              const r = await rollbackAction.run('rollback', () => proposeRollbackFn({ data: { id: p.id } }))
              if (r?.ok) await navigate({ to: '/app/approvals/$id', params: { id: r.result.id } })
            }}
          >
            {rollbackAction.busy ? 'Proposing rollback…' : 'Propose rollback (needs approval)'}
          </button>
        </p>
      )}

      <Timeline proposalId={p.id} events={events} isOwner={isOwner} who={who} />
    </>
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
