import { Link, createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { z } from 'zod'
import { approveDirectiveFn, createDirectiveFn, fetchActivity, fetchAgentDesk, fetchMemory, fetchRunReplay, promoteMemoryFn, rememberFn, replaceMemoryFn, retireDirectiveFn, runCompaction } from '../fns/agents'
import { AGENT_KEYS, AGENT_LABELS, isAgentKey, type AgentKey } from '../shared/agents'
import { fmtTime } from '../components/format'
import { Notice, PageHead, TableWrap } from '../components/ui'

/**
 * Agents and decision log. Agent selection, log filters and memory search live in the URL.
 * Memory is loaded on demand for the selected agent. Promote, replace, compact and directive
 * approval are approver actions enforced on the server.
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
  validateSearch: z.object({ agent: z.string().optional(), actor: z.string().optional(), q: z.string().optional(), mq: z.string().optional(), before: z.string().optional(), run: z.uuid().optional() }),
  loaderDeps: ({ search }) => ({ q: search.q, actor: search.actor, before: search.before, run: search.run, mq: search.mq }),
  // Search and paging run on the server over the whole log, not just the newest page.
  loader: async ({ deps }) => {
    const q = deps.q?.trim().toLowerCase()
    const actions = q ? Object.entries(ACTION_WORDS).filter(([, label]) => label.toLowerCase().includes(q)).map(([key]) => key) : undefined
    const [activity, replay, desk] = await Promise.all([
      fetchActivity({ data: { q: deps.q || undefined, actor: deps.actor || undefined, before: deps.before || undefined, actions } }),
      deps.run ? fetchRunReplay({ data: { runId: deps.run } }) : Promise.resolve(null),
      fetchAgentDesk({ data: { q: deps.mq || undefined } }),
    ])
    return { ...activity, replay, desk }
  },
  pendingComponent: () => <p className="cw-muted">Loading agents…</p>,
  errorComponent: ({ error }) => (
    <Notice tone="error" title="Could not load agent activity">
      {error instanceof Error ? error.message : String(error)}
    </Notice>
  ),
  component: Agents,
})

function Agents() {
  const { rows: activity, hasMore, actors, recentRuns, replay, desk } = Route.useLoaderData()
  const sp = Route.useSearch()
  const navigate = useNavigate({ from: '/app/agents' })
  const set = (patch: Partial<typeof sp>) => navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true })
  const agent: AgentKey | null = isAgentKey(sp.agent) ? sp.agent : null
  const shown = activity
  const [q, setQ] = useState(sp.q ?? '')
  // Debounce typing into the URL, which re-queries the server over the whole log.
  useEffect(() => {
    if ((sp.q ?? '') === q) return
    const t = setTimeout(() => set({ q: q || undefined, before: undefined }), 300)
    return () => clearTimeout(t)
  }, [q]) // eslint-disable-line react-hooks/exhaustive-deps
  const oldest = activity.at(-1)?.createdAt

  return (
    <>
      <PageHead
        title="Agents and log"
        intro="Your AI security team, what each one remembers, the rules in their prompt, and every step they took. Usage figures are read from this organisation's database."
        actions={
          <Link to="/app/chat" className="cw-btn">
            Ask an agent
          </Link>
        }
      />
      <BudgetMeter budget={desk.budget} />

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
                <span className="cw-agentbtn-cta">{agent === k ? 'Hide memory' : 'View memory'}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      <MemorySearch query={sp.mq ?? ''} hits={desk.hits} onQuery={(mq) => set({ mq: mq || undefined })} onOpen={(agentKey) => set({ agent: agentKey })} />

      {agent && <Memory key={agent} agent={agent} />}

      <Directives directives={desk.directives} />

      <section aria-labelledby="log-title">
        <h2 id="log-title" className="cw-h2-compact">
          Decision log
        </h2>
        <p className="cw-muted">
          Every agent step, hand-off, search decision and response decision for this organisation. Secrets and personal details are removed before logging. Each input and output keeps the first 1000 characters. Longer text then adds a marker such as <code>… [truncated 42 chars]</code>. The full redacted text stays on the run record. Open that run below. This table is the summary, and the tooltip shows that same summary.
        </p>
        <div className="cw-tablewrap" style={{ overflow: 'visible' }}>
          <div className="cw-toolbar" style={{ borderRadius: 'var(--radius-lg) var(--radius-lg) 0 0' }}>
            <label className="cw-search">
              <span className="cw-sr-only">Filter the log</span>
              <input type="search" placeholder="Search the whole log" value={q} onChange={(e) => setQ(e.target.value)} />
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
              {shown.length} entries{sp.before ? ' (older page)' : ''}{hasMore ? ', more available' : ''}
            </span>
            <RefreshButton />
          </div>
          <div style={{ overflowX: 'auto' }} role="region" aria-label="Decision log table" tabIndex={0}>
            {shown.length === 0 ? (
              <p className="cw-empty" style={{ padding: 'var(--space-md)' }}>
                {sp.q || sp.actor ? 'No entries match, across the whole log.' : (
                  <>
                    No agent activity yet. Pick an agent in <Link to="/app/chat">chat</Link> to start.
                  </>
                )}
              </p>
            ) : (
              <table className="cw-table">
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
                  {shown.map((a) => (
                    <tr key={a.id}>
                      <td className="num" style={{ whiteSpace: 'nowrap' }}>
                        {fmtTime(a.createdAt)}
                      </td>
                      <td>
                        {a.actorType === 'agent' && isAgentKey(a.actorKey) ? AGENT_LABELS[a.actorKey].name : a.actorType === 'user' ? (a.actorLabel ?? 'A person') : a.actorType === 'system' ? 'Crosswire' : a.actorKey}
                      </td>
                      <td>
                        {ACTION_WORDS[a.action] ?? a.action.replace(/_/g, ' ')}
                        <div className="cw-muted mono">{a.action}</div>
                      </td>
                      <td>
                        <code className="cw-clamp" title={a.inputSummary}>
                          {a.inputSummary.slice(0, 240) || '—'}
                        </code>
                      </td>
                      <td>
                        <code className="cw-clamp" title={a.outputSummary}>
                          {a.outputSummary.slice(0, 240) || '—'}
                        </code>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          {(sp.before || hasMore) && (
            <div className="cw-panel2-foot" style={{ justifyContent: 'space-between' }}>
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

      <section aria-labelledby="replay-title">
        <h2 id="replay-title" className="cw-h2-compact">
          Run replay
        </h2>
        <p className="cw-muted">Full redacted output for one run in this organisation. Another organisation cannot open it.</p>
        {recentRuns.length === 0 ? (
          <p className="cw-empty">No runs yet.</p>
        ) : (
          <ul className="cw-agentlist">
            {recentRuns.map((run) => (
              <li key={run.id}>
                <button type="button" className="cw-agentbtn" aria-pressed={sp.run === run.id} onClick={() => set({ run: sp.run === run.id ? undefined : run.id })}>
                  <strong>{isAgentKey(run.agentKey) ? AGENT_LABELS[run.agentKey].name : run.agentKey}</strong>
                  <span className="cw-muted">{run.status}</span>
                  <span className="cw-agentbtn-cta">{fmtTime(run.startedAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {sp.run && !replay && <p className="cw-empty">That run is not in this organisation.</p>}
        {replay && (
          <div className="cw-panel2">
            <div className="cw-panel2-head">
              <h3>
                {isAgentKey(replay.agentKey) ? AGENT_LABELS[replay.agentKey].name : replay.agentKey} {replay.status}
              </h3>
            </div>
            <div className="cw-panel2-body">
              {replay.outputs.length === 0 ? (
                <p className="cw-empty">This run has no stored output.</p>
              ) : (
                replay.outputs.map((output) => (
                  <article key={output.id}>
                    <h3 className="cw-h2-compact">{output.kind}</h3>
                    <pre>{output.body}</pre>
                  </article>
                ))
              )}
            </div>
          </div>
        )}
      </section>
    </>
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
            className="cw-btn"
            data-variant="ghost"
            data-size="sm"
            style={{ marginLeft: 'auto' }}
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
        <p className="cw-help" role="status" style={{ margin: 0 }}>
          {msg ?? ''}
        </p>
        {error && <Notice tone="error">{error}</Notice>}
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
            Add a note
            <span className="cw-help">An operator note. Forbidden text is refused. Text that looks like an instruction override is stored and kept out of the prompt.</span>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={2000} />
          </label>
          <div style={{ display: 'flex', gap: 'var(--space-xs)', flexWrap: 'wrap', alignItems: 'center' }}>
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
        {!memory && !error && <p className="cw-muted">Loading memory…</p>}
        {memory && (
          <>
            {memory.body && <pre>{memory.body}</pre>}
            {memory.entries.length === 0 ? (
              <p className="cw-empty">No live memory entries.</p>
            ) : (
              <TableWrap label={`${AGENT_LABELS[agent].name} memory entries`}>
                <table className="cw-table">
                  <thead>
                    <tr>
                      <th scope="col">Kind</th>
                      <th scope="col">Trust</th>
                      <th scope="col">Class</th>
                      <th scope="col">Prompt</th>
                      <th scope="col">Entry</th>
                      <th scope="col">Added</th>
                      {session.canApprove && <th scope="col">Actions</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {memory.entries.map((e) => (
                      <tr key={e.id}>
                        <td>
                          <span className="cw-badge">{e.kind}</span>
                          {e.redacted && (
                            <span className="cw-badge" data-tone="warn" style={{ marginLeft: 4 }}>
                              redacted
                            </span>
                          )}
                          {e.sourceType && <div className="cw-muted">{e.sourceType}</div>}
                        </td>
                        <td>{e.trust}</td>
                        <td>{e.sdkClass ?? 'none'}</td>
                        <td>
                          {e.inPrompt ? 'In prompt' : 'Held back'}
                          <div className="cw-muted">{e.reason}</div>
                        </td>
                        <td>
                          {e.body}
                          {e.authorLabel && <div className="cw-muted">by {e.authorLabel}</div>}
                          {session.canApprove && replacing === e.id && (
                            <form
                              className="cw-form"
                              onSubmit={async (ev) => {
                                ev.preventDefault()
                                setBusy(true)
                                setError(null)
                                try {
                                  await replaceMemoryFn({ data: { entryId: e.id, body: replacement } })
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
                        </td>
                        <td className="num">{fmtTime(e.createdAt)}</td>
                        {session.canApprove && (
                          <td>
                            {e.trust === 'quarantine' && e.authorId && e.authorId !== session.user.id && (
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
                                    await promoteMemoryFn({ data: { entryId: e.id } })
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
                            )}
                            <button
                              type="button"
                              className="cw-btn"
                              data-variant="ghost"
                              data-size="sm"
                              onClick={() => {
                                setReplacing(replacing === e.id ? null : e.id)
                                setReplacement('')
                              }}
                            >
                              Replace
                            </button>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            )}
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
  return (
    <section aria-labelledby="budget-title">
      <h2 id="budget-title" className="cw-h2-compact">
        Usage
      </h2>
      <p className="cw-muted">Today is UTC and includes reservations that have not settled. The context figure is the last call that reported token counts. It is not a live window.</p>
      <dl className="cw-ctxbar" aria-label="Usage today">
        <div>
          <dt>Input tokens</dt>
          <dd className="num">
            {budget.inputTokens} / {budget.dailyInputCap}
          </dd>
        </div>
        <div>
          <dt>Output tokens</dt>
          <dd className="num">{budget.outputTokens}</dd>
        </div>
        <div>
          <dt>Last measured call</dt>
          <dd>
            {context && percent !== null ? (
              <>
                {context.occupiedTokens} of {context.contextWindowTokens} tokens ({percent}%). Refusal line is 80%.
                {context.warning ? ' This call is at or over that line.' : ''}
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
              ? 'No token price is configured.'
              : budget.unpriced > 0
                ? 'Some calls have no price, so a spend cap cannot be checked.'
                : budget.spendCapMicros !== null
                  ? `${usd(budget.costMicros)} of ${usd(budget.spendCapMicros)}`
                  : usd(budget.costMicros)}
          </dd>
        </div>
      </dl>
      {budget.unmeasured > 0 && (
        <p className="cw-help" role="status">
          A call today has no token count, so the next model call is refused until that is resolved.
        </p>
      )}
    </section>
  )
}

function MemorySearch({ query, hits, onQuery, onOpen }: { query: string; hits: Desk['hits']; onQuery: (query: string) => void; onOpen: (agentKey: AgentKey) => void }) {
  const [text, setText] = useState(query)
  useEffect(() => {
    if (query === text) return
    const t = setTimeout(() => onQuery(text.trim()), 300)
    return () => clearTimeout(t)
  }, [text]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <section aria-labelledby="find-title">
      <h2 id="find-title" className="cw-h2-compact">
        Find memory
      </h2>
      <p className="cw-muted">Searches every agent in this organisation, including notes held out of the prompt. At least two characters.</p>
      <label className="cw-search">
        <span className="cw-sr-only">Find memory</span>
        <input type="search" placeholder="Search memory" value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      {query.trim().length >= 2 && hits.length === 0 && <p className="cw-empty">No memory matches.</p>}
      {hits.length > 0 && (
        <TableWrap label="Memory search results">
          <table className="cw-table">
            <thead>
              <tr>
                <th scope="col">Agent</th>
                <th scope="col">Trust</th>
                <th scope="col">Prompt</th>
                <th scope="col">Entry</th>
              </tr>
            </thead>
            <tbody>
              {hits.map((hit) => (
                <tr key={hit.id}>
                  <td>
                    {isAgentKey(hit.agentKey) ? (
                      <button type="button" className="cw-linkbtn" onClick={() => onOpen(hit.agentKey as AgentKey)}>
                        {AGENT_LABELS[hit.agentKey].name}
                      </button>
                    ) : (
                      hit.agentKey
                    )}
                  </td>
                  <td>{hit.trust}</td>
                  <td>
                    {hit.inPrompt ? 'In prompt' : 'Held back'}
                    <div className="cw-muted">{hit.reason}</div>
                  </td>
                  <td>{hit.body}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
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
  return (
    <section aria-labelledby="directive-title">
      <h2 id="directive-title" className="cw-h2-compact">
        Org directives
      </h2>
      <p className="cw-muted">Approved directives are injected into every agent prompt. A draft needs a different owner or approver. Retiring removes it from the prompt. Skills stay in reviewed code.</p>
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
    </section>
  )
}
