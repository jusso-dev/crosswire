import { useRouter } from '@tanstack/react-router'
import { approveKqlFn, rejectKqlFn } from '../../fns/hunts'
import { fmtTime, plural } from '../../components/format'
import { Notice, Term } from '../../components/ui'
import { useAction } from '../../components/action'
import { plainMessage } from '../../shared/messages'
import { Freshness, ModeTag, StatusTag, TARGET_LABEL } from '../../components/signals'
import { FilterChips, Inspector, ResultGrid, kqlIdentifier, kqlLiteral, type Filter, type Row, type Sort } from '../../components/results'
import { approvalBlock, expiredSampleText, type ApprovalContext, type Proposal, type Summary } from './model'
import { editedBeforeApproval, personName, proposerText } from './helpers'

type People = Readonly<Record<string, string>>

export function SearchPanel({
  p,
  kql,
  onKql,
  people,
  summary,
  runAt,
  onShowOriginal,
  ordered,
  filters,
  sort,
  row,
  onRow,
  onSort,
  onFilters,
  onDraft,
  approval,
}: {
  p: Proposal
  /** The query this panel shows. Owned by the workspace so "Approve all" sends the same text (#123). */
  kql: string
  onKql: (kql: string) => void
  people: People
  summary: Summary | null
  runAt?: string
  onShowOriginal?: () => void
  ordered: Array<{ row: Row; index: number }>
  filters: Filter[]
  sort: Sort
  row: number | null
  onRow: (row: number | null) => void
  onSort: (s: Sort) => void
  onFilters: (f: Filter[]) => void
  onDraft: (kql: string) => void
  approval: ApprovalContext
}) {
  const router = useRouter()
  const { run, busy, error } = useAction()
  const s = summary
  const pending = p.status === 'proposed'
  const edited = pending && kql.trim() !== p.originalKql.trim()
  const changed = pending && kql.trim() !== p.kql.trim()
  const blocked = pending ? approvalBlock(approval, p, changed) : null
  const visible = ordered

  const approve = () =>
    run('approve', async () => {
      const r = await approveKqlFn({ data: { proposalId: p.id, kql } })
      await router.invalidate()
      return r
    })
  const reject = () =>
    run('reject', async () => {
      const r = await rejectKqlFn({ data: { proposalId: p.id } })
      await router.invalidate()
      return r
    })

  return (
    <section className="cw-panel2" aria-labelledby="search-title">
      <div className="cw-panel2-head">
        <h2 id="search-title">{pending ? 'Review this search' : runAt ? 'Repeat search run' : 'Search'}</h2>
        <StatusTag status={p.status} />
        <span className="cw-muted">{TARGET_LABEL[p.target]}</span>
        {s?.mode && <ModeTag mode={s.mode} />}
        {!pending && editedBeforeApproval(p) && (
          <span className="cw-badge" data-tone="warn">
            Edited before approval
          </span>
        )}
        <span className="cw-row cw-ml-auto" data-center>
          {!pending && (
            <button type="button" className="cw-btn" data-variant="ghost" data-size="sm" onClick={() => onDraft(p.kql)}>
              Edit as new search
            </button>
          )}
        </span>
      </div>
      <div className="cw-panel2-body">
        {p.rationale && <p className="cw-mb-xs">{p.rationale}</p>}
        {pending ? (
          <>
            <p className="cw-muted">
              Nothing has run yet. Read the <Term k="kql">KQL</Term>, change it if needed, then approve to run it once. What you approve is exactly what runs.
            </p>
            <div className="cw-editor">
              <label className="cw-sr-only" htmlFor={`kql-${p.id}`}>
                Query to approve
              </label>
              <textarea id={`kql-${p.id}`} className="mono" rows={Math.min(10, Math.max(3, kql.split('\n').length + 1))} value={kql} onChange={(e) => onKql(e.target.value)} spellCheck={false} />
              <div className="cw-editor-bar">
                <span>{edited ? 'Edited from the proposal. The edited query is what will run.' : 'Unchanged from the proposal.'}</span>
                {edited && (
                  <button type="button" className="cw-linkbtn" onClick={() => onKql(p.originalKql)}>
                    Restore original
                  </button>
                )}
              </div>
            </div>
            {/* Always present, so the reason is announced when an edit blocks approval (#167). */}
            <div role="status">
              {blocked && (
                <Notice tone="info">
                  {blocked}
                  {approval.policy === 'second-person' && approval.canApprove && changed && (
                    <>
                      {' '}
                      <button type="button" className="cw-linkbtn" onClick={() => onDraft(kql)}>
                        Propose the edit as a new search
                      </button>
                    </>
                  )}
                </Notice>
              )}
            </div>
            {error && (
              <Notice tone="error" title="That step did not complete">
                {error}
              </Notice>
            )}
            <div className="cw-row cw-mt-sm">
              <button
                type="button"
                className="cw-btn"
                disabled={busy !== null || !kql.trim() || blocked !== null}
                title={blocked ?? undefined}
                data-state={busy === 'approve' ? 'loading' : undefined}
                aria-busy={busy === 'approve' || undefined}
                onClick={approve}
              >
                {busy === 'approve' ? 'Running…' : 'Approve and run'}
              </button>
              <button type="button" className="cw-btn" data-variant="ghost" disabled={busy !== null} aria-busy={busy === 'reject' || undefined} onClick={reject}>
                {busy === 'reject' ? 'Working…' : 'Reject'}
              </button>
              <span className="cw-muted">Expires {fmtTime(p.expiresAt)}</span>
            </div>
          </>
        ) : (
          <>
            <pre aria-label="Query that ran">{p.kql}</pre>
            {editedBeforeApproval(p) && (
              <details className="cw-mt-sm">
                <summary>Show the query as first proposed</summary>
                <pre aria-label="Query as first proposed">{p.originalKql}</pre>
              </details>
            )}
          </>
        )}
        {p.error && (
          <Notice tone="error" title={p.status === 'failed' ? 'The search failed' : undefined}>
            {plainMessage(p.error)}
          </Notice>
        )}
        {p.status === 'expired' && <Notice tone="warn">This proposal expired before anyone approved it. Use “Edit as new search” to propose it again.</Notice>}
        {p.status === 'rejected' && <p className="cw-muted">Rejected by {personName(people, p.decidedBy)}. It did not run.</p>}
      </div>

      {runAt && (
        <div className="cw-panel2-foot cw-bt0">
          <span>
            Showing the sample from the repeat run at {fmtTime(runAt)}.{' '}
            <button type="button" className="cw-linkbtn" onClick={onShowOriginal}>
              Show the original run
            </button>
          </span>
        </div>
      )}
      {p.status === 'run' && s && (
        <>
          <div className="cw-panel2-foot cw-bt0 cw-bb">
            <dl className="cw-runstats">
              <div>
                <dt>Rows returned</dt>
                <dd className="num">
                  {s.rowCount ?? 'not recorded'}
                  {s.truncated ? ' (capped by row limit)' : ''}
                </dd>
              </div>
              <div>
                <dt>Stored sample</dt>
                <dd className="num">{s.sampleExpired ? 'removed (retention)' : plural(s.sample?.length ?? 0, 'row')}</dd>
              </div>
              <div>
                <dt>Ran</dt>
                <dd>{p.ranAt ? <Freshness at={p.ranAt} /> : 'not recorded'}</dd>
              </div>
              <div>
                <dt>Duration</dt>
                <dd className="num">{s.durationMs !== undefined ? `${s.durationMs} ms` : 'not recorded'}</dd>
              </div>
              {approval.policy === 'second-person' && (
                <div>
                  <dt>Proposed by</dt>
                  <dd>{proposerText(people, p)}</dd>
                </div>
              )}
              <div>
                <dt>Approved by</dt>
                <dd>{p.decidedBy ? `${personName(people, p.decidedBy)}${p.decidedAt ? `, ${fmtTime(p.decidedAt)}` : ''}` : 'not recorded'}</dd>
              </div>
            </dl>
          </div>
          <div className="cw-panel2-body">
            {s.sampleExpired ? (
              <p className="cw-empty">{expiredSampleText(s)}</p>
            ) : !s.sample?.length ? (
              <p className="cw-empty">{s.rowCount === 0 ? 'The search ran and returned no rows. That is a result: nothing matched in the queried time range.' : 'Rows were returned but no sample was stored, so there is nothing to inspect here.'}</p>
            ) : (
              <>
                {(s.rowCount ?? 0) > s.sample.length && (
                  <Notice tone="info">
                    Showing a stored sample of {s.sample.length} of {s.rowCount} rows. Filters and sorting apply to this sample only. To see more, refine the search and run it again.
                  </Notice>
                )}
                <FilterChips filters={filters} onRemove={(i) => onFilters(filters.filter((_, j) => j !== i))} onClear={() => onFilters([])} />
                {visible.length === 0 ? (
                  <p className="cw-empty">No rows in the sample match these filters. Remove a filter to see rows again.</p>
                ) : (
                  <ResultGrid
                    columns={s.columns ?? Object.keys(s.sample[0] ?? {})}
                    rows={visible}
                    selected={row}
                    onSelect={onRow}
                    sort={sort}
                    onSort={onSort}
                    caption={`${visible.length} of ${s.sample.length} sample rows${filters.length ? ' match the filters' : ''}`}
                  />
                )}
              </>
            )}
          </div>
        </>
      )}
    </section>
  )
}

export function RowInspector({
  p,
  people,
  summary,
  rowIndex,
  ordered,
  filters,
  onRow,
  onClose,
  onFilters,
  onDraft,
}: {
  p: Proposal
  people: People
  summary: Summary
  rowIndex: number
  ordered: Array<{ row: Row; index: number }>
  filters: Filter[]
  onRow: (row: number) => void
  onClose: () => void
  onFilters: (f: Filter[]) => void
  onDraft: (kql: string) => void
}) {
  const sample = summary.sample ?? []
  const visible = ordered.map((r) => r.index)
  const pos = visible.indexOf(rowIndex)
  const columns = summary.columns ?? Object.keys(sample[0] ?? {})
  return (
    <Inspector
      title={`Row ${rowIndex + 1}`}
      position={pos >= 0 ? `${pos + 1} of ${visible.length}` : ''}
      row={sample[rowIndex]!}
      columns={columns}
      onClose={onClose}
      onPrev={pos > 0 ? () => onRow(visible[pos - 1]!) : undefined}
      onNext={pos >= 0 && pos < visible.length - 1 ? () => onRow(visible[pos + 1]!) : undefined}
      onFilter={(col, op, value) => onFilters([...filters, { col, op, value }])}
      onAddToSearch={(col, value) => onDraft(`${p.kql.replace(/\s*\|\s*take\s+\d+\s*$/i, '')}\n| where ${kqlIdentifier(col)} == ${kqlLiteral(value)}\n| take 100`)}
      provenance={
        <dl className="cw-provenance">
          <dt>Source</dt>
          <dd>{TARGET_LABEL[p.target]}</dd>
          <dt>Data</dt>
          <dd>
            <ModeTag mode={summary.mode} />
          </dd>
          <dt>Ran</dt>
          <dd>{p.ranAt ? fmtTime(p.ranAt) : 'not recorded'}</dd>
          <dt>Proposed by</dt>
          <dd>{proposerText(people, p)}</dd>
          <dt>Approved by</dt>
          <dd>{p.decidedBy ? personName(people, p.decidedBy) : 'not recorded'}</dd>
          <dt>Query</dt>
          <dd>
            <pre className="cw-m0">{p.kql}</pre>
          </dd>
        </dl>
      }
    />
  )
}
