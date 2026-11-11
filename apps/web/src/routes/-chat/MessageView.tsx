import { Link } from '@tanstack/react-router'
import type { UIMessage } from '@tanstack/ai-react'
import { memo, useEffect, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { sendFeedback } from '../../fns/chat'
import { isBudgetRefusal, plainMessage } from '../../shared/messages'
import { isInternalHref } from '../../shared/links'
import type { AgentSelection } from '../../shared/agents'
import { useAction } from '../../components/action'
import { Notice } from '../../components/ui'
import { PENDING_LABEL, TOOL_LABEL, delegatesOf, joinNames } from './activity'
import { agentName, textOf, type Meta } from './messages'

/** A Markdown link: internal paths stay in the app; everything else opens in a new tab and says so. */
function MdLink({ href, children }: { href?: string; children?: React.ReactNode }) {
  const internal = isInternalHref(href, typeof window !== 'undefined' ? window.location.origin : undefined)
  return internal ? (
    <a href={href}>{children}</a>
  ) : (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
      <span className="cw-sr-only"> (opens in a new tab)</span>
    </a>
  )
}

const RATINGS = [
  ['useful', 'Helpful'],
  ['wrong', 'Wrong'],
  ['escalate', 'Needs a human'],
] as const

/** One turn of the conversation. `meta` already includes what the server stored for this reply. */
export const MessageView = memo(function MessageView({ message, meta, rating, streaming, fallbackAgent }: { message: UIMessage; meta: Meta; rating?: string; streaming: boolean; fallbackAgent: AgentSelection }) {
  const [sent, setSent] = useState<string | undefined>(rating)
  const [copied, setCopied] = useState(false)
  const feedback = useAction()
  const text = textOf(message)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(t)
  }, [copied])
  // Live tool calls: pending until a result arrives; failures come from the result (or an {error} output).
  const results = new Map(
    (message.parts.filter((p) => p.type === 'tool-result') as Array<{ toolCallId: string; state: string; content: unknown; error?: string }>).map((r) => [r.toolCallId, r]),
  )
  const failed = (content: unknown) => {
    try {
      const v = typeof content === 'string' ? JSON.parse(content) : content
      return v && typeof v === 'object' && 'error' in v ? String((v as { error: unknown }).error) : null
    } catch {
      return null
    }
  }
  const liveTools = (message.parts.filter((p) => p.type === 'tool-call') as Array<{ id: string; name: string; state: string; output?: unknown; arguments?: string; input?: unknown }>).map((t) => {
    const r = results.get(t.id)
    const error = r?.state === 'error' ? (r.error ?? 'failed') : t.state === 'error' ? 'failed' : (failed(r?.content) ?? failed(t.output))
    const done = Boolean(r && r.state !== 'streaming') || t.state === 'complete' || t.state === 'error' || t.output !== undefined
    return { tool: t.name, error, pending: !done && !error, asked: delegatesOf(t.name, t.input ?? t.arguments) }
  })
  const tools: Array<{ tool: string; error: string | null; pending?: boolean; asked?: string[] }> = liveTools.length ? liveTools : (meta.crosswire?.tools ?? [])
  const runId = meta.crosswire?.runId ?? null
  const failure = meta.crosswire?.error ?? null
  const who = message.role === 'user' ? 'You' : agentName(meta.agentKey ?? fallbackAgent)

  if (message.role === 'user') {
    return (
      <article className="cw-turn" data-role="user" aria-label="You said">
        <div className="cw-bubble">{text}</div>
      </article>
    )
  }
  const shownFailure = Boolean(failure && text.startsWith('⚠️'))
  return (
    <article className="cw-turn" data-role="assistant" aria-label={`${who} said`}>
      <div className="cw-turn-who">{who}</div>
      {tools.length > 0 && (
        <ul className="cw-toolchips" aria-label="Steps taken">
          {tools.map((t, i) => (
            <li key={`${t.tool}-${i}`} data-error={t.error ? '' : undefined} data-pending={t.pending ? '' : undefined}>
              <span aria-hidden>{t.error ? '✕' : t.pending ? '…' : '✓'}</span> {t.pending ? (PENDING_LABEL[t.tool] ?? `Running ${t.tool}`) : (TOOL_LABEL[t.tool] ?? t.tool)}
              {t.asked && t.asked.length > 0 && <>: {joinNames(t.asked)}</>}
              {t.error && <span className="cw-sr-only"> (failed)</span>}
            </li>
          ))}
        </ul>
      )}
      <div className="cw-md" data-streaming={streaming || undefined}>
        <Markdown remarkPlugins={[remarkGfm]} components={{ a: ({ href, children }) => <MdLink href={href}>{children}</MdLink> }}>
          {shownFailure ? '' : text || (streaming ? '' : '_(no text)_')}
        </Markdown>
        {shownFailure && (
          <Notice tone={isBudgetRefusal(failure) ? 'warn' : 'error'} title={isBudgetRefusal(failure) ? 'The agent did not run' : 'The agent could not finish'}>
            {plainMessage(failure)}
          </Notice>
        )}
      </div>
      {!streaming && text && (
        <div className="cw-turn-actions">
          <button
            type="button"
            className="cw-btn"
            data-variant="quiet"
            data-size="sm"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(text)
                setCopied(true)
              } catch {
                setCopied(false)
              }
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
          {meta.persistedId && (
            <span role="group" aria-label="Rate this reply" className="cw-row cw-gap-tight" data-center>
              {RATINGS.map(([r, label]) => (
                <button
                  key={r}
                  type="button"
                  className="cw-btn"
                  data-variant="quiet"
                  data-size="sm"
                  aria-pressed={sent === r}
                  disabled={feedback.busy !== null}
                  onClick={async () => {
                    const done = await feedback.run(r, () => sendFeedback({ data: { messageId: meta.persistedId!, rating: r } }))
                    if (done) setSent(r)
                  }}
                >
                  {feedback.busy === r ? 'Saving…' : label}
                </button>
              ))}
            </span>
          )}
          {runId && (
            <Link to="/app/agents" search={{ view: 'runs', run: runId }} className="cw-btn" data-variant="quiet" data-size="sm">
              Run and steps
            </Link>
          )}
          <span className="cw-sr-only" role="status">
            {copied ? 'Copied to clipboard' : ''}
          </span>
          {feedback.error && (
            <span className="cw-field-error" role="alert">
              Rating not saved. {feedback.error}
            </span>
          )}
        </div>
      )}
    </article>
  )
})
