import { Link } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import type { fetchActivity } from '../../fns/agents'
import { AGENT_LABELS, isAgentKey } from '../../shared/agents'
import { fmtTime, humanise } from '../../components/format'
import { RefreshButton } from './RefreshButton'
import { agentsRoute, useSetSearch } from './route'
import { syncSearchText } from './helpers'

/** Plain words for decision log actions. The log search also matches these words. */
export const ACTION_WORDS: Record<string, string> = {
  propose_kql: 'Proposed a search',
  run_kql: 'Approved and ran a search',
  run_kql_failed: 'Search failed',
  reject_kql: 'Rejected a search',
  schedule_kql: 'Scheduled a repeat search',
  scheduled_kql: 'Ran a repeat search',
  propose_response: 'Proposed an action',
  delegate: 'Handed work to another agent',
}

/** The decision log: every agent step, searchable over the whole log on the server, paged with a cursor. */
export function DecisionLog({ rows: activity, hasMore, actors }: { rows: Awaited<ReturnType<typeof fetchActivity>>['rows']; hasMore: boolean; actors: Awaited<ReturnType<typeof fetchActivity>>['actors'] }) {
  const sp = agentsRoute.useSearch()
  const set = useSetSearch()
  const url = sp.q ?? ''
  const [q, setQ] = useState(url)
  // Follow the URL when it changes from outside (Back, Forward, a palette link). Our own debounced
  // write is remembered, so it does not overwrite what the person is still typing (#174).
  const [prevUrl, setPrevUrl] = useState(url)
  const [written, setWritten] = useState<string | null>(null)
  if (url !== prevUrl) {
    setPrevUrl(url)
    setQ(syncSearchText({ local: q, prevUrl, url, written }))
  }
  // Debounce typing into the URL, which re-queries the server over the whole log.
  useEffect(() => {
    if (url === q) return
    const t = setTimeout(() => {
      setWritten(q)
      void set({ q: q || undefined, before: undefined })
    }, 300)
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
                      {ACTION_WORDS[a.action] ?? humanise(a.action)}
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
