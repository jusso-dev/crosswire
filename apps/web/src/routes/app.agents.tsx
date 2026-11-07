import { Link, createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { z } from 'zod'
import { fetchActivity, fetchMemory, runCompaction } from '../fns/agents'
import { AGENT_KEYS, AGENT_LABELS, isAgentKey, type AgentKey } from '../shared/agents'
import { fmtTime } from '../components/format'
import { Notice, PageHead, TableWrap } from '../components/ui'

/**
 * Agents and decision log. Agent selection and log filters live in the URL. Memory is loaded on
 * demand for the selected agent; compaction is an approver action enforced on the server.
 */
export const Route = createFileRoute('/app/agents')({
  validateSearch: z.object({ agent: z.string().optional(), actor: z.string().optional(), q: z.string().optional() }),
  loader: () => fetchActivity(),
  pendingComponent: () => <p className="cw-muted">Loading agents…</p>,
  errorComponent: ({ error }) => (
    <Notice tone="error" title="Could not load agent activity">
      {error instanceof Error ? error.message : String(error)}
    </Notice>
  ),
  component: Agents,
})

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

function Agents() {
  const activity = Route.useLoaderData()
  const sp = Route.useSearch()
  const navigate = useNavigate({ from: '/app/agents' })
  const set = (patch: Partial<typeof sp>) => navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true })
  const agent: AgentKey | null = isAgentKey(sp.agent) ? sp.agent : null
  const actors = [...new Set(activity.map((a) => a.actorKey))].sort()
  const q = (sp.q ?? '').toLowerCase()
  const shown = activity.filter((a) => (!sp.actor || a.actorKey === sp.actor) && (!q || a.action.includes(q) || a.inputSummary.toLowerCase().includes(q) || a.outputSummary.toLowerCase().includes(q)))

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
        <p className="cw-muted">Every agent step, hand-off, search decision and response decision for this organisation. Secrets and personal details are removed before logging.</p>
        <div className="cw-tablewrap" style={{ overflow: 'visible' }}>
          <div className="cw-toolbar" style={{ borderRadius: 'var(--radius-lg) var(--radius-lg) 0 0' }}>
            <label className="cw-search">
              <span className="cw-sr-only">Filter the log</span>
              <input type="search" placeholder="Filter by action or content" value={sp.q ?? ''} onChange={(e) => set({ q: e.target.value || undefined })} />
            </label>
            <label className="cw-inline">
              <span>Actor</span>
              <select value={sp.actor ?? ''} onChange={(e) => set({ actor: e.target.value || undefined })}>
                <option value="">Everyone</option>
                {actors.map((a) => (
                  <option key={a} value={a}>
                    {isAgentKey(a) ? AGENT_LABELS[a].name : a.length > 20 ? `${a.slice(0, 8)}… (person)` : a}
                  </option>
                ))}
              </select>
            </label>
            <span className="cw-toolbar-meta num" role="status">
              {shown.length} of {activity.length} entries
            </span>
            <RefreshButton />
          </div>
          <div style={{ overflowX: 'auto' }} role="region" aria-label="Decision log table" tabIndex={0}>
            {activity.length === 0 ? (
              <p className="cw-empty" style={{ padding: 'var(--space-md)' }}>
                No agent activity yet. Pick an agent in <Link to="/app/chat">chat</Link> to start.
              </p>
            ) : shown.length === 0 ? (
              <p className="cw-empty" style={{ padding: 'var(--space-md)' }}>
                No entries match.
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
                        {a.actorType === 'agent' && isAgentKey(a.actorKey) ? AGENT_LABELS[a.actorKey].name : a.actorType === 'user' ? 'A person' : a.actorType === 'system' ? 'Crosswire' : a.actorKey}
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
        </div>
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
