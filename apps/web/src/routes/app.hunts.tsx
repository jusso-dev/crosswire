import { Link, Outlet, createFileRoute, useMatchRoute, useNavigate, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { z } from 'zod'
import { createHuntFn, deletePlaybookFn, fetchHunts, fetchPlaybooks, savePlaybookFn, startPlaybookFn } from '../fns/hunts'
import { fmtTime } from '../components/format'
import { Notice, Term } from '../components/ui'
import { Freshness, StatusTag } from '../components/signals'
import { BUILTIN_PLAYBOOKS, INDICATOR_LABEL, type IndicatorKind, type PlaybookCheck } from '../shared/indicator-playbooks'

/** Hunt list: one dense table with a URL-backed text filter and status filter (kept on back/forward). */
export const Route = createFileRoute('/app/hunts')({
  validateSearch: z.object({
    fromHit: z.string().optional(),
    title: z.string().optional(),
    q: z.string().optional(),
    status: z.enum(['open', 'closed', 'all']).optional(),
  }),
  loader: async () => {
    const [hunts, playbooks] = await Promise.all([fetchHunts(), fetchPlaybooks()])
    return { hunts, playbooks }
  },
  pendingComponent: () => <p className="cw-muted">Loading hunts…</p>,
  errorComponent: ({ error }) => (
    <Notice tone="error" title="Could not load hunts">
      {error instanceof Error ? error.message : String(error)}
    </Notice>
  ),
  component: Hunts,
})

function Hunts() {
  const { hunts, playbooks } = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = useNavigate({ from: '/app/hunts' })
  const matchRoute = useMatchRoute()
  if (matchRoute({ to: '/app/hunts/$huntId', fuzzy: true })) return <Outlet />

  const status = search.status ?? 'open'
  const q = (search.q ?? '').toLowerCase()
  const shown = hunts.filter((h) => (status === 'all' || h.status === status) && (!q || h.title.toLowerCase().includes(q) || h.hypothesis.toLowerCase().includes(q)))
  const counts = { open: hunts.filter((h) => h.status === 'open').length, closed: hunts.filter((h) => h.status === 'closed').length, all: hunts.length }
  const set = (patch: { q?: string; status?: 'open' | 'closed' | 'all' }) => navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true })

  return (
    <>
      <header className="cw-pagehead">
        <div>
          <h1>Hunts</h1>
          <p>
            A <Term k="hunt">hunt</Term> is a case file for checking a hunch. It holds the searches, results and notes, so anyone can see what was checked and why.
          </p>
        </div>
      </header>

      <IndicatorPlaybooks saved={playbooks} />

      <NewHunt open={Boolean(search.fromHit || search.title)} initialTitle={search.title ?? ''} fromHit={search.fromHit} />

      <div className="cw-tablewrap" style={{ overflow: 'visible' }}>
        <div className="cw-toolbar" style={{ borderRadius: 'var(--radius-lg) var(--radius-lg) 0 0' }}>
          <label className="cw-search">
            <span className="cw-sr-only">Filter hunts</span>
            <input type="search" placeholder="Filter by title or hypothesis" value={search.q ?? ''} onChange={(e) => set({ q: e.target.value || undefined })} />
          </label>
          <div className="cw-segmented" role="group" aria-label="Status">
            {(['open', 'closed', 'all'] as const).map((s) => (
              <button key={s} type="button" aria-pressed={status === s} onClick={() => set({ status: s === 'open' ? undefined : s })}>
                {s === 'all' ? 'All' : s === 'open' ? 'Open' : 'Closed'} <span className="num">({counts[s]})</span>
              </button>
            ))}
          </div>
          <span className="cw-toolbar-meta num">
            {shown.length} shown
          </span>
        </div>
        <div style={{ overflowX: 'auto' }}>
          {hunts.length === 0 ? (
            <p className="cw-empty" style={{ padding: 'var(--space-md)' }}>
              No hunts yet. Start one above, or from any watch hit on the <Link to="/app/watches">Watches</Link> page.
            </p>
          ) : shown.length === 0 ? (
            <p className="cw-empty" style={{ padding: 'var(--space-md)' }}>
              No hunts match.{' '}
              <button type="button" className="cw-linkbtn" onClick={() => set({ q: undefined, status: 'all' })}>
                Clear filters
              </button>
            </p>
          ) : (
            <table className="cw-table">
              <thead>
                <tr>
                  <th scope="col">Hunt</th>
                  <th scope="col">Status</th>
                  <th scope="col">Origin</th>
                  <th scope="col">Opened</th>
                  <th scope="col">Last activity</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((h) => (
                  <tr key={h.id}>
                    <td style={{ maxWidth: '60ch' }}>
                      <Link to="/app/hunts/$huntId" params={{ huntId: h.id }}>
                        {h.title}
                      </Link>
                      {h.hypothesis && <div className="cw-muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.hypothesis}</div>}
                    </td>
                    <td>
                      <StatusTag status={h.status} />
                    </td>
                    <td className="cw-muted">{h.fromHit ? 'Watch hit' : 'Manual'}</td>
                    <td className="num">{fmtTime(h.createdAt)}</td>
                    <td>
                      <Freshness at={h.updatedAt} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  )
}

function NewHunt({ open, initialTitle, fromHit }: { open: boolean; initialTitle: string; fromHit?: string }) {
  const navigate = useNavigate()
  const [title, setTitle] = useState(initialTitle)
  const [hypothesis, setHypothesis] = useState('')
  const [error, setError] = useState<string | null>(null)
  return (
    <details className="cw-panel2" open={open}>
      <summary className="cw-panel2-head" style={{ cursor: 'pointer' }}>
        <h2 style={{ display: 'inline' }}>Start a new hunt</h2>
        {fromHit && <span className="cw-badge" data-tone="info">From a watch hit</span>}
      </summary>
      <form
        className="cw-panel2-body cw-form"
        onSubmit={async (e) => {
          e.preventDefault()
          try {
            const h = await createHuntFn({ data: { title, hypothesis, watchHitId: fromHit } })
            await navigate({ to: '/app/hunts/$huntId', params: { huntId: h.id } })
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
          }
        }}
      >
        <label>
          Name the hunt
          <span className="cw-help">Short and specific, for example “Fortinet VPN exploitation check”.</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} />
        </label>
        <label>
          What do you suspect? (optional)
          <span className="cw-help">One or two sentences. Agents use this to suggest searches.</span>
          <textarea value={hypothesis} onChange={(e) => setHypothesis(e.target.value)} rows={3} placeholder="Attackers may be using the new FortiOS flaw against our edge firewalls." />
        </label>
        {error && (
          <Notice tone="error" title="Hunt not created">
            {error}
          </Notice>
        )}
        <div>
          <button className="cw-btn" type="submit" disabled={!title.trim()}>
            Start hunt
          </button>
        </div>
      </form>
    </details>
  )
}

type SavedPlaybook = { id: string; name: string; description: string; indicatorKind: IndicatorKind; checks: PlaybookCheck[] }

function IndicatorPlaybooks({ saved }: { saved: SavedPlaybook[] }) {
  const navigate = useNavigate()
  const router = useRouter()
  const options = [
    ...BUILTIN_PLAYBOOKS.map((playbook) => ({ id: playbook.id, name: playbook.name, description: playbook.description, indicatorKind: playbook.indicatorKind })),
    ...saved,
  ]
  const [playbookId, setPlaybookId] = useState(options[0]!.id)
  const selected = options.find((playbook) => playbook.id === playbookId) ?? options[0]!
  const [indicator, setIndicator] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const savedSelected = saved.find((playbook) => playbook.id === selected.id)
  return (
    <section className="cw-panel2" aria-labelledby="playbook-title">
      <div className="cw-panel2-head">
        <h2 id="playbook-title">Check an indicator</h2>
      </div>
      <form
        className="cw-panel2-body cw-form"
        onSubmit={async (e) => {
          e.preventDefault()
          setBusy(true)
          setError(null)
          try {
            const started = await startPlaybookFn({ data: { playbookId: selected.id, indicator } })
            await navigate({ to: '/app/hunts/$huntId', params: { huntId: started.huntId } })
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
          } finally {
            setBusy(false)
          }
        }}
      >
        <p className="cw-help" style={{ marginTop: 0 }}>
          One click opens a hunt and proposes every check in the playbook. Nothing is searched until a person approves each check. The hunt page and the exported report then say whether anything hit, and list what was checked.
        </p>
        <label>
          Playbook
          <select value={selected.id} onChange={(e) => setPlaybookId(e.target.value)}>
            <optgroup label="Built in">
              {BUILTIN_PLAYBOOKS.map((playbook) => (
                <option key={playbook.id} value={playbook.id}>
                  {playbook.name}
                </option>
              ))}
            </optgroup>
            {saved.length > 0 && (
              <optgroup label="Saved">
                {saved.map((playbook) => (
                  <option key={playbook.id} value={playbook.id}>
                    {playbook.name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
          <span className="cw-help">{selected.description}</span>
        </label>
        <label>
          {INDICATOR_LABEL[selected.indicatorKind]}
          <input
            value={indicator}
            onChange={(e) => setIndicator(e.target.value)}
            required
            maxLength={253}
            spellCheck={false}
            placeholder={selected.indicatorKind === 'ip' ? '203.0.113.10' : selected.indicatorKind === 'domain' ? 'example.invalid' : '64, 40, or 32 hex characters'}
          />
        </label>
        {error && (
          <Notice tone="error" title="Checks not proposed">
            {error}
          </Notice>
        )}
        <div style={{ display: 'flex', gap: 'var(--space-xs)', flexWrap: 'wrap' }}>
          <button className="cw-btn" type="submit" disabled={busy || !indicator.trim()}>
            {busy ? 'Proposing…' : 'Propose checks'}
          </button>
          {savedSelected && (
            <button
              className="cw-btn"
              data-variant="ghost"
              type="button"
              disabled={busy}
              onClick={async () => {
                setBusy(true)
                setError(null)
                try {
                  await deletePlaybookFn({ data: { playbookId: savedSelected.id } })
                  setPlaybookId(BUILTIN_PLAYBOOKS[0]!.id)
                  await router.invalidate()
                } catch (err) {
                  setError(err instanceof Error ? err.message : String(err))
                } finally {
                  setBusy(false)
                }
              }}
            >
              Delete saved playbook
            </button>
          )}
        </div>
      </form>
      <SavePlaybook />
    </section>
  )
}

function SavePlaybook() {
  const router = useRouter()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [indicatorKind, setIndicatorKind] = useState<IndicatorKind>('ip')
  const [checks, setChecks] = useState<PlaybookCheck[]>([{ name: '', target: 'defender', kql: '' }])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const setCheck = (index: number, patch: Partial<PlaybookCheck>) => setChecks((current) => current.map((check, i) => (i === index ? { ...check, ...patch } : check)))
  return (
    <details>
      <summary className="cw-panel2-foot" style={{ cursor: 'pointer' }}>
        Save a playbook for this organisation
      </summary>
      <form
        className="cw-panel2-body cw-form"
        onSubmit={async (e) => {
          e.preventDefault()
          setBusy(true)
          setError(null)
          try {
            await savePlaybookFn({ data: { name, description, indicatorKind, checks } })
            setName('')
            setDescription('')
            setChecks([{ name: '', target: 'defender', kql: '' }])
            await router.invalidate()
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
          } finally {
            setBusy(false)
          }
        }}
      >
        <p className="cw-help" style={{ marginTop: 0 }}>
          Put <code>{'{{indicator}}'}</code> where the IP, domain, or hash should go. Saving does not run the queries.
        </p>
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} />
        </label>
        <label>
          What it checks (optional)
          <input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
        </label>
        <label>
          Indicator
          <select value={indicatorKind} onChange={(e) => setIndicatorKind(e.target.value as IndicatorKind)}>
            <option value="ip">IP address</option>
            <option value="domain">Domain</option>
            <option value="hash">File hash</option>
          </select>
        </label>
        {checks.map((check, index) => (
          <fieldset key={index} className="cw-form">
            <legend>
              Check {index + 1}
              {checks.length > 1 && (
                <button type="button" className="cw-linkbtn" onClick={() => setChecks((current) => current.filter((_, i) => i !== index))}>
                  Remove
                </button>
              )}
            </legend>
            <label>
              Name
              <input value={check.name} onChange={(e) => setCheck(index, { name: e.target.value })} required maxLength={80} />
            </label>
            <label>
              Where
              <select value={check.target} onChange={(e) => setCheck(index, { target: e.target.value as PlaybookCheck['target'] })}>
                <option value="defender">Defender XDR</option>
                <option value="sentinel">Sentinel</option>
              </select>
            </label>
            <label>
              KQL template
              <textarea value={check.kql} onChange={(e) => setCheck(index, { kql: e.target.value })} required rows={4} maxLength={10000} spellCheck={false} placeholder={"DeviceNetworkEvents\n| where RemoteIP == '{{indicator}}'\n| take 100"} />
            </label>
          </fieldset>
        ))}
        {error && (
          <Notice tone="error" title="Playbook not saved">
            {error}
          </Notice>
        )}
        <div style={{ display: 'flex', gap: 'var(--space-xs)', flexWrap: 'wrap' }}>
          {checks.length < 8 && (
            <button type="button" className="cw-btn" data-variant="ghost" onClick={() => setChecks((current) => [...current, { name: '', target: 'defender', kql: '' }])}>
              Add check
            </button>
          )}
          <button className="cw-btn" type="submit" disabled={busy || !name.trim()}>
            {busy ? 'Saving…' : 'Save playbook'}
          </button>
        </div>
      </form>
    </details>
  )
}
