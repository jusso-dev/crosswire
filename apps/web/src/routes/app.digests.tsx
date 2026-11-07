import { Link, createFileRoute } from '@tanstack/react-router'
import { fetchDigests } from '../fns/watches'
import { fmtTime, getDisplayTimeZone } from '../components/format'
import { Notice, PageHead } from '../components/ui'

/** Daily digests: one per local day. Each day is a section with its hits as a compact list. */
export const Route = createFileRoute('/app/digests')({
  loader: () => fetchDigests(),
  pendingComponent: () => <p className="cw-muted">Loading digests…</p>,
  errorComponent: ({ error }) => (
    <Notice tone="error" title="Could not load digests">
      {error instanceof Error ? error.message : String(error)}
    </Notice>
  ),
  component: Digests,
})

const SOURCE_LABEL: Record<string, string> = { 'pwn.watch': 'pwn.watch', 'cisa-kev': 'CISA KEV' }

function dayLabel(day: string) {
  const d = new Date(`${day}T12:00:00Z`)
  return d.toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
}

function Digests() {
  const digests = Route.useLoaderData()
  return (
    <>
      <PageHead
        title="Daily digests"
        intro={`Each day's watch hits on one page, by ${getDisplayTimeZone().replace('_', ' ')} calendar day. Owners also get it by email when email is set up.`}
        actions={
          <Link className="cw-btn" data-variant="ghost" to="/app/watches">
            Manage watches
          </Link>
        }
      />
      {digests.length === 0 ? (
        <p className="cw-empty">No digests yet. The first one is built shortly after midnight.</p>
      ) : (
        <ol className="cw-daylist">
          {digests.map((d) => (
            <li key={d.id}>
              <section className="cw-panel2" aria-labelledby={`day-${d.id}`}>
                <div className="cw-panel2-head">
                  <h2 id={`day-${d.id}`}>
                    <time dateTime={d.day}>{dayLabel(d.day)}</time>
                  </h2>
                  <span className="cw-badge" data-tone={d.hitCount > 0 ? 'info' : undefined}>
                    {d.hitCount} hit{d.hitCount === 1 ? '' : 's'}
                  </span>
                  <span className="cw-muted" style={{ marginLeft: 'auto' }}>
                    {d.emailedAt ? `Emailed ${fmtTime(d.emailedAt)}` : 'Not emailed'}
                  </span>
                </div>
                {d.hitCount === 0 ? (
                  <p className="cw-empty" style={{ padding: 'var(--space-xs) var(--space-sm)', margin: 0 }}>
                    No new watch hits this day.
                  </p>
                ) : (
                  <ul className="cw-list">
                    {d.items.map((i) => (
                      <li key={i.hitId} data-plain>
                        <span className="cw-list-title">
                          {i.url ? (
                            <a href={i.url} target="_blank" rel="noreferrer noopener">
                              {i.title}
                              <span className="cw-sr-only"> (opens in a new tab)</span>
                            </a>
                          ) : (
                            i.title
                          )}
                        </span>
                        <span className="cw-list-side">{SOURCE_LABEL[i.source.replace(/^demo:/, '')] ?? i.source}</span>
                        <span className="cw-list-meta">
                          matched <span className="mono">{i.entry}</span>
                          {i.source.startsWith('demo:') && (
                            <span className="cw-badge" data-tone="demo">
                              Demo
                            </span>
                          )}
                        </span>
                      </li>
                    ))}
                    {d.hitCount > d.items.length && (
                      <li data-plain>
                        <span className="cw-muted">
                          {d.hitCount - d.items.length} more not listed.{' '}
                          <Link to="/app/watches" search={{ day: d.day }}>
                            See all {d.hitCount} hits for this day
                          </Link>
                        </span>
                      </li>
                    )}
                  </ul>
                )}
              </section>
            </li>
          ))}
        </ol>
      )}
    </>
  )
}
