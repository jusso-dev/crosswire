import { Link, createFileRoute } from '@tanstack/react-router'
import { fetchCompare } from '../fns/watches'
import { SeverityTag } from '../components/signals'
import { Breadcrumbs, Notice, Term, SkeletonPage } from '../components/ui'
import { plainMessage } from '../shared/messages'
import { pageTitle } from '../components/errors'

/**
 * Cross-source compare as a per-source grid (rows = fields, columns = sources), so agreement and
 * disagreement read across a line. Every date says what it means; missing values say "not reported".
 */
export const Route = createFileRoute('/app/intel/$key')({
  loader: ({ params }) => fetchCompare({ data: { key: params.key } }),
  pendingComponent: () => <SkeletonPage label="Loading sources" />,
  errorComponent: ({ error }) => (
    <Notice tone="error" title="The sources did not load">
      {plainMessage(error)} Refresh the page to try again.
    </Notice>
  ),
  head: ({ params }) => ({ meta: [{ title: pageTitle(params.key, 'Intel') }] }),
  component: Compare,
})

const SOURCE_NAME: Record<string, string> = { 'pwn.watch': 'pwn.watch', 'cisa-kev': 'CISA KEV', nvd: 'NIST NVD', 'cve.watch': 'cve.watch', 'cloudflare-radar': 'Cloudflare Radar' }
// What each source's date field actually records (from the ingest mapping in server/ti).
const DATE_MEANING: Record<string, string> = { 'pwn.watch': 'Incident started', 'cisa-kev': 'Added to KEV', nvd: 'Published', 'cve.watch': 'Published' }

function NotReported() {
  return <span className="cw-muted">not reported</span>
}

function Compare() {
  const r = Route.useLoaderData()
  const present = r.sources.filter((s) => s.present)
  return (
    <>
      <Breadcrumbs items={[{ label: 'Watches', to: '/app/watches' }, { label: `Compare ${r.key}` }]} />
      <header className="cw-pagehead">
        <div>
          <h1 className="mono cw-strong">
            {r.key}
          </h1>
          <p>What each intel source says, side by side. Sources are read as ingested; Crosswire does not score or merge them.</p>
        </div>
        <div className="cw-pagehead-actions">
          <Link className="cw-btn" to="/app/hunts" search={{ title: `Hunt: ${r.key}` }}>
            Start a hunt
          </Link>
        </div>
      </header>

      <section className="cw-panel2" aria-labelledby="summary-title">
        <div className="cw-panel2-head">
          <h2 id="summary-title">In short</h2>
          <span className="cw-muted num">
            {present.length} of {r.sources.length} sources have this {r.kind === 'cve' ? <Term k="cve">CVE</Term> : 'indicator'}
          </span>
          {r.orgHits > 0 && (
            <Link to="/app/watches" className="cw-ml-auto">
              {r.orgHits} watch hit{r.orgHits === 1 ? '' : 's'} in your organisation
            </Link>
          )}
        </div>
        <div className="cw-panel2-body">
          <ul className="cw-m0">
            {r.agree.map((a) => (
              <li key={a}>{a}</li>
            ))}
            {r.differ.map((d) => (
              <li key={d}>
                <strong>Differs:</strong> {d}
              </li>
            ))}
          </ul>
          {r.kind === 'indicator' && <p className="cw-muted cw-mt-xs">Non-CVE keys use a text search on pwn.watch, plus Cloudflare Radar for IPs and domains when enabled.</p>}
        </div>
      </section>

      <div className="cw-tablewrap" role="region" aria-label="Source comparison" tabIndex={0}>
        <table className="cw-table">
          <caption className="cw-sr-only">Fields reported by each source for {r.key}</caption>
          <thead>
            <tr>
              <th scope="col">Field</th>
              {r.sources.map((s) => (
                <th scope="col" key={s.source}>
                  {SOURCE_NAME[s.source] ?? s.source}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">Has this item</th>
              {r.sources.map((s) => (
                <td key={s.source}>{s.present ? <span className="cw-badge" data-tone="info">Listed</span> : <span className="cw-badge">Not listed</span>}</td>
              ))}
            </tr>
            <tr>
              <th scope="row">Title</th>
              {r.sources.map((s) => (
                <td key={s.source}>{!s.present ? '' : s.title ? s.url ? <a href={s.url} target="_blank" rel="noreferrer noopener">{s.title}</a> : s.title : <NotReported />}</td>
              ))}
            </tr>
            <tr>
              <th scope="row">Severity label</th>
              {r.sources.map((s) => (
                <td key={s.source}>
                  {!s.present ? '' : s.severity === 'known-exploited' ? <span className="cw-muted">no severity scale (KEV lists exploited flaws)</span> : s.severity ? <SeverityTag value={s.severity} /> : <NotReported />}
                </td>
              ))}
            </tr>
            <tr>
              <th scope="row">Exploitation</th>
              {r.sources.map((s) => (
                <td key={s.source}>
                  {!s.present ? '' : s.exploited === true ? <span className="cw-badge" data-tone="danger">Exploited</span> : <span className="cw-muted">not reported (not the same as “not exploited”)</span>}
                </td>
              ))}
            </tr>
            <tr>
              <th scope="row">Date</th>
              {r.sources.map((s) => (
                <td key={s.source}>
                  {!s.present ? (
                    ''
                  ) : s.date ? (
                    <>
                      <span className="num mono">{s.date}</span>
                      <div className="cw-muted">{DATE_MEANING[s.source] ?? 'Date'}</div>
                    </>
                  ) : (
                    <NotReported />
                  )}
                </td>
              ))}
            </tr>
            <tr>
              <th scope="row">Vendor / product</th>
              {r.sources.map((s) => (
                <td key={s.source}>{!s.present ? '' : s.vendor || <NotReported />}</td>
              ))}
            </tr>
            <tr>
              <th scope="row">Summary</th>
              {r.sources.map((s) => (
                <td key={s.source} className="cw-cell-mid">
                  {!s.present ? '' : s.summary ? <span className="cw-muted">{s.summary.slice(0, 600)}</span> : <NotReported />}
                </td>
              ))}
            </tr>
            <tr>
              <th scope="row">Provenance</th>
              {r.sources.map((s) => (
                <td key={s.source} className="cw-muted">
                  {s.attribution}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </>
  )
}
