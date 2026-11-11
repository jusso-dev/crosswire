import { useEffect, useState } from 'react'
import { fetchMemory, promoteMemoryFn, rememberFn, replaceMemoryFn, runCompaction } from '../../fns/agents'
import { AGENT_LABELS, type AgentKey } from '../../shared/agents'
import { plainMessage } from '../../shared/messages'
import { fmtTime, humanise } from '../../components/format'
import { useAction } from '../../components/action'
import { Notice } from '../../components/ui'
import { agentsRoute } from './route'
import { cappedNote } from './helpers'
import { sourceWord } from './ReviewQueue'

type MemoryData = Awaited<ReturnType<typeof fetchMemory>>

/** One agent's notes: read, find, add, promote, replace and compact. The server enforces every rule. */
export function Memory({ agent }: { agent: AgentKey }) {
  const { session } = agentsRoute.useRouteContext()
  const [memory, setMemory] = useState<MemoryData | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const action = useAction()
  const busy = action.busy !== null
  const [note, setNote] = useState('')
  const [kind, setKind] = useState<'fact' | 'safety'>('fact')
  const [replacing, setReplacing] = useState<string | null>(null)
  const [replacement, setReplacement] = useState('')
  const [find, setFind] = useState('')
  const reload = async () => setMemory(await fetchMemory({ data: { agentKey: agent } }))
  useEffect(() => {
    let live = true
    fetchMemory({ data: { agentKey: agent } })
      .then((m) => live && setMemory(m))
      .catch((err) => live && setLoadError(plainMessage(err)))
    return () => {
      live = false
    }
  }, [agent])
  const toggleReplace = (id: string) => {
    setReplacing(replacing === id ? null : id)
    setReplacement('')
  }
  const error = loadError ?? action.error
  return (
    <section className="cw-panel2" aria-labelledby="mem-title" aria-busy={!memory && !loadError}>
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
            aria-busy={action.busy === 'compact' || undefined}
            onClick={async () => {
              const r = await action.run('compact', () => runCompaction({ data: { agentKey: agent } }))
              if (!r) return
              setMsg(`Compacted: ${r.before} → ${r.after} live entries, now version ${r.version}.`)
              await reload().catch(() => {})
            }}
          >
            {action.busy === 'compact' ? 'Compacting…' : 'Compact memory'}
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
              const saved = await action.run('remember', () => rememberFn({ data: { agentKey: agent, body: note, kind } }))
              if (!saved) return
              setNote('')
              setMsg(saved.trust === 'quarantine' ? 'Saved and waiting for review. A different owner or approver must promote it before the agent sees it.' : 'Saved. It can enter the prompt.')
              await reload().catch(() => {})
            }}
          >
            <label>
              Note
              <span className="cw-help">A note for this agent. It waits in the review queue until a different owner or approver promotes it. Forbidden text is refused, and text that looks like an instruction override can never be promoted.</span>
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
              <button className="cw-btn" type="submit" data-size="sm" disabled={busy || !note.trim()} aria-busy={action.busy === 'remember' || undefined}>
                {action.busy === 'remember' ? 'Saving…' : 'Save note'}
              </button>
            </div>
          </form>
        </details>
        {!memory && !loadError && <p className="cw-muted">Loading memory…</p>}
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
                            aria-busy={action.busy === `promote:${entry.id}` || undefined}
                            onClick={async () => {
                              const r = await action.run(`promote:${entry.id}`, () => promoteMemoryFn({ data: { entryId: entry.id } }))
                              if (!r) return
                              setMsg('Promoted. A different person approved it for the prompt.')
                              await reload().catch(() => {})
                            }}
                          >
                            {action.busy === `promote:${entry.id}` ? 'Promoting…' : 'Promote'}
                          </button>
                        ) : (
                          session.canApprove && (
                            <button type="button" className="cw-btn" data-variant="ghost" data-size="sm" onClick={() => toggleReplace(entry.id)}>
                              Replace
                            </button>
                          )
                        )}
                        {session.canApprove && replacing === entry.id && (
                          <form
                            className="cw-form"
                            onSubmit={async (ev) => {
                              ev.preventDefault()
                              const r = await action.run(`replace:${entry.id}`, () => replaceMemoryFn({ data: { entryId: entry.id, body: replacement } }))
                              if (!r) return
                              setReplacing(null)
                              setReplacement('')
                              setMsg('Replaced. The old note is tombstoned and stays out of the prompt.')
                              await reload().catch(() => {})
                            }}
                          >
                            <label>
                              Replacement
                              <textarea value={replacement} onChange={(ev) => setReplacement(ev.target.value)} rows={2} maxLength={2000} required />
                            </label>
                            <button className="cw-btn" type="submit" data-size="sm" disabled={busy || !replacement.trim()} aria-busy={action.busy === `replace:${entry.id}` || undefined}>
                              {action.busy === `replace:${entry.id}` ? 'Working…' : 'Tombstone old note'}
                            </button>
                          </form>
                        )}
                        <details>
                          <summary>Details</summary>
                          <p className="cw-muted">
                            Kind {humanise(entry.kind)}. Trust {humanise(entry.trust)}. Class {entry.sdkClass ?? 'none'}. Source {sourceWord(entry.sourceType)}. Added {fmtTime(entry.createdAt)}
                            {entry.authorLabel ? ` by ${entry.authorLabel}` : ''}.
                          </p>
                          {canPromote && (
                            <button type="button" className="cw-linkbtn" onClick={() => toggleReplace(entry.id)}>
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
            {memory.hasMore && <p className="cw-help">{cappedNote(memory.entries.length, true, 'notes')} The history.md export below has every note.</p>}
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
