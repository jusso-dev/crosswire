import { Link, Outlet, createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { fetchThreads, newThread, removeThread } from '../fns/chat'
import { Notice } from '../components/ui'

/**
 * Chat layout (ChatGPT-style): conversation list on the left grouped by recency, the conversation
 * on the right. Crosswire hosts the agents; the model is Azure OpenAI (ADR 0004).
 */
export const Route = createFileRoute('/app/chat')({
  loader: () => fetchThreads(),
  pendingComponent: () => <p className="cw-muted">Loading conversations…</p>,
  errorComponent: ({ error }) => (
    <Notice tone="error" title="Could not load conversations">
      {error instanceof Error ? error.message : String(error)}
    </Notice>
  ),
  component: ChatLayout,
})

type Thread = Awaited<ReturnType<typeof fetchThreads>>['threads'][number]

function groupThreads(threads: Thread[]) {
  const now = Date.now()
  const DAY = 86_400_000
  const groups: Array<[string, Thread[]]> = [
    ['Today', []],
    ['Previous 7 days', []],
    ['Older', []],
  ]
  for (const t of threads) {
    const age = now - new Date(t.updatedAt).getTime()
    groups[age < DAY ? 0 : age < 7 * DAY ? 1 : 2]![1].push(t)
  }
  return groups.filter(([, ts]) => ts.length)
}

function ChatLayout() {
  const { threads, runtime } = Route.useLoaderData()
  const navigate = useNavigate()
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState<string | null>(null)
  const start = async () => {
    setBusy(true)
    try {
      const t = await newThread({ data: {} })
      await router.invalidate()
      await navigate({ to: '/app/chat/$threadId', params: { threadId: t.id } })
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="cw-chat">
      <nav className="cw-threads" aria-label="Conversations">
        <button className="cw-btn" type="button" data-block disabled={busy || !runtime.configured} onClick={start}>
          {busy ? 'Starting…' : 'New conversation'}
        </button>
        {runtime.configured && (
          <p className="cw-help" style={{ margin: 0 }}>
            Model: {runtime.provider}
            {runtime.model ? ` · ${runtime.model}` : ''}
          </p>
        )}
        {threads.length === 0 ? (
          <p className="cw-empty">No conversations yet.</p>
        ) : (
          groupThreads(threads).map(([label, ts]) => (
            <div key={label} className="cw-thread-group">
              <h2 className="cw-navgroup-label">{label}</h2>
              <ul>
                {ts.map((t) => (
                  <li key={t.id} className="cw-thread-item">
                    <Link to="/app/chat/$threadId" params={{ threadId: t.id }} title={t.title}>
                      {t.title}
                    </Link>
                    {confirm === t.id ? (
                      <span className="cw-thread-confirm">
                        <button
                          type="button"
                          className="cw-btn"
                          data-variant="danger"
                          data-size="sm"
                          autoFocus
                          onClick={async () => {
                            await removeThread({ data: { threadId: t.id } })
                            setConfirm(null)
                            await router.invalidate()
                            await navigate({ to: '/app/chat' })
                          }}
                        >
                          Delete<span className="cw-sr-only"> {t.title}</span>
                        </button>
                        <button type="button" className="cw-btn" data-variant="quiet" data-size="sm" onClick={() => setConfirm(null)}>
                          Cancel
                        </button>
                      </span>
                    ) : (
                      <button type="button" className="cw-iconbtn cw-thread-del" onClick={() => setConfirm(t.id)}>
                        <span aria-hidden>✕</span>
                        <span className="cw-sr-only">Delete conversation {t.title}</span>
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </nav>
      <div className="cw-chat-main">
        {!runtime.configured && (
          <Notice tone="warn" title="Chat is not set up">
            Chat needs an Azure OpenAI deployment. {runtime.isOwner ? 'Set MODEL_PROVIDER=azure, AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_DEPLOYMENT on the server (docs/chat-model.md).' : 'Ask an owner to set it up.'}
          </Notice>
        )}
        <Outlet />
      </div>
    </div>
  )
}
