import { Link, createFileRoute, getRouteApi, notFound, useRouter } from '@tanstack/react-router'
import { fetchServerSentEvents, useChat, type UIMessage } from '@tanstack/ai-react'
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { fetchThread, sendFeedback } from '../fns/chat'
import { AGENT_KEYS, AGENT_LABELS, ORCHESTRATE_KEY, toAgentSelection, type AgentSelection } from '../shared/agents'
import { Notice } from '../components/ui'

/**
 * One conversation, ChatGPT-style: centred transcript, markdown answers that stream token by token,
 * a sticky composer that grows with the text, stop/regenerate/copy, and auto-scroll that pauses
 * when the reader scrolls up. Streaming arrives over SSE (AG-UI) from Crosswire's agent runtime.
 */
export const Route = createFileRoute('/app/chat/$threadId')({
  loader: async ({ params }) => {
    const t = await fetchThread({ data: { threadId: params.threadId } })
    if (!t) throw notFound()
    return t
  },
  pendingComponent: () => <p className="cw-muted">Loading conversation…</p>,
  notFoundComponent: () => (
    <div>
      <h1>Conversation not found</h1>
      <p className="cw-muted">It may have been deleted.</p>
      <Link to="/app/chat">Back to chat</Link>
    </div>
  ),
  component: Thread,
})

type Loaded = ReturnType<typeof Route.useLoaderData>
type Meta = { agentKey?: string | null; persistedId?: string; crosswire?: { tools?: Array<{ tool: string; error: string | null }>; error?: string | null } }

function toUiMessages(messages: Loaded['messages']): UIMessage[] {
  return messages.map((m: Loaded['messages'][number]) => ({
    id: m.id,
    role: m.role === 'user' ? 'user' : 'assistant',
    parts: [{ type: 'text', content: m.content }],
    createdAt: new Date(m.createdAt),
    metadata: { agentKey: m.agentKey, persistedId: m.id, crosswire: m.metadata },
  }))
}

function agentName(key: string | null | undefined) {
  if (key === ORCHESTRATE_KEY) return 'Lead (team)'
  return key && key in AGENT_LABELS ? AGENT_LABELS[key as keyof typeof AGENT_LABELS].name : 'Lead'
}

const TOOL_LABEL: Record<string, string> = {
  memory_search: 'Searched memory',
  remember: 'Saved to memory',
  search_intel: 'Searched threat intel',
  compare_cve: 'Compared sources',
  list_watch_hits: 'Read watch hits',
  get_hunt: 'Read a hunt',
  propose_kql: 'Proposed a search',
  list_sentinel_incidents: 'Read Sentinel incidents',
  propose_response: 'Proposed an action',
  delegate: 'Asked a specialist',
  delegate_parallel: 'Asked specialists',
}

const PENDING_LABEL: Record<string, string> = {
  memory_search: 'Searching memory',
  remember: 'Saving to memory',
  search_intel: 'Searching threat intel',
  compare_cve: 'Comparing sources',
  list_watch_hits: 'Reading watch hits',
  get_hunt: 'Reading a hunt',
  propose_kql: 'Proposing a search',
  list_sentinel_incidents: 'Reading Sentinel incidents',
  propose_response: 'Proposing an action',
  delegate: 'Asking a specialist',
  delegate_parallel: 'Asking specialists',
}

function textOf(m: UIMessage) {
  return m.parts
    .filter((p) => p.type === 'text')
    .map((p) => (p as { content: string }).content)
    .join('')
}

// Drafts typed while a reply streams survive the remount that follows it (keyed per thread).
const drafts = new Map<string, string>()

function Thread() {
  const data = Route.useLoaderData()
  const { threadId } = Route.useParams()
  // Remount per thread so useChat state never leaks between threads. After a reply finishes the
  // loader reloads; keying on the count lets new replies pick up persisted ids for feedback.
  return <ThreadChat key={`${threadId}:${data.messages.length}`} data={data} threadId={threadId} />
}

function ThreadChat({ data, threadId }: { data: Loaded; threadId: string }) {
  const router = useRouter()
  const [agent, setAgent] = useState<AgentSelection>(toAgentSelection(data.thread.agentKey))
  const [input, setInputState] = useState(() => drafts.get(threadId) ?? '')
  const setInput = (v: string) => {
    drafts.set(threadId, v)
    setInputState(v)
  }
  const { runtime } = getRouteApi('/app/chat').useLoaderData()
  const ready = runtime.configured
  const initialMessages = useMemo(() => toUiMessages(data.messages), [data.messages])
  const { messages, sendMessage, isLoading, error, stop } = useChat({
    connection: fetchServerSentEvents('/api/chat', { credentials: 'same-origin' }),
    threadId,
    initialMessages,
    forwardedProps: { agentKey: agent },
    onFinish: () => {
      // Reload so persisted ids (for feedback) and thread titles are fresh.
      void router.invalidate()
    },
  })
  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const submit = (text = input) => {
    const t = text.trim()
    if (!t || isLoading || !ready) return
    pinned.current = true
    void sendMessage(t)
    setInput('')
  }

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

  return (
    <section className="cw-convo" aria-labelledby="thread-title">
      <header className="cw-convo-head">
        <h1 id="thread-title">{data.thread.title === 'New thread' && messages[0]?.role === 'user' ? textOf(messages[0]).replace(/\s+/g, ' ').slice(0, 60) : data.thread.title === 'New thread' ? 'New conversation' : data.thread.title}</h1>
        <label className="cw-inline">
          <span>Talk to</span>
          <select value={agent} onChange={(e) => setAgent(toAgentSelection(e.target.value))} disabled={isLoading}>
            {AGENT_KEYS.map((k) => (
              <option key={k} value={k}>
                {AGENT_LABELS[k].name}
              </option>
            ))}
            <option value={ORCHESTRATE_KEY}>Lead with the whole team</option>
          </select>
        </label>
      </header>

      {/* One short announcement per reply; the streamed tokens themselves are not read out. */}
      <p className="cw-sr-only" role="status" aria-live="polite">
        {isLoading ? `${agentName(agent)} is replying.` : last?.role === 'assistant' ? `${agentName((last.metadata as Meta | undefined)?.agentKey)} replied.` : ''}
      </p>

      <div
        ref={scroller}
        className="cw-convo-scroll"
        role="log"
        aria-label="Conversation"
        aria-busy={isLoading}
        tabIndex={0}
        onScroll={(e) => {
          const el = e.currentTarget
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
        }}
      >
        <div className="cw-convo-inner">
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
          {messages.map((m) => (
            <MessageView key={m.id} message={m} fallbackAgent={agent} streaming={m.id === streamingId} rating={data.feedback[(m.metadata as Meta | undefined)?.persistedId ?? '']} />
          ))}
          {isLoading && last?.role === 'user' && (
            <div className="cw-turn" data-role="assistant">
              <div className="cw-turn-who">{agentName(agent)}</div>
              <p className="cw-thinking">
                <span className="cw-dots" aria-hidden>
                  <i />
                  <i />
                  <i />
                </span>
                Thinking…
              </p>
            </div>
          )}
          {error && (
            <Notice tone="error" title="The agent could not reply">
              {error.message}{' '}
              {lastUser && (
                <button type="button" className="cw-linkbtn" onClick={() => submit(textOf(lastUser))}>
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
          {isLoading ? (
            <button className="cw-sendbtn" type="button" onClick={stop}>
              <span aria-hidden>■</span>
              <span className="cw-sr-only">Stop reply</span>
            </button>
          ) : (
            <button className="cw-sendbtn" type="submit" disabled={!input.trim() || !ready}>
              <span aria-hidden>↑</span>
              <span className="cw-sr-only">Send</span>
            </button>
          )}
        </div>
        <p id="chat-input-help" className="cw-help">
          {ready ? 'Enter to send, Shift+Enter for a new line. Agents can be wrong: check sources before acting. Nothing runs in your tenant without an approver.' : 'Chat is not set up, so new messages are turned off. You can still read this conversation.'}
        </p>
      </form>
    </section>
  )
}

const MessageView = memo(function MessageView({ message, rating, streaming, fallbackAgent }: { message: UIMessage; rating?: string; streaming: boolean; fallbackAgent: AgentSelection }) {
  const meta = (message.metadata ?? {}) as Meta
  const [sent, setSent] = useState<string | undefined>(rating)
  const [copied, setCopied] = useState(false)
  const text = textOf(message)
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
  const liveTools = (message.parts.filter((p) => p.type === 'tool-call') as Array<{ id: string; name: string; state: string; output?: unknown }>).map((t) => {
    const r = results.get(t.id)
    const error = r?.state === 'error' ? (r.error ?? 'failed') : t.state === 'error' ? 'failed' : (failed(r?.content) ?? failed(t.output))
    const done = Boolean(r && r.state !== 'streaming') || t.state === 'complete' || t.state === 'error' || t.output !== undefined
    return { tool: t.name, error, pending: !done && !error }
  })
  const tools: Array<{ tool: string; error: string | null; pending?: boolean }> = liveTools.length ? liveTools : (meta.crosswire?.tools ?? [])
  const who = message.role === 'user' ? 'You' : agentName(meta.agentKey ?? fallbackAgent)

  if (message.role === 'user') {
    return (
      <article className="cw-turn" data-role="user" aria-label="You said">
        <div className="cw-bubble">{text}</div>
      </article>
    )
  }
  return (
    <article className="cw-turn" data-role="assistant" aria-label={`${who} said`}>
      <div className="cw-turn-who">{who}</div>
      {tools.length > 0 && (
        <ul className="cw-toolchips" aria-label="Steps taken">
          {tools.map((t, i) => (
            <li key={`${t.tool}-${i}`} data-error={t.error ? '' : undefined} data-pending={t.pending ? '' : undefined}>
              <span aria-hidden>{t.error ? '✕' : t.pending ? '…' : '✓'}</span> {t.pending ? (PENDING_LABEL[t.tool] ?? `Running ${t.tool}`) : (TOOL_LABEL[t.tool] ?? t.tool)}
              {t.error && <span className="cw-sr-only"> (failed)</span>}
            </li>
          ))}
        </ul>
      )}
      <div className="cw-md" data-streaming={streaming || undefined}>
        <Markdown
          remarkPlugins={[remarkGfm]}
          components={{
            a: ({ href, children }) => {
              // Internal links stay in the app; external links open in a new tab.
              const internal = href?.startsWith('/') || href?.startsWith(typeof window !== 'undefined' ? window.location.origin : '__')
              return internal ? (
                <a href={href}>{children}</a>
              ) : (
                <a href={href} target="_blank" rel="noreferrer noopener">
                  {children}
                  <span className="cw-sr-only"> (opens in a new tab)</span>
                </a>
              )
            },
          }}
        >
          {text || (streaming ? '' : '_(no text)_')}
        </Markdown>
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
                setTimeout(() => setCopied(false), 1500)
              } catch {
                setCopied(false)
              }
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
          {meta.persistedId && (
            <span role="group" aria-label="Rate this reply" className="cw-row" data-center style={{ gap: 2 }}>
              {(['useful', 'wrong', 'escalate'] as const).map((r) => (
                <button
                  key={r}
                  type="button"
                  className="cw-btn"
                  data-variant="quiet"
                  data-size="sm"
                  aria-pressed={sent === r}
                  onClick={async () => {
                    await sendFeedback({ data: { messageId: meta.persistedId!, rating: r } })
                    setSent(r)
                  }}
                >
                  {r === 'useful' ? 'Helpful' : r === 'wrong' ? 'Wrong' : 'Needs a human'}
                </button>
              ))}
            </span>
          )}
          <span className="cw-sr-only" role="status">
            {copied ? 'Copied to clipboard' : ''}
          </span>
        </div>
      )}
    </article>
  )
})

const STARTERS = [
  'What new threats affect the vendors on our watch list?',
  'Propose a search for suspicious sign-ins in the last 24 hours',
  'Explain the latest CISA KEV addition in plain English',
  'Summarise our open hunts',
]
