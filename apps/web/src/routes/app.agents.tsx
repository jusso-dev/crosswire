import { Link, createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { z } from 'zod'
import { fetchActivity, fetchMemory, fetchRunReplay, runCompaction } from '../fns/agents'
import { AGENT_KEYS, AGENT_LABELS, isAgentKey, type AgentKey } from '../shared/agents'
import { fmtTime } from '../components/format'
import { Notice, PageHead, TableWrap } from '../components/ui'

/**
 * Agents and decision log. Agent selection and log filters live in the URL. Memory is loaded on
 * demand for the selected agent; compaction is an approver action enforced on the server.
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
  validateSearch: z.object({ agent: z.string().optional(), actor: z.string().optional(), q: z.string().optional(), before: z.string().optional(), run: z.uuid().optional() }),
  loaderDeps: ({ search }) => ({ q: search.q, actor: search.actor, before: search.before, run: search.run }),
  // Search and paging run on the server over the whole log, not just the newest page.
  loader: async ({ deps }) => {
    const q = deps.q?.trim().toLowerCase()
    const actions = q ? Object.entries(ACTION_WORDS).filter(([, label]) => label.toLowerCase().includes(q)).map(([key]) => key) : undefined
    const activity = await fetchActivity({ data: { q: deps.q || undefined, actor: deps.actor || undefined, before: deps.before || undefined, actions } })
    const replay = deps.run ? await fetchRunReplay({ data: { runId: deps.run } }) : null
    return { ...activity, replay }
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
  const { rows: activity, hasMore, actors, recentRuns, replay } = Route.useLoaderData()
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
        intro="Your AI security team, what each one remembers, and every step they took. Use the log to check why an agent suggested something."
        actions={
          <Link to="/app/chat" className="cw-btn">
            Ask an agent
          </Link>
        }
      />
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

      {agent && <Memory key={agent} agent={agent} />}

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
                      <th scope="col">Entry</th>
                      <th scope="col">Added</th>
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
                        </td>
                        <td>{e.body}</td>
                        <td className="num">{fmtTime(e.createdAt)}</td>
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
