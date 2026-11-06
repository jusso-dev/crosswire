import { createFileRoute } from '@tanstack/react-router'
import { fetchDigests } from '../fns/watches'
import { fmtTime } from '../components/format'

export const Route = createFileRoute('/app/digests')({
  loader: () => fetchDigests(),
  component: Digests,
})

function Digests() {
  const digests = Route.useLoaderData()
  return (
    <>
      <h1>Daily digests</h1>
      <p className="cw-muted">One digest per org per UTC day. Email goes to org owners when SMTP is configured.</p>
      {digests.length === 0 && <p className="cw-empty">No digests yet. The daily job builds them (pnpm digest:daily, or the worker).</p>}
      {digests.map((d) => (
        <section className="cw-card" key={d.id} style={{ marginBottom: 12 }}>
          <h3>
            {d.day} · {d.hitCount} hit{d.hitCount === 1 ? '' : 's'}
          </h3>
          {d.hitCount === 0 ? (
            <p className="cw-empty">No new watch hits.</p>
          ) : (
            <ul>
              {d.items.map((i) => (
                <li key={i.hitId}>
                  {i.url ? (
                    <a href={i.url} target="_blank" rel="noreferrer noopener">
                      {i.title}
                    </a>
                  ) : (
                    i.title
                  )}{' '}
                  <span className="cw-muted">
                    (Source: {i.source}, matched “{i.entry}”)
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="cw-muted">{d.emailedAt ? `Emailed ${fmtTime(d.emailedAt)}` : 'Not emailed'}</p>
        </section>
      ))}
    </>
  )
}
