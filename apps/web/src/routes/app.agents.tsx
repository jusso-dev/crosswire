import { Link, createFileRoute, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { fetchActivity, fetchMemory, runCompaction } from '../fns/agents'
import { AGENT_KEYS, AGENT_LABELS, type AgentKey } from '../shared/agents'
import { fmtTime } from '../components/format'

export const Route = createFileRoute('/app/agents')({
  loader: () => fetchActivity(),
  component: Agents,
})

function Agents() {
  const activity = Route.useLoaderData()
  const router = useRouter()
  const { session } = Route.useRouteContext()
  const [agent, setAgent] = useState<AgentKey>('lead')
  const [memory, setMemory] = useState<Awaited<ReturnType<typeof fetchMemory>> | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  const load = async (k: AgentKey) => {
    setAgent(k)
    setMemory(await fetchMemory({ data: { agentKey: k } }))
  }

  return (
    <>
      <h1>Agents</h1>
      <div className="cw-grid">
        {AGENT_KEYS.map((k) => (
          <section className="cw-card" key={k}>
            <h3>{AGENT_LABELS[k].name}</h3>
            <p className="cw-muted">{AGENT_LABELS[k].role}</p>
            <div className="cw-row">
              <button className="cw-btn" data-variant="ghost" onClick={() => load(k)}>
                View memory
              </button>
              <Link to="/app/chat">Chat</Link>
            </div>
          </section>
        ))}
      </div>

      {memory && (
        <>
          <h2>
            {AGENT_LABELS[agent].name} memory (v{memory.version})
          </h2>
          {session.canApprove && (
            <p>
              <button
                className="cw-btn"
                data-variant="ghost"
                onClick={async () => {
                  const r = await runCompaction({ data: { agentKey: agent } })
                  setMsg(`Compacted: ${r.before} → ${r.after} live entries, now v${r.version}.`)
                  await load(agent)
                }}
              >
                Compact memory
              </button>{' '}
              {msg && <span className="cw-muted">{msg}</span>}
            </p>
          )}
          {memory.body && <pre>{memory.body}</pre>}
          {memory.entries.length === 0 ? (
            <p className="cw-empty">No live entries.</p>
          ) : (
            <ul>
              {memory.entries.map((e) => (
                <li key={e.id}>
                  <span className="cw-badge">{e.kind}</span> {e.body} {e.redacted && <span className="cw-badge" data-tone="warn">redacted</span>}{' '}
                  <span className="cw-muted">{fmtTime(e.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
          <details>
            <summary>history.md export</summary>
            <pre>{memory.markdown}</pre>
          </details>
        </>
      )}

      <h2>Decision log</h2>
      <p className="cw-muted">Every agent tool call, delegation, KQL decision and response decision is logged here (org-scoped, redacted).</p>
      {activity.length === 0 ? (
        <p className="cw-empty">No agent activity yet.</p>
      ) : (
        <table className="cw-table">
          <thead>
            <tr>
              <th>When</th>
              <th>Actor</th>
              <th>Action</th>
              <th>Input</th>
              <th>Output</th>
            </tr>
          </thead>
          <tbody>
            {activity.map((a) => (
              <tr key={a.id}>
                <td>{fmtTime(a.createdAt)}</td>
                <td>
                  {a.actorType}: {a.actorKey}
                </td>
                <td>{a.action}</td>
                <td>
                  <code>{a.inputSummary.slice(0, 200)}</code>
                </td>
                <td>
                  <code>{a.outputSummary.slice(0, 200)}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p>
        <button className="cw-btn" data-variant="ghost" onClick={() => router.invalidate()}>
          Refresh
        </button>
      </p>
    </>
  )
}
