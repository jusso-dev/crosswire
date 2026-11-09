import { Link, useRouter } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { cancelRunFn } from '../fns/agents'
import { AGENT_LABELS, isAgentKey } from '../shared/agents'
import { plainMessage } from '../shared/messages'
import { fmtTime } from './format'

/**
 * Agent run primitives: status tag, duration and token formatting, a Stop control and the
 * delegation tree. Redaction happens on the server before anything here receives a body.
 */

export type RunStatus = 'running' | 'completed' | 'failed' | 'interrupted'

const RUN_WORD: Record<RunStatus, string> = { running: 'Running', completed: 'Completed', failed: 'Failed', interrupted: 'Stopped' }
const RUN_TONE: Record<RunStatus, string | undefined> = { running: 'info', completed: 'ok', failed: 'danger', interrupted: 'warn' }

export function RunStatusTag({ status }: { status: string }) {
  const s = status as RunStatus
  return (
    <span className="cw-badge cw-runstatus" data-tone={RUN_TONE[s]} data-status={s}>
      {RUN_WORD[s] ?? status}
    </span>
  )
}

export function agentLabel(key: string) {
  return isAgentKey(key) ? AGENT_LABELS[key].name : key
}

export function fmtDuration(ms: number | null) {
  if (ms === null) return 'still running'
  if (ms < 1000) return `${ms} ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)} s`
  return `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`
}

export function fmtTokens(n: number | null) {
  return n === null ? 'not measured' : n.toLocaleString('en-AU')
}

export function fmtCost(micros: number | null, rateSet: boolean) {
  if (!rateSet || micros === null) return 'unpriced'
  return `$${(micros / 1_000_000).toFixed(4)}`
}

/** Plain words for run event kinds. Unknown kinds show their key. */
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

export function outputLabel(kind: string) {
  if (OUTPUT_WORD[kind]) return OUTPUT_WORD[kind]
  const tool = kind.match(/^tool:([^:]+)(:error)?$/)
  if (tool) return `${tool[2] ? 'Tool failed' : 'Tool'}: ${tool[1]}`
  return kind
}

/**
 * Stop a running run. Asks for confirmation (one click never stops work), then reports the outcome.
 * The server decides who may stop it; a refusal is shown in plain words.
 */
export function StopRunButton({ runId, onStopped, size = 'sm' }: { runId: string; onStopped?: () => void; size?: 'sm' | 'md' }) {
  const router = useRouter()
  const [stage, setStage] = useState<'idle' | 'confirm' | 'busy'>('idle')
  const [msg, setMsg] = useState<string | null>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (stage === 'confirm') confirmRef.current?.focus()
  }, [stage])
  return (
    <span className="cw-stopctl">
      {stage === 'idle' && (
        <button type="button" className="cw-btn" data-variant="ghost" data-size={size === 'sm' ? 'sm' : undefined} onClick={() => setStage('confirm')}>
          Stop run
        </button>
      )}
      {stage !== 'idle' && (
        <span className="cw-row" data-center role="group" aria-label="Confirm stop">
          <span className="cw-muted">Stop this run? Work so far is kept.</span>
          <button
            ref={confirmRef}
            type="button"
            className="cw-btn"
            data-variant="danger"
            data-size={size === 'sm' ? 'sm' : undefined}
            disabled={stage === 'busy'}
            onClick={async () => {
              setStage('busy')
              const r = await cancelRunFn({ data: { runId } })
              if (!r.ok) setMsg(plainMessage(r.error))
              else if (r.requested) setMsg('Stop requested. The run ends as Stopped within a second.')
              else setMsg(`Nothing to stop. This run already ${r.status === 'interrupted' ? 'stopped' : r.status}.`)
              setStage('idle')
              onStopped?.()
              await router.invalidate()
            }}
          >
            {stage === 'busy' ? 'Stopping…' : 'Yes, stop it'}
          </button>
          <button type="button" className="cw-btn" data-variant="quiet" data-size={size === 'sm' ? 'sm' : undefined} disabled={stage === 'busy'} onClick={() => setStage('idle')}>
            Keep running
          </button>
        </span>
      )}
      <span className="cw-help" role="status">
        {msg ?? ''}
      </span>
    </span>
  )
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
