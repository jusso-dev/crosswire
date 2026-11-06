import { createFileRoute, notFound, useRouter } from '@tanstack/react-router'
import { fetchServerSentEvents, useChat, type UIMessage } from '@tanstack/ai-react'
import { useMemo, useState } from 'react'
import { fetchThread, sendFeedback } from '../fns/chat'
import { AGENT_KEYS, AGENT_LABELS, ORCHESTRATE_KEY, toAgentSelection, type AgentSelection } from '../shared/agents'

export const Route = createFileRoute('/app/chat/$threadId')({
  loader: async ({ params }) => {
    const t = await fetchThread({ data: { threadId: params.threadId } })
    if (!t) throw notFound()
    return t
  },
  component: Thread,
})

type Loaded = ReturnType<typeof Route.useLoaderData>

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
  if (key === ORCHESTRATE_KEY) return 'Lead (orchestrate)'
  return key && key in AGENT_LABELS ? AGENT_LABELS[key as keyof typeof AGENT_LABELS].name : 'Lead'
}

function Thread() {
  const data = Route.useLoaderData()
  const { threadId } = Route.useParams()
  // Remount per thread so useChat state never leaks between threads.
  // Remount when the persisted transcript changes (after a reply finishes and the loader reloads),
  // so new assistant messages pick up their persisted ids and show feedback buttons.
  return <ThreadChat key={`${threadId}:${data.messages.length}`} data={data} threadId={threadId} />
}

function ThreadChat({ data, threadId }: { data: Loaded; threadId: string }) {
  const router = useRouter()
  const [agent, setAgent] = useState<AgentSelection>(toAgentSelection(data.thread.agentKey))
  const [input, setInput] = useState('')
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

  const submit = () => {
    const text = input.trim()
    if (!text || isLoading) return
    void sendMessage(text)
    setInput('')
  }

  return (
    <section className="cw-transcript" aria-label={data.thread.title}>
      <div className="cw-messages" aria-live="polite">
        {messages.length === 0 && <p className="cw-empty">No messages yet. Ask {agentName(agent)} something.</p>}
        {messages.map((m) => (
          <MessageView key={m.id} message={m} rating={data.feedback[(m.metadata as { persistedId?: string } | undefined)?.persistedId ?? '']} />
        ))}
        {error && (
          <p className="cw-error" role="alert">
            {error.message}
          </p>
        )}
      </div>
      <form
        className="cw-composer"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <label>
          Agent
          <select value={agent} onChange={(e) => setAgent(toAgentSelection(e.target.value))}>
            {AGENT_KEYS.map((k) => (
              <option key={k} value={k}>
                {AGENT_LABELS[k].name}
              </option>
            ))}
            <option value={ORCHESTRATE_KEY}>Lead (orchestrate squad)</option>
          </select>
        </label>
        <label style={{ flex: 1 }}>
          <span className="cw-sr-only">Message</span>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={`Message ${agentName(agent)}…`}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                submit()
              }
            }}
          />
        </label>
        {isLoading ? (
          <button className="cw-btn" data-variant="ghost" type="button" onClick={stop}>
            Stop
          </button>
        ) : (
          <button className="cw-btn" type="submit" disabled={!input.trim()}>
            Send
          </button>
        )}
      </form>
    </section>
  )
}

function MessageView({ message, rating }: { message: UIMessage; rating?: string }) {
  const meta = (message.metadata ?? {}) as { agentKey?: string | null; persistedId?: string; crosswire?: { tools?: Array<{ tool: string; error: string | null }> } }
  const [sent, setSent] = useState<string | undefined>(rating)
  const text = message.parts
    .filter((p) => p.type === 'text')
    .map((p) => (p as { content: string }).content)
    .join('')
  const tools = message.parts.filter((p) => p.type === 'tool-call') as Array<{ name: string; state?: string }>
  return (
    <article className="cw-msg" data-role={message.role}>
      <div className="cw-msg-meta">
        <span>{message.role === 'user' ? 'You' : agentName(meta.agentKey)}</span>
        {message.role === 'user' && meta.agentKey && <span>→ {agentName(meta.agentKey)}</span>}
        {[...tools.map((t) => t.name), ...(meta.crosswire?.tools?.map((t) => t.tool) ?? [])].map((name, i) => (
          <span key={`${name}-${i}`} className="cw-badge">
            tool: {name}
          </span>
        ))}
      </div>
      {text}
      {message.role === 'assistant' && meta.persistedId && (
        <div className="cw-row" style={{ marginTop: 8 }} aria-label="Feedback">
          {(['useful', 'wrong', 'escalate'] as const).map((r) => (
            <button
              key={r}
              type="button"
              className="cw-btn"
              data-variant={sent === r ? undefined : 'ghost'}
              aria-pressed={sent === r}
              onClick={async () => {
                await sendFeedback({ data: { messageId: meta.persistedId!, rating: r } })
                setSent(r)
              }}
            >
              {r}
            </button>
          ))}
        </div>
      )}
    </article>
  )
}
