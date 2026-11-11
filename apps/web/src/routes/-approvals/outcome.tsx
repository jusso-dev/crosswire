import { fmtTimeExact } from '../../components/format'
import { ModeTag } from '../../components/signals'
import { Notice } from '../../components/ui'
import { statusWord } from '../../shared/labels'
import { executionState, outcomeTone } from './execution-text'

type Call = { method: string; url: string; target?: { kind: string; id: string }; body?: unknown }
type Result = { url: string; ok: boolean; status: number | null; error?: string; target?: { kind: string; id: string } }
export type OutcomeRecord = { mode?: string; status?: string; calls?: Call[]; blocked?: string[]; results?: Result[]; error?: string; at?: string; by?: string }

/** A dry run or an execution: the calls, their results and the raw record. */
export function Outcome({ id, title, intro, outcome }: { id: string; title: string; intro: string; outcome: OutcomeRecord }) {
  // Results are recorded in call order, so match by position (URLs can repeat).
  const results = outcome.results ?? []
  const state = executionState(outcome)
  const inProgress = state === 'in_progress'
  // Nothing about the calls is known for these, so the call table would only mislead.
  const noCallRecord = inProgress || state === 'outcome_unknown'
  return (
    <section className="cw-panel2" aria-labelledby={id}>
      <div className="cw-panel2-head">
        <h2 id={id}>{title}</h2>
        {/* Only an explicit mode gets a mode tag. A record with no mode never reads "Dry run". */}
        {outcome.mode === 'live' || outcome.mode === 'dry-run' ? (
          <ModeTag mode={outcome.mode} />
        ) : (
          <span className="cw-badge" data-tone="warn">
            Mode not recorded
          </span>
        )}
        {outcome.status && (
          <span className="cw-badge" data-tone={outcomeTone(outcome.status)}>
            {statusWord(outcome.status)}
          </span>
        )}
        {outcome.at && <span className="cw-muted">{fmtTimeExact(outcome.at)}</span>}
      </div>
      <div className="cw-panel2-body">
        {inProgress ? (
          <Notice tone="warn" title="Result not recorded yet">
            {intro} Calls may already have reached your tenant. Do not start this again. If no result appears within 10 minutes, Crosswire marks the outcome as unknown.
          </Notice>
        ) : (
          <p className="cw-muted">{intro}</p>
        )}
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
        {noCallRecord ? null : outcome.calls && outcome.calls.length > 0 ? (
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
