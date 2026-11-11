import { Link, useRouter } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { cancelRunFn, fetchRunStatus } from '../fns/agents'
import { AGENT_LABELS, isAgentKey } from '../shared/agents'
import { useAction } from './action'
import { ConfirmDialog } from './confirm'
import { fmtTime, fmtUsd, humanise } from './format'

/**
 * Agent run primitives: status tag, duration and token formatting, a Stop control and the
 * delegation tree. Redaction happens on the server before anything here receives a body.
 */

export type RunStatus = 'running' | 'completed' | 'failed' | 'interrupted'

const RUN_WORD: Record<RunStatus, string> = { running: 'Running', completed: 'Completed', failed: 'Failed', interrupted: 'Stopped' }
const RUN_TONE: Record<RunStatus, string> = { running: 'info', completed: 'ok', failed: 'danger', interrupted: 'warn' }

export function isRunStatus(status: string): status is RunStatus {
  return status in RUN_WORD
}

/** Word and tone for a run status. An unknown status gets a neutral tone on purpose, and plain words. */
export function runStatusView(status: string): { word: string; tone: string | undefined } {
  if (isRunStatus(status)) return { word: RUN_WORD[status], tone: RUN_TONE[status] }
  warnUnknown('run status', status)
  return { word: humanise(status), tone: undefined }
}

export function RunStatusTag({ status }: { status: string }) {
  const { word, tone } = runStatusView(status)
  return (
    <span className="cw-badge cw-runstatus" data-tone={tone} data-status={status}>
      {word}
    </span>
  )
}

export function agentLabel(key: string) {
  return isAgentKey(key) ? AGENT_LABELS[key].name : key
}

/** "850 ms", "12.3 s", "1 min 5 s". Whole seconds once over a minute, so 119.6 s is "2 min 0 s", never "1 min 60 s". */
export function fmtDuration(ms: number | null) {
  if (ms === null) return 'still running'
  if (ms < 1000) return `${ms} ms`
  const tenths = Math.round(ms / 100)
  if (tenths < 600) return `${(tenths / 10).toFixed(1)} s`
  const secs = Math.round(ms / 1000)
  return `${Math.floor(secs / 60)} min ${secs % 60} s`
}

export function fmtTokens(n: number | null) {
  return n === null ? 'not measured' : n.toLocaleString('en-AU')
}

/** Run cost in US dollars, to four places (one run is often under a cent). */
export function fmtCost(micros: number | null, rateSet: boolean) {
  if (!rateSet || micros === null) return 'unpriced'
  return fmtUsd(micros, 4)
}

const warned = new Set<string>()
/** In development, name a kind the server sent that has no label yet, once, so it gets one. */
function warnUnknown(what: string, kind: string) {
  if (!import.meta.env?.DEV || warned.has(`${what}:${kind}`)) return
  warned.add(`${what}:${kind}`)
  console.warn(`[crosswire] no label for ${what} "${kind}". Add one in components/runs.tsx.`)
}

/** Plain words for run event kinds. Unknown kinds are humanised (and logged in development). */
export const EVENT_WORD: Record<string, string> = {
  started: 'Started',
  budget_estimate: 'Checked the budget',
  cancel_requested: 'Stop requested',
  completed: 'Completed',
  failed: 'Failed',
  interrupted: 'Stopped',
}

export const OUTPUT_WORD: Record<string, string> = {
  assistant: 'Reply',
  routing: 'Model routing',
  error: 'Error',
}

export function eventLabel(kind: string) {
  if (EVENT_WORD[kind]) return EVENT_WORD[kind]
  warnUnknown('run event', kind)
  return humanise(kind)
}

export function outputLabel(kind: string) {
  if (OUTPUT_WORD[kind]) return OUTPUT_WORD[kind]
  const tool = kind.match(/^tool:([^:]+)(:error)?$/)
  if (tool) return `${tool[2] ? 'Tool failed' : 'Tool'}: ${tool[1]}`
  warnUnknown('run output', kind)
  return humanise(kind)
}

/**
 * Stop a running run. Asks for confirmation (one click never stops work), with focus on
 * "Keep running", then reports the outcome. The server decides who may stop it; a refusal is
 * shown in plain words. `target` names the run in the confirmation ("the Intel run").
 */
export function StopRunButton({ runId, target = 'this run', onStopped, size = 'sm', refresh = true }: { runId: string; target?: string; onStopped?: () => void; size?: 'sm' | 'md'; refresh?: boolean }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const action = useAction()
  const stop = async () => {
    setMsg(null)
    const r = await action.run('stop', () => cancelRunFn({ data: { runId } }))
    if (!r || !r.ok) return
    setOpen(false)
    if (r.requested) {
      setMsg('Stop requested. The run stops shortly.')
      // Only a real stop marks the reply as stopped; a finished or refused run does not.
      onStopped?.()
    } else setMsg(`Nothing to stop. This run already ${r.status === 'interrupted' ? 'stopped' : r.status}.`)
    // In chat the stream itself ends when the server stops the run, so no reload is needed there.
    if (refresh) await router.invalidate().catch(() => {})
  }
  return (
    <span className="cw-stopctl">
      <button
        type="button"
        className="cw-btn"
        data-variant="ghost"
        data-size={size === 'sm' ? 'sm' : undefined}
        onClick={() => {
          action.setError(null)
          setOpen(true)
        }}
      >
        Stop run
      </button>
      <ConfirmDialog
        open={open}
        tone="danger"
        title={`Stop ${target}?`}
        body={<p>The agent stops where it is. What it has written so far is kept, and the run is marked Stopped.</p>}
        confirmLabel="Yes, stop it"
        cancelLabel="Keep running"
        busy={action.busy !== null}
        error={action.error}
        onCancel={() => setOpen(false)}
        onConfirm={() => void stop()}
      />
      <span className="cw-help" role="status">
        {msg ?? ''}
      </span>
    </span>
  )
}

/** True when a polled run has a different status from the one on screen, or has gone. */
export function runStatusChanged(known: Record<string, string>, fresh: Array<{ id: string; status: string }>) {
  const seen = new Map(fresh.map((r) => [r.id, r.status]))
  return Object.entries(known).some(([id, status]) => seen.get(id) !== status)
}

/**
 * Poll the status of a few live runs (one small request per interval, #170) and call `onChange`
 * once when any of them changes. Pauses while the tab is hidden and checks again when it is shown.
 * `known` maps run id to the status on screen; pass an empty object to stop polling.
 */
export function useRunStatusPoll(known: Record<string, string>, onChange: (fresh: Array<{ id: string; status: string; cancelRequested: boolean }>) => void, intervalMs = 2000) {
  const key = Object.entries(known)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, status]) => `${id}:${status}`)
    .join(',')
  const changed = useRef(onChange)
  useEffect(() => {
    changed.current = onChange
  })
  useEffect(() => {
    if (!key) return
    const current: Record<string, string> = Object.fromEntries(key.split(',').map((pair) => pair.split(':') as [string, string]))
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const schedule = () => {
      clearTimeout(timer)
      if (live && document.visibilityState === 'visible') timer = setTimeout(poll, intervalMs)
    }
    const poll = async () => {
      try {
        const r = await fetchRunStatus({ data: { runIds: Object.keys(current) } })
        if (!live) return
        if (runStatusChanged(current, r.runs)) {
          live = false
          changed.current(r.runs)
          return
        }
      } catch {
        // A missed poll retries on the next tick.
      }
      schedule()
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') void poll()
      else clearTimeout(timer)
    }
    document.addEventListener('visibilitychange', onVisible)
    schedule()
    return () => {
      live = false
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [key, intervalMs])
}

type TreeRun = { id: string; agentKey: string; status: string; startedAt: string; durationMs: number | null }

/** Delegation: the parent run, this run, and the specialists it asked. Each links to its own view. */
export function RunTree({ parent, run, children }: { parent: TreeRun | null; run: TreeRun; children: TreeRun[] }) {
  const node = (r: TreeRun, current: boolean) => (
    <span className="cw-runnode" aria-current={current ? 'true' : undefined}>
      {current ? <strong>{agentLabel(r.agentKey)}</strong> : (
        <Link to="/app/agents" search={{ view: 'runs', run: r.id }}>
          {agentLabel(r.agentKey)}
        </Link>
      )}
      <RunStatusTag status={r.status} />
      <span className="cw-muted num">{fmtDuration(r.durationMs)}</span>
      <time className="cw-muted" dateTime={r.startedAt}>
        {fmtTime(r.startedAt)}
      </time>
    </span>
  )
  const mine = (
    <li>
      {node(run, true)}
      {children.length > 0 && (
        <ul aria-label="Specialists asked">
          {children.map((c) => (
            <li key={c.id}>{node(c, false)}</li>
          ))}
        </ul>
      )}
    </li>
  )
  return (
    <ul className="cw-runtree" aria-label="Delegation">
      {parent ? (
        <li>
          {node(parent, false)}
          <ul>{mine}</ul>
        </li>
      ) : (
        mine
      )}
    </ul>
  )
}
