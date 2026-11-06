import { Link, createFileRoute } from '@tanstack/react-router'
import { fetchCompare } from '../fns/watches'

export const Route = createFileRoute('/app/intel/$key')({
  loader: ({ params }) => fetchCompare({ data: { key: params.key } }),
  component: Compare,
})

function Compare() {
  const r = Route.useLoaderData()
  return (
    <>
      <p>
        <Link to="/app/watches">← Watches</Link>
      </p>
      <h1>Intel compare: {r.key}</h1>
      <section className="cw-card" style={{ marginBottom: 16 }}>
        <h3>Summary</h3>
        <ul>
          {r.agree.map((a) => (
            <li key={a}>{a}</li>
          ))}
          {r.differ.map((d) => (
            <li key={d}>
              <strong>Differs:</strong> {d}
            </li>
          ))}
        </ul>
        {r.orgHits > 0 && <p className="cw-muted">Your org has {r.orgHits} watch hit(s) for this key.</p>}
        {r.kind === "indicator" && <p className="cw-muted">Non-CVE keys use a text search on pwn.watch, plus Cloudflare Radar for IPs and domains when enabled.</p>}
      </section>
      <div className="cw-grid">
        {r.sources.map((s) => (
          <section className="cw-card" key={s.source} aria-label={s.source}>
            <h3>{s.source}</h3>
            {s.present ? (
              <>
                {s.title && <p>{s.url ? <a href={s.url} target="_blank" rel="noreferrer noopener">{s.title}</a> : s.title}</p>}
                <p className="cw-muted">
                  {s.severity && <>Severity: {s.severity} · </>}
                  {s.date && <>Date: {s.date} · </>}
                  {s.vendor && <>Vendor: {s.vendor}</>}
                </p>
                {s.exploited && <span className="cw-badge" data-tone="danger">exploited</span>}
                {s.summary && <p style={{ fontSize: 13 }}>{s.summary.slice(0, 600)}</p>}
              </>
            ) : (
              <p className="cw-empty">Not present in this source.</p>
            )}
            <p className="cw-muted">{s.attribution}</p>
          </section>
        ))}
      </div>
    </>
  )
}
