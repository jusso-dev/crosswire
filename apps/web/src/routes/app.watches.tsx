import { Link, createFileRoute, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { createWatch, fetchWatches, removeWatch } from '../fns/watches'
import { fmtTime } from '../components/format'

export const Route = createFileRoute('/app/watches')({
  loader: () => fetchWatches(),
  component: Watches,
})

const TYPES = [
  { value: 'keyword', label: 'Keyword' },
  { value: 'cve', label: 'CVE' },
  { value: 'vendor', label: 'Vendor' },
  { value: 'tag', label: 'Tag (pwn.watch)' },
] as const

function Watches() {
  const { entries, hits } = Route.useLoaderData()
  const router = useRouter()
  const [type, setType] = useState<(typeof TYPES)[number]['value']>('keyword')
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  return (
    <>
      <h1>Watches</h1>
      <p className="cw-muted">
        Items of interest for your org. The matcher checks pwn.watch incidents and CISA KEV after each ingest. Keywords and vendors are case-insensitive whole-word matches (not ML), with a 3-character minimum; CVEs and tags match exactly.
      </p>
      <form
        className="cw-row"
        onSubmit={async (e) => {
          e.preventDefault()
          const r = await createWatch({ data: { type, value } })
          if (!r.ok) return setError(r.error)
          setError(null)
          setValue('')
          await router.invalidate()
        }}
      >
        <label>
          Type
          <select value={type} onChange={(e) => setType(e.target.value as typeof type)}>
            {TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <label style={{ flex: 1 }}>
          Value
          <input value={value} onChange={(e) => setValue(e.target.value)} placeholder={type === 'cve' ? 'CVE-2026-12345' : type === 'tag' ? 'cisa-kev' : 'fortinet'} required />
        </label>
        <button className="cw-btn" type="submit">
          Add
        </button>
      </form>
      {error && (
        <p className="cw-error" role="alert">
          {error}
        </p>
      )}
      <h2>Entries</h2>
      {entries.length === 0 ? (
        <p className="cw-empty">No entries yet.</p>
      ) : (
        <table className="cw-table">
          <thead>
            <tr>
              <th>Type</th>
              <th>Value</th>
              <th>Added</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id}>
                <td>{e.type}</td>
                <td>{e.value}</td>
                <td>{fmtTime(e.createdAt)}</td>
                <td>
                  <button
                    className="cw-btn"
                    data-variant="ghost"
                    onClick={async () => {
                      await removeWatch({ data: { id: e.id } })
                      await router.invalidate()
                    }}
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h2>Recent hits</h2>
      {hits.length === 0 ? (
        <p className="cw-empty">No hits yet. Hits appear after the ingest and matcher jobs run (see docs/watchlists.md).</p>
      ) : (
        <table className="cw-table">
          <thead>
            <tr>
              <th>Item</th>
              <th>Matched</th>
              <th>Source</th>
              <th>When</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {hits.map((h) => (
              <tr key={h.id}>
                <td>
                  {h.url ? (
                    <a href={h.url} target="_blank" rel="noreferrer noopener">
                      {h.title}
                    </a>
                  ) : (
                    h.title
                  )}
                  <div className="cw-muted">{h.snippet}</div>
                  {h.cveIds.slice(0, 3).map((c) => (
                    <Link key={c} to="/app/intel/$key" params={{ key: c }} style={{ marginRight: 8 }}>
                      Compare {c}
                    </Link>
                  ))}
                </td>
                <td>
                  {h.entryType}: {h.entryValue}
                </td>
                <td>Source: {h.source}</td>
                <td>{fmtTime(h.createdAt)}</td>
                <td>
                  <Link to="/app/hunts" search={{ fromHit: h.id, title: `Hunt: ${h.title.slice(0, 150)}` }}>
                    Start hunt
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="cw-muted">
        Threat intel from <a href="https://pwn.watch">pwn.watch</a> and the CISA Known Exploited Vulnerabilities catalog.
      </p>
    </>
  )
}
