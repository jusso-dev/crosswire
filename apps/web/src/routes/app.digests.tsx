import { Link, createFileRoute } from '@tanstack/react-router'
import { fetchDigests } from '../fns/watches'
import { fmtTime, getDisplayTimeZone, humanise, plural } from '../components/format'
import { Notice, PageHead, SkeletonPage } from '../components/ui'
import { plainMessage } from '../shared/messages'
import { pageTitle } from '../components/errors'
import { safeHref } from '../shared/links'

/** Daily digests: one per local day. Each day is a section with its hits as a compact list. */
export const Route = createFileRoute('/app/digests')({
  loader: () => fetchDigests(),
  pendingComponent: () => <SkeletonPage label="Loading digests" />,
  errorComponent: ({ error }) => (
    <Notice tone="error" title="Digests did not load">
      {plainMessage(error)} Refresh the page to try again.
    </Notice>
  ),
  head: () => ({ meta: [{ title: pageTitle('Daily digests') }] }),
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
        intro={`Each day's watch hits on one page, by ${humanise(getDisplayTimeZone())} calendar day. Owners also get it by email when email is set up.`}
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
                    {plural(d.hitCount, 'hit')}
                  </span>
                  <span className="cw-muted cw-ml-auto">
                    {d.emailedAt ? `Emailed ${fmtTime(d.emailedAt)}` : 'Not emailed'}
                  </span>
                </div>
                {d.hitCount === 0 ? (
                  <p className="cw-empty cw-m0 cw-pad-xs">
                    No new watch hits this day.
                  </p>
                ) : (
                  <ul className="cw-list">
                    {d.items.map((i) => (
                      <li key={i.hitId} data-plain>
                        <span className="cw-list-title">
                          {safeHref(i.url) ? (
                            <a href={safeHref(i.url)} target="_blank" rel="noreferrer noopener">
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
                            See all {plural(d.hitCount, 'hit')} for this day
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
