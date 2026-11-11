import { Link, createFileRoute, useRouter } from '@tanstack/react-router'
import { useEffect, useState, type ReactNode } from 'react'
import { fetchDashboard } from '../fns/dashboard'
import { fmtAgo, fmtTime, getDisplayTimeZone } from '../components/format'
import { dismissSetupFn, fetchSetup, loadDemoFn } from '../fns/setup'
import { Notice, PageHead, SkeletonPage, Term } from '../components/ui'
import { plainMessage } from '../shared/messages'
import { Freshness, SeverityTag } from '../components/signals'
import { pageTitle } from '../components/errors'

export const Route = createFileRoute('/app/')({
  loader: async () => {
    const [d, setup] = await Promise.all([fetchDashboard(), fetchSetup()])
    return { ...d, setup }
  },
  pendingComponent: () => <SkeletonPage rows={6} label="Loading the control panel" />,
  errorComponent: ({ error }) => (
    <Notice tone="error" title="The control panel did not load">
      {plainMessage(error)} Refresh the page to try again.
    </Notice>
  ),
  head: () => ({ meta: [{ title: pageTitle('Control panel') }] }),
  component: ControlPanel,
})

type Data = Awaited<ReturnType<typeof fetchDashboard>> & { setup: Awaited<ReturnType<typeof fetchSetup>> }

const HOUR = 3_600_000

function feedState(f: { lastFetchedAt: string | null; ok: boolean }): 'ok' | 'warn' | 'off' {
  if (!f.lastFetchedAt) return 'off'
  if (!f.ok || Date.now() - new Date(f.lastFetchedAt).getTime() > 3 * HOUR) return 'warn'
  return 'ok'
}

function greeting() {
  const h = Number(new Intl.DateTimeFormat('en-AU', { hour: 'numeric', hourCycle: 'h23', timeZone: getDisplayTimeZone() }).format(new Date()))
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
}

function ControlPanel() {
  const d: Data = Route.useLoaderData()
  const { session } = Route.useRouteContext()
  const firstName = (session.user.name || session.user.email).split(/[ @]/)[0]
  return (
    <>
      <PageHead
        title={`${greeting()}, ${firstName}`}
        intro="Feed status and safety at the top. Below: decisions waiting for you, emerging threats, your watch hits, newly exploited flaws, hunts and agent activity."
        actions={
          <>
            <Link to="/app/chat" className="cw-btn" data-variant="ghost">
              Ask an agent
            </Link>
            <Link to="/app/hunts" search={{ check: '1' }} className="cw-btn">
              Start a hunt
            </Link>
          </>
        }
      />
      {d.setup.warnings.map((w) => (
        <Notice key={w} tone="warn" title="Check response safety">
          {w}
        </Notice>
      ))}
      <LineCheck d={d} />
      <NextSteps setup={d.setup} d={d} />
      <div className="cw-panels">
        <Waiting d={d} />
        <Emerging d={d} />
        <WatchHits d={d} />
        <Kev d={d} />
        <Hunts d={d} />
        <Activity d={d} />
      </div>
    </>
  )
}

/** The graphite board: each feed is a wire into the org; the node shows whether it is live. */
function LineCheck({ d }: { d: Data }) {
  const pwn = feedState(d.feeds.pwnwatch)
  const kev = feedState(d.feeds.kev)
  const executors = Object.entries(d.setup.executors)
  const liveExec = executors.some(([, v]) => v === 'on')
  const hunting = d.setup.items.find((i) => i.key === 'hunting')?.done ?? false
  const stateLabel = (s: 'ok' | 'warn' | 'off', at: string | null) => (s === 'off' ? 'not fetched yet' : s === 'warn' ? `stale · ${fmtAgo(at)}` : `live · ${fmtAgo(at)}`)
  return (
    <section className="cw-board" aria-labelledby="linecheck-title">
      <div>
        <h2 id="linecheck-title">Line check</h2>
        <p className="cw-muted">Where the outside world crosses your organisation. A green node means the line is live.</p>
        <ul className="cw-wires">
          <li className="cw-wire" data-state={pwn}>
            <span className="cw-wire-name">pwn.watch</span>
            <span className="cw-wire-line" aria-hidden />
            <span className="cw-wire-state">{stateLabel(pwn, d.feeds.pwnwatch.lastFetchedAt)}</span>
          </li>
          <li className="cw-wire" data-state={kev}>
            <span className="cw-wire-name">CISA KEV</span>
            <span className="cw-wire-line" aria-hidden />
            <span className="cw-wire-state">{stateLabel(kev, d.feeds.kev.lastFetchedAt)}</span>
          </li>
          <li className="cw-wire" data-state={hunting ? 'ok' : 'off'}>
            <span className="cw-wire-name">Defender / Sentinel</span>
            <span className="cw-wire-line" aria-hidden />
            <span className="cw-wire-state">{hunting ? 'connected' : 'demo data only'}</span>
          </li>
        </ul>
      </div>
      <div className="cw-board-stats">
        <Stat value={d.totals.liveIncidents} label="live incidents on pwn.watch" />
        <Stat value={d.totals.hits7} label="watch hits in the last 7 days" />
        <Stat value={d.totals.openHunts} label="open hunts" />
        <Stat value={d.totals.awaitingDecision} label="waiting for a decision" />
      </div>
      <div className="cw-safety">
        <span className="cw-lamp" data-state={d.setup.dryRun && !liveExec ? 'ok' : 'warn'}>
          {d.setup.dryRun ? 'Safe mode on' : 'Safe mode off'}
        </span>
        <span>
          Response safety: dry-run {d.setup.dryRun ? 'ON' : 'OFF'} · executors {executors.map(([k, v]) => `${k}=${v}`).join(', ')}
        </span>
        <span>
          Nothing changes in Microsoft without a person approving it. <Term k="dryRun">What is a dry run?</Term>
        </span>
      </div>
    </section>
  )
}

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div className="cw-stat">
      <div className="cw-count">{value}</div>
      <div className="cw-stat-label">{label}</div>
    </div>
  )
}

/** Plain-language "do this next" strip. Steps tick themselves off from real signals. */
function NextSteps({ setup, d }: { setup: Data['setup']; d: Data }) {
  const router = useRouter()
  const { session } = Route.useRouteContext()
  const [msg, setMsg] = useState<string | null>(null)
  // Each person can hide the checklist for themselves; the browser remembers it.
  const storeKey = `cw-onboarding-hidden:${session.user.id}`
  const [hidden, setHidden] = useState(false)
  useEffect(() => {
    try {
      // Sync from storage after hydration, as ThemeToggle does; the server cannot read it.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setHidden(localStorage.getItem(storeKey) === '1')
    } catch {
      // Storage blocked: show the checklist.
    }
  }, [storeKey])
  if (setup.dismissed || hidden) return null
  const o = d.onboarding
  const steps = [
    { done: o.tenant, title: 'Connect your tenant', body: <>Save the <Term k="defender">Defender</Term> or <Term k="sentinel">Sentinel</Term> hunting connector. Until then, searches use demo data.</>, to: '/app/settings', cta: 'Open settings' },
    { done: o.watch, title: 'Add a watch', body: <>Name a vendor or product you use. Crosswire checks feeds for it every hour (<Term k="watch">what is a watch?</Term>).</>, to: '/app/watches', cta: 'Add a watch' },
    { done: o.hunt, title: 'Run a hunt', body: <>Open a <Term k="hunt">hunt</Term>, approve a search, and read the sample rows.</>, to: '/app/hunts', cta: 'Start a hunt' },
    { done: o.agent, title: 'Ask an agent', body: 'Ask Hunter or Intel a question. You approve anything it proposes.', to: '/app/chat', cta: 'Open chat' },
    { done: o.approval, title: 'Review an approval', body: <>Open an action, run a <Term k="dryRun">dry run</Term>, and decide. A second person always decides.</>, to: '/app/approvals', cta: 'Open approvals' },
  ]
  const doneCount = steps.filter((s) => s.done).length
  if (doneCount === steps.length && setup.complete) return null
  return (
    <section className="cw-onboard" aria-labelledby="next-title">
      <div className="cw-onboard-head">
        <h2 id="next-title">Get started</h2>
        <span className="cw-muted num">
          {doneCount} of {steps.length} done
        </span>
        <span className="cw-progress" aria-hidden="true">
          <span style={{ width: `${(doneCount / steps.length) * 100}%` }} />
        </span>
        <span className="cw-spacer" />
        {setup.canLoadDemo && (
          <button
            type="button"
            className="cw-btn"
            data-variant="ghost"
            data-size="sm"
            onClick={async () => {
              try {
                const r = await loadDemoFn()
                setMsg(r.loaded ? 'Demo data loaded. Look for [DEMO] items in Watches, Hunts and Approvals.' : 'Demo data is already loaded.')
                await router.invalidate()
              } catch (err) {
                setMsg(plainMessage(err))
              }
            }}
          >
            Load demo data
          </button>
        )}
        <button
          type="button"
          className="cw-btn"
          data-variant="quiet"
          data-size="sm"
          onClick={() => {
            try {
              localStorage.setItem(storeKey, '1')
            } catch {
              // Storage blocked: hide for this visit only.
            }
            setHidden(true)
          }}
        >
          Hide checklist
        </button>
        {setup.isOwner && (
          <button
            type="button"
            className="cw-btn"
            data-variant="quiet"
            data-size="sm"
            onClick={async () => {
              try {
                await dismissSetupFn()
                await router.invalidate()
              } catch (err) {
                setMsg(plainMessage(err))
              }
            }}
          >
            Hide for everyone
          </button>
        )}
      </div>
      <ol>
        {steps.map((s) => (
          <li key={s.title} data-done={s.done}>
            <strong>{s.title}</strong>
            <span>{s.body}</span>
            {s.done ? <span className="cw-sr-only">Done.</span> : <Link to={s.to}>{s.cta} →</Link>}
          </li>
        ))}
      </ol>
      {msg && (
        <p className="cw-muted cw-mt-sm" role="status">
          {msg}
        </p>
      )}
      <details className="cw-mt-sm">
        <summary>
          Admin setup checklist ({setup.items.filter((i) => i.done).length}/{setup.items.length})
        </summary>
        <ul className="cw-list cw-mt-xs">
          {setup.items.map((i) => (
            <li key={i.key} data-plain>
              <span className="cw-list-title">
                <span aria-hidden>{i.done ? '✓' : '○'}</span> <a href={i.href}>{i.label}</a>
              </span>
              <span className="cw-list-side">{i.done ? 'done' : 'to do'}</span>
              <span className="cw-list-meta">{i.detail}</span>
            </li>
          ))}
        </ul>
      </details>
    </section>
  )
}

function Panel({ title, sub, link, span, children, label }: { title: string; sub?: ReactNode; link?: { to: string; label: string }; span: string; children: ReactNode; label: string }) {
  return (
    <section className={`cw-card cw-panel ${span}`} aria-labelledby={label}>
      <div className="cw-panel-head">
        <h3 id={label}>{title}</h3>
        {link && <Link to={link.to}>{link.label} →</Link>}
      </div>
      {sub && <p className="cw-panel-sub">{sub}</p>}
      {children}
    </section>
  )
}

function Waiting({ d }: { d: Data }) {
  const items = [
    ...d.pendingResponses.map((r) => ({ key: `r-${r.id}`, kind: 'Action', title: r.title, meta: `${r.blastRadius.devices} devices · ${r.blastRadius.users} users`, at: r.createdAt, link: <Link to="/app/approvals/$id" params={{ id: r.id }}>{r.title}</Link> })),
    ...d.pendingQueries.map((q) => ({ key: `q-${q.id}`, kind: 'Query', title: q.huntTitle, meta: `${q.target === 'defender' ? 'Defender' : 'Sentinel'} search to review`, at: q.createdAt, link: <Link to="/app/hunts/$huntId" params={{ huntId: q.huntId }}>{q.huntTitle}</Link> })),
  ]
  return (
    <Panel label="p-waiting" span="cw-span-5" title="Waiting for a decision" sub="Nothing runs until a person says yes. Approvers decide actions; anyone can review a search." link={{ to: '/app/approvals', label: 'Approvals' }}>
      {items.length === 0 ? (
        <p className="cw-empty">Nothing is waiting. When an agent or analyst proposes a search or an action, it appears here.</p>
      ) : (
        <ul className="cw-list">
          {items.map((i) => (
            <li key={i.key}>
              <span className="cw-badge" data-tone={i.kind === 'Action' ? 'warn' : 'accent'}>
                {i.kind}
              </span>
              <span className="cw-list-title">{i.link}</span>
              <span className="cw-list-side">{fmtAgo(i.at)}</span>
              <span className="cw-list-meta">{i.meta}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}

function Emerging({ d }: { d: Data }) {
  return (
    <Panel
      label="p-emerging"
      span="cw-span-7"
      title="Emerging threats"
      sub={<>Live incidents from pwn.watch, most severe first. These are world events, not necessarily in your environment.</>}
      link={{ to: '/app/watches', label: 'Watch one' }}
    >
      {d.emerging.length === 0 ? (
        <p className="cw-empty">No incidents yet. The worker fetches pwn.watch every hour.</p>
      ) : (
        <ul className="cw-list">
          {d.emerging.map((i) => (
            <li key={i.slug}>
              <SeverityTag value={i.severity} />
              <span className="cw-list-title">
                <a href={i.url} target="_blank" rel="noreferrer noopener">
                  {i.title}
                </a>
              </span>
              <span className="cw-list-side">{i.status === 'live' ? 'Live incident' : i.status ? `Status: ${i.status}` : 'Status not reported'}</span>
              <span className="cw-list-meta">
                {i.product && <span>{i.product}</span>}
                {i.cveIds.slice(0, 2).map((c) => (
                  <Link key={c} className="cw-chip" to="/app/intel/$key" params={{ key: c }}>
                    {c}
                  </Link>
                ))}
                <Freshness at={i.updatedAt} label="feed updated" />
                <Link to="/app/hunts" search={{ title: `Hunt: ${i.title.slice(0, 150)}` }}>
                  Start hunt<span className="cw-sr-only"> for {i.title.slice(0, 80)}</span>
                </Link>
                <Link to="/app/chat" search={{ agent: 'intel', q: `Does "${i.title.slice(0, 300)}"${i.cveIds.length ? ` (${i.cveIds.slice(0, 3).join(', ')})` : ''} affect us? Check our watch list and say what to look for.` }}>
                  Ask Intel<span className="cw-sr-only"> about {i.title.slice(0, 80)}</span>
                </Link>
              </span>
            </li>
          ))}
        </ul>
      )}
      {d.changes.length > 0 && (
        <details className="cw-panel-body">
          <summary>Latest updates to these incidents ({d.changes.length})</summary>
          <ul className="cw-list cw-mt-xs">
            {d.changes.map((c) => (
              <li key={c.id} data-plain>
                <span className="cw-list-title">{c.url ? <a href={c.url} target="_blank" rel="noreferrer noopener">{c.title}</a> : c.title}</span>
                <span className="cw-list-side">{c.date ?? ''}</span>
                {c.incidentTitle && <span className="cw-list-meta">{c.incidentTitle}</span>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </Panel>
  )
}

function WatchHits({ d }: { d: Data }) {
  const days = d.chartDays
  const byDay = new Map(d.hitsByDay.map((h) => [h.day, h.n]))
  const max = Math.max(1, ...days.map((day) => byDay.get(day) ?? 0))
  return (
    <Panel
      label="p-hits"
      span="cw-span-7"
      title="Your watch hits"
      sub={<>Feed items that mention something on your <Link to="/app/watches">watch list</Link> ({d.totals.watches} watches).</>}
      link={{ to: '/app/watches', label: 'All hits' }}
    >
      <p className="cw-panel-sub cw-m0">
        Watch hits per day (count), last 14 days, by {d.timeZone.replace('_', ' ')} calendar day. A grey bar means zero hits that day.
      </p>
      <div className="cw-spark" role="img" aria-label={`Watch hits per day for the last 14 days, oldest first: ${days.map((day) => byDay.get(day) ?? 0).join(', ')}`}>
        {days.map((day) => {
          const n = byDay.get(day) ?? 0
          return <span key={day} data-zero={n === 0 ? '' : undefined} style={{ height: `${Math.max(4, (n / max) * 100)}%` }} title={`${day}: ${n}`} />
        })}
      </div>
      <div className="cw-spark-axis" aria-hidden>
        <span>{days[0]}</span>
        <span>
          max {max} / day · today {byDay.get(days[days.length - 1]!) ?? 0}
        </span>
        <span>{days[days.length - 1]}</span>
      </div>
      {d.recentHits.length === 0 ? (
        <p className="cw-empty">
          No hits yet. <Link to="/app/watches">Add a watch</Link> for a vendor you use, such as Fortinet or Microsoft.
        </p>
      ) : (
        <ul className="cw-list">
          {d.recentHits.map((h) => (
            <li key={h.id}>
              <span className="cw-badge" data-tone={h.source.startsWith('demo:') ? 'demo' : undefined}>
                {h.source.replace(/^demo:/, '') === 'cisa-kev' ? 'CISA KEV' : 'pwn.watch'}
                {h.source.startsWith('demo:') ? ' · demo' : ''}
              </span>
              <span className="cw-list-title">{h.url ? <a href={h.url} target="_blank" rel="noreferrer noopener">{h.title}</a> : h.title}</span>
              <span className="cw-list-side">{fmtAgo(h.createdAt)}</span>
              <span className="cw-list-meta">
                <span>
                  matched {h.entryType} “{h.entryValue}”
                </span>
                <Link to="/app/hunts" search={{ fromHit: h.id, title: `Hunt: ${h.title.slice(0, 150)}` }}>
                  Start hunt<span className="cw-sr-only"> for {h.title.slice(0, 80)}</span>
                </Link>
                <Link to="/app/chat" search={{ agent: 'intel', q: `Is this relevant to us, and what should we check? "${h.title.slice(0, 300)}". It matched our watch on ${h.entryValue}.` }}>
                  Ask Intel<span className="cw-sr-only"> about {h.title.slice(0, 80)}</span>
                </Link>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}

function Kev({ d }: { d: Data }) {
  return (
    <Panel label="p-kev" span="cw-span-5" title="Newly exploited flaws" sub={<>Latest additions to the <Term k="kev">CISA KEV</Term> list ({d.totals.kevTotal} in total). Patch these first.</>}>
      {d.kev.length === 0 ? (
        <p className="cw-empty">No KEV records yet. The worker fetches the list every hour.</p>
      ) : (
        <ul className="cw-list">
          {d.kev.map((k) => (
            <li key={k.cveId}>
              <Link className="cw-chip" to="/app/intel/$key" params={{ key: k.cveId }}>
                {k.cveId}
              </Link>
              <span className="cw-list-title">{k.title ?? `${k.vendor ?? ''} ${k.product ?? ''}`}</span>
              <span className="cw-list-side">{k.addedAt ?? ''}</span>
              <span className="cw-list-meta">
                {[k.vendor, k.product].filter(Boolean).join(' · ')}
                {k.dueDate && <span>patch by {k.dueDate}</span>}
                {k.ransomware === 'Known' && (
                  <span className="cw-badge" data-tone="danger">
                    ransomware
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}

function Hunts({ d }: { d: Data }) {
  return (
    <Panel label="p-hunts" span="cw-span-7" title="Hunts" sub="Open investigations, and ones closed in the last 30 days." link={{ to: '/app/hunts', label: 'All hunts' }}>
      {d.openHunts.length + d.closedHunts.length === 0 ? (
        <p className="cw-empty">
          No hunts yet. Start one from a watch hit, or <Link to="/app/chat">ask Hunter</Link> to suggest one.
        </p>
      ) : (
        <ul className="cw-list">
          {d.openHunts.map((h) => (
            <li key={h.id}>
              <span className="cw-badge" data-tone="ok">
                open
              </span>
              <span className="cw-list-title">
                <Link to="/app/hunts/$huntId" params={{ huntId: h.id }}>
                  {h.title}
                </Link>
              </span>
              <span className="cw-list-side">{fmtAgo(h.updatedAt)}</span>
              {h.hypothesis && <span className="cw-list-meta">{h.hypothesis.slice(0, 140)}</span>}
            </li>
          ))}
          {d.closedHunts.map((h) => (
            <li key={h.id}>
              <span className="cw-badge">closed</span>
              <span className="cw-list-title">
                <Link to="/app/hunts/$huntId" params={{ huntId: h.id }}>
                  {h.title}
                </Link>
              </span>
              <span className="cw-list-side">{fmtAgo(h.updatedAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}

function Activity({ d }: { d: Data }) {
  return (
    <Panel label="p-activity" span="cw-span-5" title="Recent agent activity" sub="Every agent step is logged so you can see what happened and why." link={{ to: '/app/agents', label: 'Full log' }}>
      {d.agentActivity.length === 0 ? (
        <p className="cw-empty">
          No agent activity yet. Pick Lead, Hunter, Intel, Responder or Scribe in <Link to="/app/chat">chat</Link>.
        </p>
      ) : (
        <ul className="cw-list">
          {d.agentActivity.map((a) => (
            <li key={a.id} data-plain>
              <span className="cw-list-title">
                <strong>{a.actorType === 'agent' ? a.actor.charAt(0).toUpperCase() + a.actor.slice(1) : a.actorType === 'user' ? 'A person' : 'System'}</strong> · {ACTION_WORDS[a.action] ?? a.action.replace(/_/g, ' ')}
              </span>
              <span className="cw-list-side" title={fmtTime(a.createdAt)}>
                {fmtAgo(a.createdAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}


const ACTION_WORDS: Record<string, string> = {
  propose_kql: 'proposed a search',
  run_kql: 'approved and ran a search',
  reject_kql: 'rejected a search',
  schedule_kql: 'scheduled a repeat search',
  propose_response: 'proposed an action',
  delegate: 'handed work to another agent',
}
