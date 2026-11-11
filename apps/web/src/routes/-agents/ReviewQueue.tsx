import { useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { fetchReviewQueue, promoteMemoryFn } from '../../fns/agents'
import { fmtTime, humanise } from '../../components/format'
import { useAction } from '../../components/action'
import { EmptyState, Notice } from '../../components/ui'
import { agentLabel } from '../../components/runs'
import { agentsRoute } from './route'
import { cappedNote } from './helpers'

type Queue = Awaited<ReturnType<typeof fetchReviewQueue>>

/** Held notes waiting for a second person to promote them. Paged with "Load older" (#171). */
export function ReviewQueue({ queue }: { queue: Queue }) {
  const router = useRouter()
  const { session } = agentsRoute.useRouteContext()
  const promote = useAction()
  const more = useAction()
  const [msg, setMsg] = useState<string | null>(null)
  const [older, setOlder] = useState<{ entries: Queue['entries']; hasMore: boolean } | null>(null)
  const entries = older ? [...queue.entries, ...older.entries.filter((o) => !queue.entries.some((e) => e.id === o.id))] : queue.entries
  const canLoadMore = older ? older.hasMore : queue.hasMore
  const loadOlder = () =>
    void more.run('older', async () => {
      const oldest = entries.at(-1)?.createdAt
      if (!oldest) return
      const page = await fetchReviewQueue({ data: { before: oldest } })
      setOlder((prev) => ({ entries: [...(prev?.entries ?? []), ...page.entries], hasMore: page.hasMore }))
    })
  return (
    <section aria-labelledby="review-title">
      <h2 id="review-title" className="cw-h2-compact">
        Held for review <span className="cw-muted num">({queue.total})</span>
      </h2>
      <p className="cw-muted cw-measure">
        Notes from chat, tools, imports and feedback start out held. They stay out of every agent prompt until an owner or approver who did not write them promotes them. Leave a note held and it stays in the record, unused.
      </p>
      <div role="status">
        {msg && (
          <Notice tone="ok" title="Promoted">
            {msg}
          </Notice>
        )}
      </div>
      {promote.error && (
        <Notice tone="error" title="Not promoted">
          {promote.error}
        </Notice>
      )}
      {!session.canApprove && <Notice tone="info">Only owners and approvers can promote notes. You can read the queue.</Notice>}
      {entries.length === 0 ? (
        <EmptyState title="Nothing waiting" body="No notes are held. New notes from chat or feedback will appear here for a second person to check." />
      ) : (
        <ul className="cw-inbox">
          {entries.map((entry) => (
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
                    <dd>{sourceWord(entry.sourceType)}</dd>
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
                    disabled={promote.busy !== null}
                    aria-busy={promote.busy === entry.id || undefined}
                    onClick={async () => {
                      setMsg(null)
                      const r = await promote.run(entry.id, () => promoteMemoryFn({ data: { entryId: entry.id } }))
                      if (!r) return
                      setMsg(`${agentLabel(entry.agentKey)} will read this note from its next reply.`)
                      setOlder(null)
                      await router.invalidate().catch(() => {})
                    }}
                  >
                    {promote.busy === entry.id ? 'Promoting…' : `Promote to ${agentLabel(entry.agentKey)}`}
                  </button>
                )}
                <span className="cw-help">Leave it held to keep it out of the prompt.</span>
              </div>
            </li>
          ))}
        </ul>
      )}
      {canLoadMore && (
        <div className="cw-panel2-foot">
          <span className="cw-muted">{cappedNote(entries.length, true, 'held notes', queue.total)}</span>
          <button type="button" className="cw-btn" data-variant="ghost" data-size="sm" disabled={more.busy !== null} onClick={loadOlder}>
            {more.busy ? 'Loading…' : 'Load older notes'}
          </button>
          {more.error && (
            <span className="cw-field-error" role="alert">
              {more.error}
            </span>
          )}
        </div>
      )}
    </section>
  )
}

export const SOURCE_WORD: Record<string, string> = {
  thread: 'Chat',
  message: 'Chat message',
  import: 'Import',
  remember: 'Agent "remember"',
  tool: 'Tool output',
  feedback: 'Reply feedback',
  scribe: 'Scribe note',
  operator: 'Operator note',
}

export function sourceWord(source: string | null | undefined) {
  if (!source) return 'Not recorded'
  return SOURCE_WORD[source] ?? humanise(source)
}
