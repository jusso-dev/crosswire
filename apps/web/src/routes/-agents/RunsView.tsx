import { Link, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { fetchRuns, type fetchRunDetail } from '../../fns/agents'
import { AGENT_KEYS, AGENT_LABELS } from '../../shared/agents'
import { plainMessage } from '../../shared/messages'
import { fmtTime, fmtTimeExact, plural } from '../../components/format'
import { useAction } from '../../components/action'
import { EmptyState, Notice, TableWrap } from '../../components/ui'
import { RunStatusTag, RunTree, StopRunButton, agentLabel, eventLabel, fmtCost, fmtDuration, fmtTokens, outputLabel, useRunStatusPoll } from '../../components/runs'
import { listKeys } from '../../components/keys'
import { agentsRoute, useSetSearch } from './route'
import { cappedNote } from './helpers'

type RunsData = Awaited<ReturnType<typeof fetchRuns>>
type RunDetail = NonNullable<Awaited<ReturnType<typeof fetchRunDetail>>>

/** The run timeline with filters, live status, paging and the run panel. */
export function RunsView({ runs, hasMore, rateSet, detail }: { runs: RunsData['runs']; hasMore: boolean; rateSet: boolean; detail: RunDetail | null }) {
  const sp = agentsRoute.useSearch()
  const router = useRouter()
  const set = useSetSearch()
  // While something runs, poll only the live runs' status (one small request), and reload the
  // page data once when one changes. Polling pauses while the tab is hidden (#170).
  const known: Record<string, string> = {}
  for (const r of runs) if (r.status === 'running') known[r.id] = r.status
  if (detail?.run.status === 'running') known[detail.run.id] = detail.run.status
  const live = Object.keys(known).length > 0
  useRunStatusPoll(known, () => void router.invalidate({ filter: (m) => m.routeId === '/app/agents' || m.routeId === '/app' }))
  // "Load older" keeps the newest page from the loader and appends older pages below it (#171).
  // The page keys this view on its filters, so older pages reset when a filter changes.
  const [older, setOlder] = useState<{ runs: RunsData['runs']; hasMore: boolean } | null>(null)
  const more = useAction()
  const shown = older ? [...runs, ...older.runs.filter((o) => !runs.some((r) => r.id === o.id))] : runs
  const canLoadMore = older ? older.hasMore : hasMore
  const loadOlder = () =>
    void more.run('older', async () => {
      const oldest = shown.at(-1)?.startedAt
      if (!oldest) return
      const page = await fetchRuns({ data: { status: sp.rstatus, agentKey: sp.ragent, before: oldest } })
      setOlder((prev) => ({ runs: [...(prev?.runs ?? []), ...page.runs], hasMore: page.hasMore }))
    })
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
            {plural(shown.length, 'run')}{canLoadMore ? ', older ones not shown' : ''}{live ? ', updating live' : ''}
          </span>
        </div>
        {shown.length === 0 ? (
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
                {shown.map((r) => (
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
        {canLoadMore && (
          <div className="cw-panel2-foot">
            <span className="cw-muted">{cappedNote(shown.length, true, 'runs')}</span>
            <button type="button" className="cw-btn" data-variant="ghost" data-size="sm" disabled={more.busy !== null} onClick={loadOlder}>
              {more.busy ? 'Loading…' : 'Load older runs'}
            </button>
            {more.error && (
              <span className="cw-field-error" role="alert">
                {more.error}
              </span>
            )}
          </div>
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

export function RunPanel({ detail, rateSet, onClose }: { detail: RunDetail; rateSet: boolean; onClose: () => void }) {
  const { run, parent, children, events, outputs, skill } = detail
  return (
    <section className="cw-panel2 cw-runpanel" aria-labelledby="run-title">
      <div className="cw-panel2-head">
        <h2 id="run-title">
          {agentLabel(run.agentKey)} run
        </h2>
        <RunStatusTag status={run.status} />
        <span className="cw-spacer" />
        {run.status === 'running' && <StopRunButton key={run.id} runId={run.id} target={`the ${agentLabel(run.agentKey)} run`} />}
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
            <time dateTime={run.startedAt}>{fmtTimeExact(run.startedAt)}</time>
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
              <span className="cw-ev-label">{eventLabel(e.kind)}</span>
              <span className="cw-tl-time">
                <span className="num">#{e.seq}</span> · <time dateTime={e.createdAt}>{fmtTimeExact(e.createdAt)}</time>
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
                {outputLabel(o.kind)} <span className="cw-muted">· {fmtTimeExact(o.createdAt)}</span>
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
