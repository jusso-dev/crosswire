import { useMemo } from 'react'
import { useRouter } from '@tanstack/react-router'
import { addNote } from '../../fns/hunts'
import { fmtTimeExact, plural } from '../../components/format'
import { Notice } from '../../components/ui'
import { useAction } from '../../components/action'
import { plainMessage } from '../../shared/messages'
import { summariseEntities } from '../../components/results'
import { expiredSampleText, type Data, type Summary } from './model'
import { personName } from './helpers'

export function Entities({ summary, onFilter }: { summary: Summary | null; onFilter: (col: string, value: string) => void }) {
  const s = summary
  const { groups, timeCol } = useMemo(() => summariseEntities(s?.columns ?? Object.keys(s?.sample?.[0] ?? {}), s?.sample ?? []), [s])
  return (
    <section className="cw-rail-section" aria-labelledby="entities-title">
      <h2 id="entities-title">Entities in this result</h2>
      {s?.sampleExpired ? (
        <p className="cw-empty">{expiredSampleText(s)}</p>
      ) : !s?.sample?.length ? (
        <p className="cw-empty">Run a search to see the devices, accounts and URLs it returned.</p>
      ) : groups.length === 0 ? (
        <p className="cw-empty">No device, account, file or network columns in this result.</p>
      ) : (
        <>
          <p className="cw-muted">Counted within the {s.sample.length}-row sample. Select a value to filter the results.</p>
          <div className="cw-entities">
            {groups.map((g) => (
              <div className="cw-entity" key={g.column}>
                <h3>
                  {g.kind} <span className="mono">({g.column})</span>
                </h3>
                <ul>
                  {g.values.map((v) => (
                    <li key={v.value}>
                      <button type="button" onClick={() => onFilter(g.column, v.value)} title={timeCol && v.first ? `${timeCol}: first ${v.first}, last ${v.last}` : v.value}>
                        {v.value}
                      </button>
                      <span>{v.count}×</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  )
}

const TL_TYPES: Record<string, Array<string>> = {
  searches: ['kql_proposed', 'kql_approved', 'kql_rejected'],
  results: ['kql_result', 'kql_failed', 'scheduled_result', 'scheduled_failed'],
  notes: ['note'],
  schedules: ['schedule_created', 'schedule_disabled', 'scheduled_result', 'scheduled_failed'],
}
const EVIDENCE_LABEL: Record<string, string> = {
  note: 'Note',
  kql_proposed: 'Search proposed',
  kql_approved: 'Search approved',
  kql_rejected: 'Search rejected',
  kql_result: 'Search results',
  kql_failed: 'Search failed',
  schedule_created: 'Repeat search scheduled',
  schedule_disabled: 'Repeat search paused',
  scheduled_result: 'Repeat search results',
  scheduled_failed: 'Repeat search failed',
  incidents: 'Incidents checked',
  response_proposed: 'Action proposed',
}

export type TimelineFilter = 'all' | 'searches' | 'results' | 'notes' | 'schedules'

export function Timeline({
  data,
  filter,
  onFilter,
  onOpen,
  onOpenRun,
}: {
  data: Data
  filter: string
  onFilter: (f: TimelineFilter) => void
  onOpen: (q: string) => void
  onOpenRun: (eventId: string, proposalId: string) => void
}) {
  // A schedule is created from one proposal, so its runs map back to that search.
  const scheduleSource = new Map<string, string>()
  for (const e of data.evidence) {
    const pl = e.payload as Record<string, unknown>
    if (e.type === 'schedule_created' && typeof pl.scheduleId === 'string' && typeof pl.proposalId === 'string') scheduleSource.set(pl.scheduleId, pl.proposalId)
  }
  const items = [...data.evidence].reverse().filter((e) => filter === 'all' || TL_TYPES[filter]?.includes(e.type))
  return (
    <section className="cw-rail-section" aria-labelledby="timeline-title">
      <h2 id="timeline-title">Evidence timeline</h2>
      <div className="cw-segmented cw-mb-sm cw-wrap" role="group" aria-label="Show in timeline">
        {(['all', 'searches', 'results', 'notes', 'schedules'] as const).map((k) => (
          <button key={k} type="button" aria-pressed={filter === k} onClick={() => onFilter(k)}>
            {k === 'all' ? 'All' : k[0]!.toUpperCase() + k.slice(1)}
          </button>
        ))}
      </div>
      {items.length === 0 ? (
        <p className="cw-empty">Nothing here yet.</p>
      ) : (
        <ol className="cw-timeline" aria-label="Newest first">
          {items.map((e) => {
            const pl = e.payload as Record<string, unknown>
            const runOf = e.type === 'scheduled_result' && typeof pl.scheduleId === 'string' ? scheduleSource.get(pl.scheduleId) : undefined
            const proposalId = typeof pl.proposalId === 'string' ? pl.proposalId : null
            const kind = e.type.endsWith('result') ? 'result' : e.type.endsWith('failed') ? 'failed' : e.type === 'note' ? 'note' : undefined
            const label = EVIDENCE_LABEL[e.type] ?? e.type.replace(/_/g, ' ')
            return (
              <li key={e.id} data-kind={kind}>
                {runOf && Array.isArray(pl.sample) ? (
                  <button type="button" className="cw-tl-btn" onClick={() => onOpenRun(e.id, runOf)}>
                    {label}
                  </button>
                ) : proposalId ? (
                  <button type="button" className="cw-tl-btn" onClick={() => onOpen(proposalId)}>
                    {label}
                  </button>
                ) : (
                  <span className="cw-ev-label">{label}</span>
                )}
                <span className="cw-tl-time">
                  <time dateTime={e.createdAt}>{fmtTimeExact(e.createdAt)}</time> · {e.actorType === 'agent' ? (e.actorId ?? 'agent') : e.actorType === 'user' ? personName(data.people, e.actorId) : 'Crosswire'}
                </span>
                {typeof pl.note === 'string' && <p>{pl.note}</p>}
                {typeof pl.rowCount === 'number' && (
                  <p className="cw-muted">
                    {plural(pl.rowCount, 'row')} · {pl.mode === 'demo' ? 'demo data' : 'live data'}
                    {typeof pl.previousRowCount === 'number' ? ` (was ${pl.previousRowCount})` : ''}
                  </p>
                )}
                {typeof pl.error === 'string' && <p className="cw-muted">{plainMessage(pl.error)}</p>}
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}

export function NoteForm({ huntId, note, setNote }: { huntId: string; note: string; setNote: (n: string) => void }) {
  const router = useRouter()
  const { run, busy, error } = useAction()
  return (
    <section className="cw-rail-section">
      <form
        className="cw-form"
        onSubmit={(e) => {
          e.preventDefault()
          void run('note', async () => {
            await addNote({ data: { huntId, note } })
            setNote('')
            await router.invalidate()
          })
        }}
      >
        <label>
          Add a note
          <span className="cw-help">What you found, what you ruled out, or what to check next.</span>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} required maxLength={4000} />
        </label>
        {error && (
          <Notice tone="error" title="Note not saved">
            {error}
          </Notice>
        )}
        <div>
          <button className="cw-btn" data-variant="ghost" type="submit" disabled={busy !== null || !note.trim()} aria-busy={busy !== null || undefined}>
            {busy ? 'Saving…' : 'Add note'}
          </button>
        </div>
      </form>
    </section>
  )
}
