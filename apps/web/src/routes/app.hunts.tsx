import { Link, Outlet, createFileRoute, useMatchRoute, useNavigate, useRouter } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import { createHuntFn, deletePlaybookFn, fetchHunts, fetchPlaybooks, savePlaybookFn, startPlaybookFn } from '../fns/hunts'
import { fmtTime } from '../components/format'
import { Notice, Term, SkeletonPage } from '../components/ui'
import { useAction } from '../components/action'
import { ConfirmDialog } from '../components/confirm'
import { Freshness, StatusTag } from '../components/signals'
import { INDICATOR_LABEL, builtinForKind, detectIndicator, normaliseIndicator, type IndicatorKind, type PlaybookCheck } from '../shared/indicator-playbooks'
import { RouteError, pageTitle } from '../components/errors'
import { Disclosure } from './-hunts/disclosure'

/** Hunt list: one dense table with a URL-backed text filter and status filter (kept on back/forward). */
export const Route = createFileRoute('/app/hunts')({
  validateSearch: z.object({
    fromHit: z.string().optional(),
    title: z.string().optional(),
    q: z.string().optional(),
    status: z.enum(['open', 'closed', 'all']).optional(),
    check: z.string().optional(),
  }),
  loader: async () => {
    const [hunts, playbooks] = await Promise.all([fetchHunts(), fetchPlaybooks()])
    return { hunts, playbooks }
  },
  pendingComponent: () => <SkeletonPage label="Loading hunts" />,
  errorComponent: ({ error }) => <RouteError error={error} title="Hunts did not load" />,
  head: () => ({ meta: [{ title: pageTitle('Hunts') }] }),
  component: Hunts,
})

function Hunts() {
  const { hunts, playbooks } = Route.useLoaderData()
  const { session } = Route.useRouteContext()
  const search = Route.useSearch()
  const navigate = useNavigate({ from: '/app/hunts' })
  const matchRoute = useMatchRoute()
  const [moreOpen, setMoreOpen] = useState(Boolean(search.fromHit || search.title))
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
            Paste an IP address, domain, or file hash. Crosswire proposes the usual checks. Nothing is searched until you approve them. A <Term k="hunt">hunt</Term> keeps the searches, results and notes.
          </p>
        </div>
      </header>

      <CheckIndicator autoFocus={Boolean(search.check)} />

      <Disclosure title="Blank hunt and saved playbooks" open={moreOpen} onToggle={setMoreOpen}>
        <NewHunt open={Boolean(search.fromHit || search.title)} initialTitle={search.title ?? ''} fromHit={search.fromHit} />
        <SavedPlaybookStart saved={playbooks} canDelete={session.canApprove} />
        <SavePlaybook />
      </Disclosure>

      <div className="cw-tablewrap cw-overflow-visible">
        <div className="cw-toolbar cw-attached">
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
        <div className="cw-scroll-x" role="region" aria-label="Hunts" tabIndex={0}>
          {hunts.length === 0 ? (
            <p className="cw-empty cw-pad">
              No hunts yet. Start one above, or from any watch hit on the <Link to="/app/watches">Watches</Link> page.
            </p>
          ) : shown.length === 0 ? (
            <p className="cw-empty cw-pad">
              No hunts match.{' '}
              <button type="button" className="cw-linkbtn" onClick={() => set({ q: undefined, status: 'all' })}>
                Clear filters
              </button>
            </p>
          ) : (
            <table className="cw-table">
              <caption className="cw-sr-only">
                {status === 'all' ? 'All hunts' : status === 'open' ? 'Open hunts' : 'Closed hunts'}
                {q ? ` matching the filter` : ''}
              </caption>
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
                    <td className="cw-cell-wide">
                      <Link to="/app/hunts/$huntId" params={{ huntId: h.id }}>
                        {h.title}
                      </Link>
                      {h.hypothesis && <div className="cw-muted cw-ellipsis">{h.hypothesis}</div>}
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
  const { run, busy, error } = useAction()
  const [expanded, setExpanded] = useState(open)
  return (
    <Disclosure
      title="Start a new hunt"
      level={3}
      open={expanded}
      onToggle={setExpanded}
      extra={
        fromHit && (
          <span className="cw-badge" data-tone="info">
            From a watch hit
          </span>
        )
      }
    >
      <form
        className="cw-panel2-body cw-form"
        onSubmit={(e) => {
          e.preventDefault()
          void run('create', async () => {
            const h = await createHuntFn({ data: { title, hypothesis, watchHitId: fromHit } })
            await navigate({ to: '/app/hunts/$huntId', params: { huntId: h.id } })
          })
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
          <button className="cw-btn" type="submit" disabled={busy !== null || !title.trim()} aria-busy={busy !== null || undefined}>
            {busy ? 'Starting…' : 'Start hunt'}
          </button>
        </div>
      </form>
    </Disclosure>
  )
}

function CheckIndicator({ autoFocus }: { autoFocus: boolean }) {
  const navigate = useNavigate()
  const inputRef = useRef<HTMLInputElement>(null)
  const [indicator, setIndicator] = useState('')
  const { run, busy, error, setError } = useAction()
  const detected = detectIndicator(indicator)
  useEffect(() => {
    if (autoFocus) inputRef.current?.focus()
  }, [autoFocus])
  return (
    <section className="cw-panel2" aria-labelledby="playbook-title">
      <div className="cw-panel2-head">
        <h2 id="playbook-title">Check an indicator</h2>
      </div>
      <form
        className="cw-panel2-body cw-form"
        onSubmit={async (e) => {
          e.preventDefault()
          const found = detectIndicator(indicator)
          const playbook = found ? builtinForKind(found.kind) : null
          if (!found || !playbook) {
            setError('That is not an IP address, domain, or file hash.')
            return
          }
          await run('check', async () => {
            const started = await startPlaybookFn({ data: { playbookId: playbook.id, indicator: found.value } })
            await navigate({ to: '/app/hunts/$huntId', params: { huntId: started.huntId } })
          })
        }}
      >
        <label>
          IP address, domain, or file hash
          <input
            id="indicator-check"
            ref={inputRef}
            value={indicator}
            onChange={(e) => setIndicator(e.target.value)}
            required
            maxLength={253}
            spellCheck={false}
            placeholder="203.0.113.10"
            autoComplete="off"
          />
          <span className="cw-help">
            {detected ? `${INDICATOR_LABEL[detected.kind]}. Proposes the built-in checks. Nothing runs until you approve them.` : 'Paste one indicator.'}
          </span>
        </label>
        {error && (
          <Notice tone="error" title="Checks not proposed">
            {error}
          </Notice>
        )}
        <button className="cw-btn" type="submit" disabled={busy !== null || !indicator.trim()} aria-busy={busy !== null || undefined}>
          {busy ? 'Proposing…' : 'Check this'}
        </button>
      </form>
    </section>
  )
}

type SavedPlaybook = { id: string; name: string; description: string; indicatorKind: IndicatorKind; checks: PlaybookCheck[] }

function SavedPlaybookStart({ saved, canDelete }: { saved: SavedPlaybook[]; canDelete: boolean }) {
  const navigate = useNavigate()
  const router = useRouter()
  const [playbookId, setPlaybookId] = useState(saved[0]?.id ?? '')
  const selected = saved.find((playbook) => playbook.id === playbookId) ?? saved[0]
  const [indicator, setIndicator] = useState('')
  const { run, busy, error, setError } = useAction()
  const [deleting, setDeleting] = useState<SavedPlaybook | null>(null)
  if (!selected) return <p className="cw-empty cw-pad">No saved playbooks yet.</p>

  const remove = async (playbook: SavedPlaybook) => {
    const r = await run('delete', async () => {
      const r = await deletePlaybookFn({ data: { playbookId: playbook.id } })
      if (!r.ok) return r
      setPlaybookId(saved.find((p) => p.id !== playbook.id)?.id ?? '')
      await router.invalidate()
      return r
    })
    if (r?.ok) setDeleting(null)
  }

  return (
    <form
      className="cw-panel2-body cw-form"
      onSubmit={async (e) => {
        e.preventDefault()
        const value = normaliseIndicator(selected.indicatorKind, indicator)
        if (!value) {
          setError(`That is not a valid ${INDICATOR_LABEL[selected.indicatorKind]}.`)
          return
        }
        await run('start', async () => {
          const started = await startPlaybookFn({ data: { playbookId: selected.id, indicator: value } })
          await navigate({ to: '/app/hunts/$huntId', params: { huntId: started.huntId } })
        })
      }}
    >
      <h3>Use a saved playbook</h3>
      <label>
        Playbook
        <select value={selected.id} onChange={(e) => setPlaybookId(e.target.value)}>
          {saved.map((playbook) => (
            <option key={playbook.id} value={playbook.id}>
              {playbook.name}
            </option>
          ))}
        </select>
        {selected.description && <span className="cw-help">{selected.description}</span>}
      </label>
      <label>
        {INDICATOR_LABEL[selected.indicatorKind]}
        <input value={indicator} onChange={(e) => setIndicator(e.target.value)} required maxLength={253} spellCheck={false} />
      </label>
      {error && !deleting && (
        <Notice tone="error" title="That step did not complete">
          {error}
        </Notice>
      )}
      <div className="cw-cluster">
        <button className="cw-btn" type="submit" disabled={busy !== null || !indicator.trim()} aria-busy={busy === 'start' || undefined}>
          {busy === 'start' ? 'Proposing…' : 'Propose checks'}
        </button>
        {canDelete ? (
          <button
            className="cw-btn"
            data-variant="ghost"
            type="button"
            disabled={busy !== null}
            onClick={() => {
              setError(null)
              setDeleting(selected)
            }}
          >
            Delete saved playbook…
          </button>
        ) : (
          <span className="cw-help">An owner or approver can delete saved playbooks.</span>
        )}
      </div>
      <ConfirmDialog
        open={deleting !== null}
        tone="danger"
        title={`Delete the playbook "${deleting?.name ?? ''}"?`}
        body={<p>It is removed for everyone in this organisation. Hunts already started from it keep their searches.</p>}
        confirmLabel="Delete playbook"
        busy={busy === 'delete'}
        error={deleting ? error : null}
        onCancel={() => setDeleting(null)}
        onConfirm={() => deleting && void remove(deleting)}
      />
    </form>
  )
}

function SavePlaybook() {
  const router = useRouter()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [indicatorKind, setIndicatorKind] = useState<IndicatorKind>('ip')
  const [checks, setChecks] = useState<PlaybookCheck[]>([{ name: '', target: 'defender', kql: '' }])
  const { run, busy, error } = useAction()
  const setCheck = (index: number, patch: Partial<PlaybookCheck>) => setChecks((current) => current.map((check, i) => (i === index ? { ...check, ...patch } : check)))
  return (
    <details>
      <summary className="cw-panel2-foot cw-pointer">
        Save a playbook for this organisation
      </summary>
      <form
        className="cw-panel2-body cw-form"
        onSubmit={async (e) => {
          e.preventDefault()
          void run('save', async () => {
            await savePlaybookFn({ data: { name, description, indicatorKind, checks } })
            setName('')
            setDescription('')
            setChecks([{ name: '', target: 'defender', kql: '' }])
            await router.invalidate()
          })
        }}
      >
        <p className="cw-help cw-mt0">
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
        <div className="cw-cluster">
          {checks.length < 8 && (
            <button type="button" className="cw-btn" data-variant="ghost" onClick={() => setChecks((current) => [...current, { name: '', target: 'defender', kql: '' }])}>
              Add check
            </button>
          )}
          <button className="cw-btn" type="submit" disabled={busy !== null || !name.trim()} aria-busy={busy !== null || undefined}>
            {busy ? 'Saving…' : 'Save playbook'}
          </button>
        </div>
      </form>
    </details>
  )
}
