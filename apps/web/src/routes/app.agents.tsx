import { Link, createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { z } from 'zod'
import { approveDirectiveFn, createDirectiveFn, fetchActivity, fetchAgentDesk, fetchMemory, fetchReviewQueue, fetchRunDetail, fetchRuns, fetchSkills, promoteMemoryFn, rememberFn, replaceMemoryFn, retireDirectiveFn, runCompaction } from '../fns/agents'
import { AGENT_KEYS, AGENT_LABELS, isAgentKey, type AgentKey } from '../shared/agents'
import { plainMessage } from '../shared/messages'
import { fmtTime } from '../components/format'
import { EmptyState, Notice, PageHead, SkeletonPage, TableWrap } from '../components/ui'
import { EVENT_WORD, RunStatusTag, RunTree, StopRunButton, agentLabel, fmtCost, fmtDuration, fmtTokens, outputLabel } from '../components/runs'
import { listKeys } from '../components/keys'

/**
 * Agents page. Memory is the default view: one agent, its notes, usage and directives.
 * Review is the held-memory inbox. Runs is the run timeline with replay and Stop. Log is the
 * decision log. Skills lists the reviewed runbooks. Promote, replace, compact, Stop and directive
 * approval are enforced on the server; the screen explains why a control is unavailable.
 */
const ACTION_WORDS: Record<string, string> = {
  propose_kql: 'Proposed a search',
  run_kql: 'Approved and ran a search',
  run_kql_failed: 'Search failed',
  reject_kql: 'Rejected a search',
  schedule_kql: 'Scheduled a repeat search',
  scheduled_kql: 'Ran a repeat search',
  propose_response: 'Proposed an action',
  delegate: 'Handed work to another agent',
}

export const Route = createFileRoute('/app/agents')({
  validateSearch: z.object({
    agent: z.string().optional(),
    actor: z.string().optional(),
    q: z.string().optional(),
    before: z.string().optional(),
    run: z.uuid().optional(),
    view: z.enum(['log', 'runs', 'review', 'skills']).optional(),
    rstatus: z.enum(['running', 'completed', 'failed', 'interrupted']).optional(),
    ragent: z.enum(AGENT_KEYS).optional(),
  }),
  loaderDeps: ({ search }) => ({ q: search.q, actor: search.actor, before: search.before, run: search.run, view: search.view, rstatus: search.rstatus, ragent: search.ragent }),
  // Each view loads only what it shows. Log search and paging run on the server over the whole log.
  loader: async ({ deps }) => {
    const desk = await fetchAgentDesk()
    const base = {
      rows: [] as Awaited<ReturnType<typeof fetchActivity>>['rows'],
      hasMore: false,
      actors: [] as Awaited<ReturnType<typeof fetchActivity>>['actors'],
      desk,
      runs: null as Awaited<ReturnType<typeof fetchRuns>> | null,
      run: null as Awaited<ReturnType<typeof fetchRunDetail>> | null,
      queue: null as Awaited<ReturnType<typeof fetchReviewQueue>> | null,
      skills: null as Awaited<ReturnType<typeof fetchSkills>> | null,
    }
    if (deps.view === 'runs') {
      const [runs, run] = await Promise.all([fetchRuns({ data: { status: deps.rstatus, agentKey: deps.ragent } }), deps.run ? fetchRunDetail({ data: { runId: deps.run } }) : Promise.resolve(null)])
      return { ...base, runs, run }
    }
    if (deps.view === 'review') return { ...base, queue: await fetchReviewQueue() }
    if (deps.view === 'skills') return { ...base, skills: await fetchSkills() }
    if (deps.view !== 'log') return base
    const q = deps.q?.trim().toLowerCase()
    const actions = q ? Object.entries(ACTION_WORDS).filter(([, label]) => label.toLowerCase().includes(q)).map(([key]) => key) : undefined
    const activity = await fetchActivity({ data: { q: deps.q || undefined, actor: deps.actor || undefined, before: deps.before || undefined, actions } })
    return { ...base, rows: activity.rows, hasMore: activity.hasMore, actors: activity.actors }
  },
  pendingComponent: () => <SkeletonPage rows={4} />,
  errorComponent: ({ error }) => (
    <Notice tone="error" title="Agent activity did not load">
      {plainMessage(error)} Refresh the page to try again.
    </Notice>
  ),
  component: Agents,
})

const VIEWS = [
  { key: undefined, label: 'Memory' },
  { key: 'review', label: 'Review' },
  { key: 'runs', label: 'Runs' },
  { key: 'log', label: 'Log' },
  { key: 'skills', label: 'Skills' },
] as const

const INTRO: Record<string, string> = {
  memory: 'What each agent remembers, today\'s usage, and the directives every agent follows.',
  review: 'Notes held out of agent prompts until a second person promotes them.',
  runs: 'Every agent run: who ran, which model, how long, how many tokens, and each step.',
  log: 'Every agent step for this organisation. Secrets are removed before logging.',
  skills: 'Reviewed runbooks the agents work under. Changing one needs a code review.',
}

function Agents() {
  const data = Route.useLoaderData()
  const { session } = Route.useRouteContext()
  const sp = Route.useSearch()
  const navigate = useNavigate({ from: '/app/agents' })
  const set = (patch: Partial<typeof sp>) => navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true })
  const agent: AgentKey | null = isAgentKey(sp.agent) ? sp.agent : null
  const view = sp.view ?? 'memory'

  return (
    <>
      <PageHead
        title="Agents"
        intro={INTRO[view]}
        actions={
          <Link to="/app/chat" className="cw-btn">
            Ask an agent
          </Link>
        }
      />
      <nav className="cw-tabs" aria-label="Agent views">
        {VIEWS.map((v) => {
          const count = v.key === 'review' ? session.memoryToReview : v.key === 'runs' ? session.runningRuns : 0
          return (
            <Link key={v.label} to="/app/agents" search={{ view: v.key, agent: sp.agent }} activeOptions={{ includeSearch: true, explicitUndefined: true }} replace>
              {v.label}
              {count > 0 && (
                <span className="cw-badge" data-tone={v.key === 'runs' ? 'info' : 'warn'}>
                  {count}
                  <span className="cw-sr-only">{v.key === 'runs' ? ' running' : ' to review'}</span>
                </span>
              )}
            </Link>
          )
        })}
      </nav>

      {view === 'memory' && (
        <>
          <BudgetMeter budget={data.desk.budget} />
          <section aria-labelledby="team-title">
            <h2 id="team-title" className="cw-h2-compact">
              Team
            </h2>
            <ul className="cw-agentlist">
              {AGENT_KEYS.map((k) => (
                <li key={k}>
                  <button type="button" className="cw-agentbtn" aria-pressed={agent === k} onClick={() => set({ agent: agent === k ? undefined : k })}>
                    <strong>{AGENT_LABELS[k].name}</strong>
                    <span className="cw-muted">{AGENT_LABELS[k].role}</span>
                    <span className="cw-agentbtn-cta">{agent === k ? 'Hide notes' : 'Show notes'}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
          {agent ? <Memory key={agent} agent={agent} /> : <EmptyState title="Pick an agent to see its notes" body="Each agent keeps short notes it reads before every reply. Pick one above to read, add or replace them." />}
          <Directives directives={data.desk.directives} />
        </>
      )}
      {view === 'review' && data.queue && <ReviewQueue queue={data.queue} />}
      {view === 'runs' && data.runs && <RunsView runs={data.runs.runs} rateSet={data.runs.pricing} detail={data.run} />}
      {view === 'skills' && data.skills && <SkillsView skills={data.skills} />}
      {view === 'log' && <DecisionLog rows={data.rows} hasMore={data.hasMore} actors={data.actors} />}
    </>
  )
}

function DecisionLog({ rows: activity, hasMore, actors }: { rows: Awaited<ReturnType<typeof fetchActivity>>['rows']; hasMore: boolean; actors: Awaited<ReturnType<typeof fetchActivity>>['actors'] }) {
  const sp = Route.useSearch()
  const navigate = useNavigate({ from: '/app/agents' })
  const set = (patch: Partial<typeof sp>) => navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true })
  const [q, setQ] = useState(sp.q ?? '')
  // Debounce typing into the URL, which re-queries the server over the whole log.
  useEffect(() => {
    if ((sp.q ?? '') === q) return
    const t = setTimeout(() => set({ q: q || undefined, before: undefined }), 300)
    return () => clearTimeout(t)
  }, [q]) // eslint-disable-line react-hooks/exhaustive-deps
  const oldest = activity.at(-1)?.createdAt
  return (
    <section aria-labelledby="log-title">
      <h2 id="log-title" className="cw-h2-compact">
        Decision log
      </h2>
      <p className="cw-muted">Each row is a summary of up to 1000 characters. Open the Runs view for the full redacted output.</p>
      <div className="cw-tablewrap" data-overflow="visible">
        <div className="cw-toolbar" data-attached>
          <label className="cw-search">
            <span className="cw-sr-only">Filter the log</span>
            <input type="search" placeholder="Search the whole log" value={q} onChange={(e) => setQ(e.target.value)} data-search />
          </label>
          <label className="cw-inline">
            <span>Actor</span>
            <select value={sp.actor ?? ''} onChange={(e) => set({ actor: e.target.value || undefined, before: undefined })}>
              <option value="">Everyone</option>
              {actors.map((a) => (
                <option key={a.key} value={a.key}>
                  {a.type === 'agent' && isAgentKey(a.key) ? AGENT_LABELS[a.key].name : a.label}
                </option>
              ))}
            </select>
          </label>
          <span className="cw-toolbar-meta num" role="status">
            {activity.length} entries{sp.before ? ' (older page)' : ''}
            {hasMore ? ', more available' : ''}
          </span>
          <RefreshButton />
        </div>
        <div className="cw-scroll-x" role="region" aria-label="Decision log table" tabIndex={0}>
          {activity.length === 0 ? (
            <p className="cw-empty cw-pad">
              {sp.q || sp.actor ? (
                'No entries match, across the whole log. Clear the search or pick Everyone.'
              ) : (
                <>
                  No agent activity yet. Agents log each step here once you <Link to="/app/chat">ask one a question</Link>.
                </>
              )}
            </p>
          ) : (
            <table className="cw-table" data-list>
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Who</th>
                  <th scope="col">What</th>
                  <th scope="col">Input</th>
                  <th scope="col">Output</th>
                </tr>
              </thead>
              <tbody>
                {activity.map((a) => (
                  <tr key={a.id}>
                    <td className="num cw-nowrap">{fmtTime(a.createdAt)}</td>
                    <td>{a.actorType === 'agent' && isAgentKey(a.actorKey) ? AGENT_LABELS[a.actorKey].name : a.actorType === 'user' ? (a.actorLabel ?? 'A person') : a.actorType === 'system' ? 'Crosswire' : a.actorKey}</td>
                    <td>
                      {ACTION_WORDS[a.action] ?? a.action.replace(/_/g, ' ')}
                      <div className="cw-muted mono">{a.action}</div>
                    </td>
                    <td>
                      <code className="cw-clamp" title={a.inputSummary}>
                        {a.inputSummary.slice(0, 240) || <span className="cw-muted">empty</span>}
                      </code>
                    </td>
                    <td>
                      <code className="cw-clamp" title={a.outputSummary}>
                        {a.outputSummary.slice(0, 240) || <span className="cw-muted">empty</span>}
                      </code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        {(sp.before || hasMore) && (
          <div className="cw-panel2-foot" data-split>
            <button type="button" className="cw-btn" data-variant="ghost" data-size="sm" disabled={!sp.before} onClick={() => set({ before: undefined })}>
              Newest
            </button>
            <button type="button" className="cw-btn" data-variant="ghost" data-size="sm" disabled={!hasMore || !oldest} onClick={() => set({ before: oldest })}>
              Older entries
            </button>
          </div>
        )}
      </div>
    </section>
  )
}

type RunsData = Awaited<ReturnType<typeof fetchRuns>>
type RunDetail = NonNullable<Awaited<ReturnType<typeof fetchRunDetail>>>

function RunsView({ runs, rateSet, detail }: { runs: RunsData['runs']; rateSet: boolean; detail: RunDetail | null }) {
  const sp = Route.useSearch()
  const router = useRouter()
  const navigate = useNavigate({ from: '/app/agents' })
  const set = (patch: Partial<typeof sp>) => navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true })
  const live = runs.some((r) => r.status === 'running') || detail?.run.status === 'running'
  // While something is running, refresh every two seconds so status and Stop stay current.
  useEffect(() => {
    if (!live) return
    const t = setInterval(() => void router.invalidate(), 2000)
    return () => clearInterval(t)
  }, [live, router])
  return (
    <div className="cw-runs" data-open={detail ? '' : undefined}>
      <section aria-labelledby="runs-title" className="cw-runs-list">
        <h2 id="runs-title" className="cw-h2-compact">
          Runs
        </h2>
        <div className="cw-toolbar" data-attached>
          <label className="cw-inline">
            <span>Status</span>
            <select value={sp.rstatus ?? ''} onChange={(e) => set({ rstatus: (e.target.value || undefined) as typeof sp.rstatus })}>
              <option value="">Any</option>
              <option value="running">Running</option>
              <option value="completed">Completed</option>
              <option value="failed">Failed</option>
              <option value="interrupted">Stopped</option>
            </select>
          </label>
          <label className="cw-inline">
            <span>Agent</span>
            <select value={sp.ragent ?? ''} onChange={(e) => set({ ragent: (e.target.value || undefined) as typeof sp.ragent })}>
              <option value="">Any</option>
              {AGENT_KEYS.map((k) => (
                <option key={k} value={k}>
                  {AGENT_LABELS[k].name}
                </option>
              ))}
            </select>
          </label>
          <span className="cw-toolbar-meta num" role="status">
            {runs.length} runs{live ? ', updating live' : ''}
          </span>
        </div>
        {runs.length === 0 ? (
          <EmptyState
            title={sp.rstatus || sp.ragent ? 'No runs match these filters' : 'No runs yet'}
            body={sp.rstatus || sp.ragent ? 'Set Status and Agent back to Any to see every run.' : 'A run starts each time an agent replies in chat. Each one records its steps, tokens and output here.'}
            action={
              sp.rstatus || sp.ragent ? undefined : (
                <Link to="/app/chat" className="cw-btn" data-size="sm">
                  Ask an agent
                </Link>
              )
            }
          />
        ) : (
          <TableWrap label="Agent runs">
            <table className="cw-table" data-list>
              <thead>
                <tr>
                  <th scope="col">Agent</th>
                  <th scope="col">Status</th>
                  <th scope="col">Started</th>
                  <th scope="col" className="num">
                    Duration
                  </th>
                  <th scope="col" className="num">
                    Tokens in / out
                  </th>
                </tr>
              </thead>
              <tbody onKeyDown={listKeys}>
                {runs.map((r) => (
                  <tr key={r.id} aria-selected={sp.run === r.id} data-row>
                    <td>
                      <Link to="/app/agents" search={{ ...sp, run: r.id }} replace aria-current={sp.run === r.id ? 'true' : undefined}>
                        {agentLabel(r.agentKey)}
                      </Link>
                      {r.parentRunId && <span className="cw-muted"> · asked by Lead</span>}
                    </td>
                    <td>
                      <RunStatusTag status={r.status} />
                    </td>
                    <td className="cw-nowrap">
                      <time dateTime={r.startedAt}>{fmtTime(r.startedAt)}</time>
                    </td>
                    <td className="num">{fmtDuration(r.durationMs)}</td>
                    <td className="num">
                      {fmtTokens(r.inputTokens)} / {fmtTokens(r.outputTokens)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </section>
      {sp.run && !detail && (
        <Notice tone="info" title="Run not found">
          It may belong to another organisation, or it was removed by retention.
        </Notice>
      )}
      {detail && <RunPanel detail={detail} rateSet={rateSet} onClose={() => set({ run: undefined })} />}
    </div>
  )
}

function RunPanel({ detail, rateSet, onClose }: { detail: RunDetail; rateSet: boolean; onClose: () => void }) {
  const { run, parent, children, events, outputs, skill } = detail
  return (
    <section className="cw-panel2 cw-runpanel" aria-labelledby="run-title">
      <div className="cw-panel2-head">
        <h2 id="run-title">
          {agentLabel(run.agentKey)} run
        </h2>
        <RunStatusTag status={run.status} />
        <span className="cw-spacer" />
        {run.status === 'running' && <StopRunButton runId={run.id} />}
        <button type="button" className="cw-btn" data-variant="quiet" data-size="sm" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="cw-panel2-body">
        {run.error && (
          <Notice tone={run.status === 'interrupted' ? 'warn' : 'error'} title={run.status === 'interrupted' ? 'Stopped' : 'What went wrong'}>
            {plainMessage(run.error)}
          </Notice>
        )}
        <dl className="cw-provenance">
          <dt>Model</dt>
          <dd>
            {run.modelProvider ?? <span className="cw-muted">not recorded</span>}
            {run.modelName && <span className="mono"> · {run.modelName}</span>}
          </dd>
          <dt>Started</dt>
          <dd>
            <time dateTime={run.startedAt}>{fmtTime(run.startedAt)}</time>
          </dd>
          <dt>Duration</dt>
          <dd className="num">{fmtDuration(run.durationMs)}</dd>
          <dt>Tokens</dt>
          <dd className="num">
            {fmtTokens(run.inputTokens)} in, {fmtTokens(run.outputTokens)} out{!run.usageObserved && run.inputTokens !== null ? ' (estimate before the call)' : ''}
          </dd>
          <dt>Cost</dt>
          <dd className="num">{fmtCost(run.costMicros, rateSet)}</dd>
          <dt>Skill</dt>
          <dd>{skill ? <span className="mono">{skill.name} v{skill.version}</span> : <span className="cw-muted">none (Lead plans and delegates)</span>}</dd>
          {run.threadId && (
            <>
              <dt>Conversation</dt>
              <dd>
                <Link to="/app/chat/$threadId" params={{ threadId: run.threadId }}>
                  Open the conversation
                </Link>
                <span className="cw-muted"> (only the person who started it can open it)</span>
              </dd>
            </>
          )}
        </dl>
        {(parent || children.length > 0) && (
          <>
            <h3 className="cw-h3">Delegation</h3>
            <RunTree parent={parent} run={run} children={children} />
          </>
        )}
        <h3 className="cw-h3">Steps</h3>
        <ol className="cw-timeline" aria-label="Run steps, oldest first">
          {events.map((e) => (
            <li key={e.id} data-kind={e.kind === 'completed' ? 'result' : e.kind === 'failed' || e.kind === 'interrupted' ? 'failed' : undefined}>
              <span className="cw-ev-label">{EVENT_WORD[e.kind] ?? e.kind.replace(/_/g, ' ')}</span>
              <span className="cw-tl-time">
                <span className="num">#{e.seq}</span> · <time dateTime={e.createdAt}>{fmtTime(e.createdAt)}</time>
              </span>
              {e.kind === 'budget_estimate' && typeof e.payload.estimatedInputTokens === 'number' && (
                <p className="cw-muted">
                  About {e.payload.estimatedInputTokens.toLocaleString('en-AU')} input tokens.
                  {e.payload.ok === false ? ' Refused.' : ' Within budget.'}
                </p>
              )}
              {typeof e.payload.error === 'string' && e.payload.error && <p className="cw-muted">{plainMessage(e.payload.error)}</p>}
            </li>
          ))}
        </ol>
        <h3 className="cw-h3">Output</h3>
        <p className="cw-muted">Stored with secrets removed. Long tool results are kept in full.</p>
        {outputs.length === 0 ? (
          <p className="cw-empty">This run stored no output. A run refused before the model call has only its steps.</p>
        ) : (
          outputs.map((o) => (
            <details key={o.id} className="cw-output" open={o.kind === 'assistant' || o.kind === 'error'}>
              <summary>
                {outputLabel(o.kind)} <span className="cw-muted">· {fmtTime(o.createdAt)}</span>
              </summary>
              <pre>{o.body}</pre>
            </details>
          ))
        )}
        <details className="cw-output">
          <summary>Fingerprints (for audit)</summary>
          <dl className="cw-provenance mono">
            <dt>Run id</dt>
            <dd>{run.id}</dd>
            <dt>Policy</dt>
            <dd>{run.policySha256 ?? 'not recorded'}</dd>
            <dt>Charter</dt>
            <dd>{run.charterSha256 ?? 'not recorded'}</dd>
            <dt>Tools</dt>
            <dd>{run.toolsetSha256 ?? 'not recorded'}</dd>
            <dt>Memory</dt>
            <dd>{run.memorySha256 ?? 'not recorded'}</dd>
            <dt>Squad SDK</dt>
            <dd>{run.sdkVersion ?? 'not recorded'}</dd>
          </dl>
        </details>
      </div>
    </section>
  )
}

type Queue = Awaited<ReturnType<typeof fetchReviewQueue>>

function ReviewQueue({ queue }: { queue: Queue }) {
  const router = useRouter()
  const { session } = Route.useRouteContext()
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  return (
    <section aria-labelledby="review-title">
      <h2 id="review-title" className="cw-h2-compact">
        Held for review <span className="cw-muted num">({queue.length})</span>
      </h2>
      <p className="cw-muted cw-measure">
        Notes from chat, tools, imports and feedback start out held. They stay out of every agent prompt until an owner or approver who did not write them promotes them. Leave a note held and it stays in the record, unused.
      </p>
      {msg && (
        <Notice tone={msg.tone} title={msg.tone === 'ok' ? 'Promoted' : 'Not promoted'}>
          {msg.text}
        </Notice>
      )}
      {!session.canApprove && <Notice tone="info">Only owners and approvers can promote notes. You can read the queue.</Notice>}
      {queue.length === 0 ? (
        <EmptyState title="Nothing waiting" body="No notes are held. New notes from chat or feedback will appear here for a second person to check." />
      ) : (
        <ul className="cw-inbox">
          {queue.map((entry) => (
            <li key={entry.id} className="cw-inbox-item">
              <div className="cw-inbox-main">
                <p className="cw-inbox-body">
                  {entry.body}
                  {entry.redacted && (
                    <span className="cw-badge" data-tone="warn">
                      secret removed
                    </span>
                  )}
                </p>
                <dl className="cw-meta">
                  <div>
                    <dt>Agent</dt>
                    <dd>{agentLabel(entry.agentKey)}</dd>
                  </div>
                  <div>
                    <dt>Source</dt>
                    <dd>{SOURCE_WORD[entry.sourceType ?? ''] ?? entry.sourceType ?? 'unknown'}</dd>
                  </div>
                  <div>
                    <dt>Trust</dt>
                    <dd>
                      <span className="cw-badge" data-tone="warn">
                        Held
                      </span>
                    </dd>
                  </div>
                  <div>
                    <dt>Written by</dt>
                    <dd>{entry.mine ? 'You' : (entry.authorLabel ?? <span className="cw-muted">no author</span>)}</dd>
                  </div>
                  <div>
                    <dt>Added</dt>
                    <dd>
                      <time dateTime={entry.createdAt}>{fmtTime(entry.createdAt)}</time>
                    </dd>
                  </div>
                </dl>
                <p className="cw-help">
                  If promoted: {agentLabel(entry.agentKey)} reads this {entry.kind === 'safety' ? 'safety rule in every prompt' : 'note in its prompt (the 20 newest notes are used)'}.
                </p>
              </div>
              <div className="cw-inbox-actions">
                {entry.blocked ? (
                  <p className="cw-help" data-reason>
                    {entry.blocked}
                  </p>
                ) : (
                  <button
                    type="button"
                    className="cw-btn"
                    data-size="sm"
                    disabled={busy !== null}
                    onClick={async () => {
                      setBusy(entry.id)
                      setMsg(null)
                      try {
                        await promoteMemoryFn({ data: { entryId: entry.id } })
                        setMsg({ tone: 'ok', text: `${agentLabel(entry.agentKey)} will read this note from its next reply.` })
                        await router.invalidate()
                      } catch (err) {
                        setMsg({ tone: 'error', text: plainMessage(err) })
                      } finally {
                        setBusy(null)
                      }
                    }}
                  >
                    {busy === entry.id ? 'Promoting…' : `Promote to ${agentLabel(entry.agentKey)}`}
                  </button>
                )}
                <span className="cw-help">Leave it held to keep it out of the prompt.</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

const SOURCE_WORD: Record<string, string> = {
  thread: 'Chat',
  message: 'Chat message',
  import: 'Import',
  remember: 'Agent "remember"',
  tool: 'Tool output',
  feedback: 'Reply feedback',
  scribe: 'Scribe note',
  operator: 'Operator note',
}

type Skills = Awaited<ReturnType<typeof fetchSkills>>

function SkillsView({ skills }: { skills: Skills }) {
  return (
    <section aria-labelledby="skills-title">
      <h2 id="skills-title" className="cw-h2-compact">
        Reviewed skills
      </h2>
      <p className="cw-muted cw-measure">Each specialist works under one reviewed skill. A skill lists the only tools that agent may use and the evidence it must cite. Lead has none of its own: it plans and asks the specialists.</p>
      <div className="cw-skillgrid">
        {skills.map((s) => (
          <article key={s.name} className="cw-card cw-skill" aria-labelledby={`skill-${s.name}`}>
            <header>
              <h3 id={`skill-${s.name}`} className="mono">
                {s.name}
              </h3>
              <span className="cw-badge">v{s.version}</span>
            </header>
            <p>{s.description}</p>
            <dl className="cw-provenance">
              <dt>Agent</dt>
              <dd>{agentLabel(s.agent)}</dd>
              <dt>Allowed tools</dt>
              <dd>
                <ul className="cw-chips" aria-label={`Tools ${s.name} may use`}>
                  {s.tools.map((t) => (
                    <li key={t} className="cw-chip mono">
                      {t}
                    </li>
                  ))}
                </ul>
              </dd>
            </dl>
            <details>
              <summary>When each tool is used, and the evidence rule</summary>
              <ul className="cw-plainlist">
                {s.steps.map((step) => (
                  <li key={step.name}>
                    <span className="mono">{step.name}</span>: {step.when ?? 'no condition recorded'}
                  </li>
                ))}
              </ul>
              <pre>{s.content}</pre>
            </details>
          </article>
        ))}
      </div>
    </section>
  )
}

function RefreshButton() {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  return (
    <button
      type="button"
      className="cw-btn"
      data-variant="ghost"
      data-size="sm"
      disabled={busy}
      onClick={async () => {
        setBusy(true)
        await router.invalidate()
        setBusy(false)
      }}
    >
      {busy ? 'Refreshing…' : 'Refresh'}
    </button>
  )
}

function Memory({ agent }: { agent: AgentKey }) {
  const { session } = Route.useRouteContext()
  const [memory, setMemory] = useState<Awaited<ReturnType<typeof fetchMemory>> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [kind, setKind] = useState<'fact' | 'safety'>('fact')
  const [replacing, setReplacing] = useState<string | null>(null)
  const [replacement, setReplacement] = useState('')
  const [find, setFind] = useState('')
  const reload = async () => {
    const next = await fetchMemory({ data: { agentKey: agent } })
    setMemory(next)
    return next
  }
  useEffect(() => {
    let live = true
    fetchMemory({ data: { agentKey: agent } })
      .then((m) => live && setMemory(m))
      .catch((err) => live && setError(err instanceof Error ? err.message : String(err)))
    return () => {
      live = false
    }
  }, [agent])
  return (
    <section className="cw-panel2" aria-labelledby="mem-title" aria-busy={!memory && !error}>
      <div className="cw-panel2-head">
        <h2 id="mem-title">
          {AGENT_LABELS[agent].name} memory {memory && <span className="cw-muted num">(version {memory.version})</span>}
        </h2>
        {session.canApprove && memory && (
          <button
            type="button"
            className="cw-btn cw-ml-auto"
            data-variant="ghost"
            data-size="sm"
           
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              try {
                const r = await runCompaction({ data: { agentKey: agent } })
                setMsg(`Compacted: ${r.before} → ${r.after} live entries, now version ${r.version}.`)
                setMemory(await fetchMemory({ data: { agentKey: agent } }))
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err))
              } finally {
                setBusy(false)
              }
            }}
          >
            {busy ? 'Compacting…' : 'Compact memory'}
          </button>
        )}
      </div>
      <div className="cw-panel2-body">
        <p className="cw-help cw-m0" role="status">
          {msg ?? ''}
        </p>
        {error && <Notice tone="error">{error}</Notice>}
        <label className="cw-search">
          <span className="cw-sr-only">Find a memory</span>
          <input type="search" placeholder="Find a memory" value={find} onChange={(e) => setFind(e.target.value)} />
        </label>
        <details>
          <summary>Add a note</summary>
          <form
            className="cw-form"
            onSubmit={async (e) => {
              e.preventDefault()
              setBusy(true)
              setError(null)
              try {
                const saved = await rememberFn({ data: { agentKey: agent, body: note, kind } })
                setNote('')
                setMsg(saved.trust === 'quarantine' ? 'Saved. Governance held it out of the prompt.' : 'Saved. It can enter the prompt.')
                setMemory(await reload())
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err))
              } finally {
                setBusy(false)
              }
            }}
          >
            <label>
              Note
              <span className="cw-help">An operator note. Forbidden text is refused. Text that looks like an instruction override is stored and kept out of the prompt.</span>
              <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={2000} />
            </label>
            <div className="cw-cluster">
              <label className="cw-inline">
                Kind
                <select value={kind} onChange={(e) => setKind(e.target.value as 'fact' | 'safety')}>
                  <option value="fact">Fact</option>
                  <option value="safety">Safety</option>
                </select>
              </label>
              <button className="cw-btn" type="submit" data-size="sm" disabled={busy || !note.trim()}>
                {busy ? 'Saving…' : 'Save note'}
              </button>
            </div>
          </form>
        </details>
        {!memory && !error && <p className="cw-muted">Loading memory…</p>}
        {memory && (
          <>
            {memory.body && (
              <details>
                <summary>Core context</summary>
                <pre>{memory.body}</pre>
              </details>
            )}
            {(() => {
              const needle = find.trim().toLowerCase()
              const entries = needle.length < 2 ? memory.entries : memory.entries.filter((entry) => entry.body.toLowerCase().includes(needle))
              if (memory.entries.length === 0) return <p className="cw-empty">No notes yet.</p>
              if (entries.length === 0) return <p className="cw-empty">No notes match.</p>
              return (
                <ul className="cw-agentlist">
                  {entries.map((entry) => {
                    const canPromote = session.canApprove && entry.trust === 'quarantine' && Boolean(entry.authorId) && entry.authorId !== session.user.id
                    return (
                      <li key={entry.id}>
                        <p>
                          {entry.body}
                          {entry.redacted && (
                            <span className="cw-badge cw-ml-2xs" data-tone="warn">
                              redacted
                            </span>
                          )}
                        </p>
                        <p className="cw-muted">
                          {entry.inPrompt ? 'In prompt' : 'Held back'}. {entry.reason}
                        </p>
                        {canPromote ? (
                          <button
                            type="button"
                            className="cw-btn"
                            data-variant="ghost"
                            data-size="sm"
                            disabled={busy}
                            onClick={async () => {
                              setBusy(true)
                              setError(null)
                              try {
                                await promoteMemoryFn({ data: { entryId: entry.id } })
                                setMsg('Promoted. A different person approved it for the prompt.')
                                setMemory(await reload())
                              } catch (err) {
                                setError(err instanceof Error ? err.message : String(err))
                              } finally {
                                setBusy(false)
                              }
                            }}
                          >
                            Promote
                          </button>
                        ) : (
                          session.canApprove && (
                            <button
                              type="button"
                              className="cw-btn"
                              data-variant="ghost"
                              data-size="sm"
                              onClick={() => {
                                setReplacing(replacing === entry.id ? null : entry.id)
                                setReplacement('')
                              }}
                            >
                              Replace
                            </button>
                          )
                        )}
                        {session.canApprove && replacing === entry.id && (
                          <form
                            className="cw-form"
                            onSubmit={async (ev) => {
                              ev.preventDefault()
                              setBusy(true)
                              setError(null)
                              try {
                                await replaceMemoryFn({ data: { entryId: entry.id, body: replacement } })
                                setReplacing(null)
                                setReplacement('')
                                setMsg('Replaced. The old note is tombstoned and stays out of the prompt.')
                                setMemory(await reload())
                              } catch (err) {
                                setError(err instanceof Error ? err.message : String(err))
                              } finally {
                                setBusy(false)
                              }
                            }}
                          >
                            <label>
                              Replacement
                              <textarea value={replacement} onChange={(ev) => setReplacement(ev.target.value)} rows={2} maxLength={2000} required />
                            </label>
                            <button className="cw-btn" type="submit" data-size="sm" disabled={busy || !replacement.trim()}>
                              Tombstone old note
                            </button>
                          </form>
                        )}
                        <details>
                          <summary>Details</summary>
                          <p className="cw-muted">
                            Kind {entry.kind}. Trust {entry.trust}. Class {entry.sdkClass ?? 'none'}. Source {entry.sourceType ?? 'unknown'}. Added {fmtTime(entry.createdAt)}
                            {entry.authorLabel ? ` by ${entry.authorLabel}` : ''}.
                          </p>
                          {canPromote && (
                            <button
                              type="button"
                              className="cw-linkbtn"
                              onClick={() => {
                                setReplacing(replacing === entry.id ? null : entry.id)
                                setReplacement('')
                              }}
                            >
                              Replace
                            </button>
                          )}
                        </details>
                      </li>
                    )
                  })}
                </ul>
              )
            })()}
            <details>
              <summary>history.md export</summary>
              <pre>{memory.markdown}</pre>
            </details>
          </>
        )}
      </div>
    </section>
  )
}

type Desk = Awaited<ReturnType<typeof fetchAgentDesk>>

function usd(micros: number) {
  return `$${(micros / 1_000_000).toFixed(2)}`
}

function BudgetMeter({ budget }: { budget: Desk['budget'] }) {
  const context = budget.context
  const percent = context ? Math.round(context.utilization * 100) : null
  const used = budget.dailyInputCap > 0 ? Math.min(100, Math.round((budget.inputTokens / budget.dailyInputCap) * 100)) : 0
  const tone = used >= 100 ? 'danger' : used >= 80 ? 'warn' : 'ok'
  return (
    <section aria-labelledby="budget-title" className="cw-usage">
      <h2 id="budget-title" className="cw-sr-only">
        Usage today
      </h2>
      {budget.unmeasured > 0 && (
        <Notice tone="warn" title="Agent replies are paused until midnight UTC">
          A model call today did not report how many tokens it used, so Crosswire cannot check the daily budget and refuses new calls. This is a safety rule. It clears at midnight UTC. If it keeps happening, check that the model endpoint returns token usage.
        </Notice>
      )}
      {budget.unmeasured === 0 && used >= 80 && (
        <Notice tone={used >= 100 ? 'error' : 'warn'} title={used >= 100 ? "Today's token budget is used up" : `${used}% of today's token budget is used`}>
          {used >= 100 ? 'New agent replies are refused until midnight UTC.' : 'Agent replies stop when it reaches 100%.'} An owner can raise the limit in the deployment settings (BUDGET_DAILY_INPUT_TOKENS).
        </Notice>
      )}
      <dl className="cw-ctxbar" aria-label="Usage today">
        <div>
          <dt>Input tokens today</dt>
          <dd className="num">
            {budget.inputTokens.toLocaleString('en-AU')} of {budget.dailyInputCap.toLocaleString('en-AU')}
            <span className="cw-meter" data-tone={tone} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={used} aria-label="Share of the daily token budget used">
              <span style={{ width: `${used}%` }} />
            </span>
            <span className="cw-muted">{used}%</span>
          </dd>
        </div>
        <div>
          <dt>Output tokens</dt>
          <dd className="num">{budget.outputTokens.toLocaleString('en-AU')}</dd>
        </div>
        <div>
          <dt>Last measured call</dt>
          <dd>
            {context && percent !== null ? (
              <>
                {percent}% of the context window. Calls stop at 80%.
                {context.warning ? ' This call was at or over that line.' : ''}
              </>
            ) : (
              'No measured call yet.'
            )}
          </dd>
        </div>
        <div>
          <dt>Spend</dt>
          <dd>
            {!budget.rateSet
              ? 'Unpriced (no token price is set).'
              : budget.unpriced > 0
                ? 'Some calls have no price, so a spend cap cannot be checked.'
                : budget.spendCapMicros !== null
                  ? `${usd(budget.costMicros)} of ${usd(budget.spendCapMicros)}`
                  : usd(budget.costMicros)}
          </dd>
        </div>
      </dl>
    </section>
  )
}

function Directives({ directives }: { directives: Desk['directives'] }) {
  const { session } = Route.useRouteContext()
  const router = useRouter()
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const refresh = () => router.invalidate()
  const approved = directives.filter((directive) => directive.status === 'approved').length
  return (
    <details className="cw-panel2">
      <summary className="cw-panel2-head cw-pointer">
        <h2 id="directive-title" className="cw-h2-compact cw-inline-h">
          Directives <span className="cw-muted num">({approved} in the prompt)</span>
        </h2>
      </summary>
      <div className="cw-panel2-body">
      <p className="cw-muted">Approved directives go into every agent prompt. A draft needs a different owner or approver. Retire removes it from the prompt.</p>
      {error && <Notice tone="error">{error}</Notice>}
      <form
        className="cw-form"
        onSubmit={async (e) => {
          e.preventDefault()
          setBusy(true)
          setError(null)
          try {
            await createDirectiveFn({ data: { title, body } })
            setTitle('')
            setBody('')
            await refresh()
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
          } finally {
            setBusy(false)
          }
        }}
      >
        <label>
          Title
          <input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={120} />
        </label>
        <label>
          Directive
          <textarea value={body} onChange={(e) => setBody(e.target.value)} required rows={3} maxLength={2000} />
        </label>
        <button className="cw-btn" type="submit" disabled={busy || !title.trim() || !body.trim()}>
          {busy ? 'Saving…' : 'Save draft'}
        </button>
      </form>
      {directives.length === 0 ? (
        <p className="cw-empty">No directives yet.</p>
      ) : (
        <TableWrap label="Org directives">
          <table className="cw-table">
            <thead>
              <tr>
                <th scope="col">Status</th>
                <th scope="col">Directive</th>
                {session.canApprove && <th scope="col">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {directives.map((directive) => (
                <tr key={directive.id}>
                  <td>{directive.status}</td>
                  <td>
                    <strong>{directive.title}</strong>
                    <div>{directive.body}</div>
                  </td>
                  {session.canApprove && (
                    <td>
                      {directive.status === 'draft' && directive.createdBy !== session.user.id && (
                        <button
                          type="button"
                          className="cw-btn"
                          data-size="sm"
                          disabled={busy}
                          onClick={async () => {
                            setBusy(true)
                            setError(null)
                            try {
                              await approveDirectiveFn({ data: { directiveId: directive.id } })
                              await refresh()
                            } catch (err) {
                              setError(err instanceof Error ? err.message : String(err))
                            } finally {
                              setBusy(false)
                            }
                          }}
                        >
                          Approve
                        </button>
                      )}
                      {directive.status === 'draft' && directive.createdBy === session.user.id && <span className="cw-muted">Another approver must approve this.</span>}
                      {directive.status === 'approved' && (
                        <button
                          type="button"
                          className="cw-btn"
                          data-variant="ghost"
                          data-size="sm"
                          disabled={busy}
                          onClick={async () => {
                            setBusy(true)
                            setError(null)
                            try {
                              await retireDirectiveFn({ data: { directiveId: directive.id } })
                              await refresh()
                            } catch (err) {
                              setError(err instanceof Error ? err.message : String(err))
                            } finally {
                              setBusy(false)
                            }
                          }}
                        >
                          Retire
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
      </div>
    </details>
  )
}
