import { Link, getRouteApi, useRouter } from '@tanstack/react-router'
import { fetchServerSentEvents, useChat } from '@tanstack/ai-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { fetchOlderMessages, fetchThread, type fetchThread as FetchThread } from '../../fns/chat'
import { cancelRunFn, fetchRuns } from '../../fns/agents'
import { isBudgetRefusal, plainMessage } from '../../shared/messages'
import { AGENT_KEYS, AGENT_LABELS, ORCHESTRATE_KEY, toAgentSelection, type AgentSelection } from '../../shared/agents'
import { useAction } from '../../components/action'
import { RunStatusTag, StopRunButton, useRunStatusPoll } from '../../components/runs'
import { Notice } from '../../components/ui'
import { currentActivity } from './activity'
import { MessageView } from './MessageView'
import { RUN_EVENT, SAVED_EVENT, agentName, appendNewer, isSavedReply, oldestStoredAt, prependOlder, savedTargetId, textOf, toUiMessages, withSaved, type Meta, type SavedReply } from './messages'

export type Loaded = NonNullable<Awaited<ReturnType<typeof FetchThread>>>

const chatRoute = getRouteApi('/app/chat')
const threadRoute = getRouteApi('/app/chat/$threadId')

// A draft survives leaving the thread and coming back (keyed per thread, this tab only).
const drafts = new Map<string, string>()

const STARTERS = [
  'What new threats affect the vendors on our watch list?',
  'Propose a search for suspicious sign-ins in the last 24 hours',
  'Explain the latest CISA KEV addition in plain English',
  'Summarise our open hunts',
]

/** Only the thread list, the conversation and the shell counts change after a reply. */
const AFTER_REPLY = new Set(['/app', '/app/chat', '/app/chat/$threadId'])

/**
 * One conversation. Mounted once per thread (#169): a finished reply never remounts it, so the
 * draft, scroll position, focus and open details stay. The server sends the stored message id in a
 * `crosswire:saved` event, which is merged into that reply in place.
 *
 * Leaving the page ends only this browser's stream (#128). The run finishes on the server and saves
 * its reply. Stop (the square button or "Stop run") asks the server to stop the run.
 *
 * Live regions (#167): the transcript is a labelled region, not `role="log"`, so streamed tokens are
 * never read out. One polite status line announces state changes: working (and the current step),
 * finished, stopped, or failed. A screen reader user hears each change once and reads the reply
 * itself with normal navigation. Errors use the Notice alert.
 */
export function ThreadChat({ data, threadId }: { data: Loaded; threadId: string }) {
  const router = useRouter()
  const [agent, setAgent] = useState<AgentSelection>(toAgentSelection(data.thread.agentKey))
  const prefill = threadRoute.useSearch().q
  const [input, setInputState] = useState(() => drafts.get(threadId) ?? (data.messages.length === 0 ? (prefill ?? '') : ''))
  const setInput = (v: string) => {
    drafts.set(threadId, v)
    setInputState(v)
  }
  const { runtime } = chatRoute.useLoaderData()
  const ready = runtime.configured
  // The first page only. Later loader reloads (titles, feedback) never replace the live messages.
  const [initialMessages] = useState(() => toUiMessages(data.messages))
  const [hasOlder, setHasOlder] = useState(data.hasMore)
  // Stored ids and run links from the server, by client message id.
  const [saved, setSaved] = useState<Record<string, SavedReply>>({})
  const [pendingSaved, setPendingSaved] = useState<SavedReply | null>(null)
  // The live run for this reply, from the stream's first event, so status and Stop are visible.
  const [liveRun, setLiveRun] = useState<{ id: string; agentKey: string } | null>(null)
  // A run that was still going when this page opened (the analyst left and came back).
  const [resumed, setResumed] = useState<{ id: string; agentKey: string } | null>(null)
  const [stopped, setStopped] = useState(false)
  const stopAction = useAction()
  const stopWanted = useRef(false)
  const older = useAction()
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const refreshAfterReply = () => {
    if (!alive.current) return
    void router.invalidate({ filter: (m) => AFTER_REPLY.has(m.routeId) }).catch(() => {})
  }

  const { messages, setMessages, sendMessage, reload, isLoading, error, stop } = useChat({
    connection: fetchServerSentEvents('/api/chat', { credentials: 'same-origin' }),
    threadId,
    initialMessages,
    forwardedProps: { agentKey: agent },
    onCustomEvent: (name, value) => {
      if (name === RUN_EVENT && value && typeof value === 'object') {
        const v = value as { runId?: string | null; agentKey?: string }
        const wanted = stopWanted.current
        stopWanted.current = false
        if (typeof v.runId === 'string') {
          setLiveRun({ id: v.runId, agentKey: v.agentKey ?? agent })
          if (wanted) requestStop(v.runId)
        } else if (wanted) {
          // No run record to stop (legacy ledger): closing the stream is what stops it.
          stop()
        }
      }
      if (name === SAVED_EVENT && isSavedReply(value)) setPendingSaved(value)
    },
    // The reply is already stored when the stream ends (the saved event comes first), so one
    // reload of titles and counts is enough. Nothing runs after this page has gone.
    onFinish: () => refreshAfterReply(),
  })

  // Attach the stored id to the reply it belongs to, once that reply is on screen.
  const target = pendingSaved ? savedTargetId(messages) : null
  if (pendingSaved && target) {
    setSaved((s) => ({ ...s, [target]: pendingSaved }))
    setPendingSaved(null)
  }

  // Did a run keep going while the analyst was away? Ask once, only when the thread ends on a question.
  useEffect(() => {
    if (initialMessages.at(-1)?.role !== 'user') return
    let live = true
    fetchRuns({ data: { threadId, status: 'running' } })
      .then((r) => {
        const root = r.runs.find((run) => !run.parentRunId)
        if (live && root) setResumed({ id: root.id, agentKey: root.agentKey })
      })
      .catch(() => {
        // Status is a nicety. The reply still appears on the next visit.
      })
    return () => {
      live = false
    }
  }, [threadId, initialMessages])
  const latest = useRef(messages)
  useEffect(() => {
    latest.current = messages
  })
  useRunStatusPoll(resumed ? { [resumed.id]: 'running' } : {}, () => {
    void (async () => {
      try {
        const t = await fetchThread({ data: { threadId } })
        if (!alive.current || !t) return
        setMessages(appendNewer(latest.current, toUiMessages(t.messages)))
      } catch {
        // The reply is stored; it shows on the next visit.
      } finally {
        if (alive.current) setResumed(null)
        refreshAfterReply()
      }
    })()
  })

  const working = isLoading || resumed !== null
  const run = isLoading ? liveRun : resumed
  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const beginTurn = () => {
    stopWanted.current = false
    setStopped(false)
    setLiveRun(null)
    setPendingSaved(null)
    stopAction.setError(null)
    pinned.current = true
  }

  const submit = (text = input) => {
    const t = text.trim()
    if (!t || working || !ready) return
    beginTurn()
    void sendMessage(t)
    if (text === input) setInput('')
  }

  // Resend the last question. The composer is not touched, and the server replaces the failed
  // attempt, so the question is never stored twice (#169).
  const retry = () => {
    if (working || !ready) return
    beginTurn()
    void reload()
  }

  // Stop asks the server to stop the run. The stream then ends on its own with what was written.
  // Pressed before the run id arrives (the first event), the stop is sent as soon as it does.
  const requestStop = (id: string) =>
    void stopAction.run('stop', async () => {
      const r = await cancelRunFn({ data: { runId: id } })
      if (r.ok && r.requested) setStopped(true)
      return r
    })
  const stopReply = () => {
    if (run?.id) requestStop(run.id)
    else if (isLoading) {
      stopWanted.current = true
      setStopped(true)
    }
  }

  const loadOlder = () =>
    void older.run('older', async () => {
      const before = oldestStoredAt(messages)
      if (!before) return
      const page = await fetchOlderMessages({ data: { threadId, before } })
      if (!alive.current) return
      const el = scroller.current
      const fromBottom = el ? el.scrollHeight - el.scrollTop : 0
      setMessages(prependOlder(toUiMessages(page.messages), latest.current))
      setHasOlder(page.hasMore)
      // Keep the reader's place: the new messages go above what they were reading.
      requestAnimationFrame(() => {
        if (el) el.scrollTop = el.scrollHeight - fromBottom
      })
    })

  // Follow the stream while the reader is at the bottom; stop following once they scroll up.
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [messages])

  // Autosize the composer up to a cap.
  useLayoutEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`
  }, [input])

  useEffect(() => inputRef.current?.focus(), [])

  const last = messages[messages.length - 1]
  const lastUser = [...messages].reverse().find((m) => m.role === 'user')
  const streamingId = isLoading && last?.role === 'assistant' ? last.id : null
  const who = agentName(run?.agentKey ?? agent)
  // What the agent is doing right now, from the newest tool call in the streaming reply.
  const activity = isLoading ? currentActivity(last) : null
  const announce = working
    ? `${who} is working${activity ? `: ${activity}` : ''}.`
    : stopped
      ? 'You stopped the reply.'
      : error
        ? `${who} could not reply.`
        : last?.role === 'assistant' && saved[last.id]
          ? `${agentName((last.metadata as Meta | undefined)?.agentKey ?? agent)} finished replying.`
          : ''
  const title = data.thread.title === 'New thread' ? (messages[0]?.role === 'user' ? textOf(messages[0]).replace(/\s+/g, ' ').slice(0, 60) : 'New conversation') : data.thread.title

  return (
    <section className="cw-convo" aria-labelledby="thread-title">
      <header className="cw-convo-head">
        <h1 id="thread-title">{title}</h1>
        <label className="cw-inline">
          <span>Talk to</span>
          <select value={agent} onChange={(e) => setAgent(toAgentSelection(e.target.value))} disabled={working}>
            {AGENT_KEYS.map((k) => (
              <option key={k} value={k}>
                {AGENT_LABELS[k].name}
              </option>
            ))}
            <option value={ORCHESTRATE_KEY}>Lead with the whole team</option>
          </select>
        </label>
      </header>

      <p className="cw-sr-only" role="status" aria-live="polite">
        {announce}
      </p>
      {working && (
        <div className="cw-livebar">
          <span className="cw-livebar-dot" aria-hidden="true" />
          <span>
            <strong>{who}</strong> is working{activity ? <> · {activity}</> : null}
            {resumed && <span className="cw-muted"> · this page updates when the reply is ready</span>}
          </span>
          {run && <RunStatusTag status="running" />}
          <span className="cw-spacer" />
          {run && (
            <Link to="/app/agents" search={{ view: 'runs', run: run.id }} className="cw-btn" data-variant="quiet" data-size="sm">
              Watch the steps
            </Link>
          )}
          {run && <StopRunButton runId={run.id} target={`${who}'s reply`} refresh={false} onStopped={() => setStopped(true)} />}
        </div>
      )}
      {stopAction.error && (
        <Notice tone="error" title="The reply did not stop">
          {stopAction.error}
        </Notice>
      )}

      <div
        ref={scroller}
        className="cw-convo-scroll"
        role="region"
        aria-label="Conversation"
        aria-busy={isLoading}
        tabIndex={0}
        onScroll={(e) => {
          const el = e.currentTarget
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
        }}
      >
        <div className="cw-convo-inner">
          {hasOlder && (
            <div className="cw-convo-older">
              <p className="cw-help">Showing the latest {messages.length.toLocaleString('en-AU')} messages. Older ones are not shown.</p>
              <button type="button" className="cw-btn" data-variant="ghost" data-size="sm" disabled={older.busy !== null || isLoading} onClick={loadOlder}>
                {older.busy ? 'Loading…' : 'Load older messages'}
              </button>
              {older.error && (
                <span className="cw-field-error" role="alert">
                  {older.error}
                </span>
              )}
            </div>
          )}
          {messages.length === 0 && (
            <div className="cw-convo-empty">
              <h2>What would you like to know?</h2>
              <p className="cw-muted">Ask {agentName(agent)} in plain English, or start with one of these.</p>
              <ul className="cw-prompts" aria-label="Suggested questions">
                {STARTERS.map((s) => (
                  <li key={s}>
                    <button type="button" disabled={!ready} onClick={() => submit(s)}>
                      {s}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {messages.map((m) => {
            const meta = withSaved((m.metadata ?? {}) as Meta, saved[m.id], agent)
            return <MessageView key={m.id} message={m} meta={meta} fallbackAgent={agent} streaming={m.id === streamingId} rating={data.feedback[meta.persistedId ?? '']} />
          })}
          {working && last?.role === 'user' && (
            <div className="cw-turn" data-role="assistant">
              <div className="cw-turn-who">{who}</div>
              <p className="cw-thinking">
                <span className="cw-dots" aria-hidden>
                  <i />
                  <i />
                  <i />
                </span>
                {activity ?? 'Reading your question…'}
              </p>
            </div>
          )}
          {stopped && !working && !error && (
            <p className="cw-turnnote" role="note">
              You stopped this reply. What was written so far is kept. Ask again to continue.
            </p>
          )}
          {error && (
            <Notice tone={isBudgetRefusal(error.message) ? 'warn' : 'error'} title={isBudgetRefusal(error.message) ? 'The agent did not run' : 'The agent could not reply'}>
              {plainMessage(error.message)}{' '}
              {lastUser && (
                <button type="button" className="cw-linkbtn" disabled={working || !ready} onClick={retry}>
                  Try again
                </button>
              )}
            </Notice>
          )}
        </div>
      </div>

      <form
        className="cw-composer2"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <div className="cw-composer2-box">
          <label htmlFor="chat-input" className="cw-sr-only">
            Message to {agentName(agent)}
          </label>
          <textarea
            id="chat-input"
            ref={inputRef}
            rows={1}
            disabled={!ready}
            aria-describedby="chat-input-help"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={`Message ${agentName(agent)}`}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                submit()
              }
            }}
          />
          {working ? (
            <button className="cw-sendbtn" type="button" onClick={stopReply} disabled={stopAction.busy !== null} aria-busy={stopAction.busy !== null || undefined}>
              <span aria-hidden>■</span>
              <span className="cw-sr-only">{stopAction.busy ? 'Stopping reply' : 'Stop reply'}</span>
            </button>
          ) : (
            <button className="cw-sendbtn" type="submit" disabled={!input.trim() || !ready}>
              <span aria-hidden>↑</span>
              <span className="cw-sr-only">Send</span>
            </button>
          )}
        </div>
        <p id="chat-input-help" className="cw-help">
          {!ready
            ? 'Chat is not set up, so new messages are turned off. You can still read this conversation.'
            : working
              ? 'You can leave this page. The reply keeps going and is saved here. Use Stop to end it.'
              : 'Enter to send, Shift+Enter for a new line. Agents can be wrong: check sources before acting. Nothing runs in your tenant without an approver.'}
        </p>
      </form>
    </section>
  )
}
