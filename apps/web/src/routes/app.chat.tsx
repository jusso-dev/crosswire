import { Link, Outlet, createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { fetchThreads, newThread, removeThread } from '../fns/chat'
import { Notice, SkeletonPage } from '../components/ui'
import { plainMessage } from '../shared/messages'
import { getDisplayTimeZone } from '../components/format'

/**
 * Chat layout (ChatGPT-style): conversation list on the left grouped by recency, the conversation
 * on the right. Crosswire hosts the agents; the model is Azure OpenAI (ADR 0004).
 */
export const Route = createFileRoute('/app/chat')({
  loader: () => fetchThreads(),
  pendingComponent: () => <SkeletonPage label="Loading conversations" />,
  errorComponent: ({ error }) => (
    <Notice tone="error" title="Your conversations did not load">
      {plainMessage(error)} Refresh the page to try again.
    </Notice>
  ),
  component: ChatLayout,
})

type Thread = Awaited<ReturnType<typeof fetchThreads>>['threads'][number]

/** Calendar date (YYYY-MM-DD) in the app time zone. */
function dayOf(d: Date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: getDisplayTimeZone(), year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
}

/** Groups by calendar day in APP_TIMEZONE: Today, the previous 7 days, Older. */
function groupThreads(threads: Thread[]) {
  const today = dayOf(new Date())
  const daysAgo = (iso: string) => (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${dayOf(new Date(iso))}T00:00:00Z`)) / 86_400_000
  const groups: Array<[string, Thread[]]> = [
    ['Today', []],
    ['Previous 7 days', []],
    ['Older', []],
  ]
  for (const t of threads) {
    const d = daysAgo(t.updatedAt)
    groups[d <= 0 ? 0 : d <= 7 ? 1 : 2]![1].push(t)
  }
  return groups.filter(([, ts]) => ts.length)
}

function ChatLayout() {
  const { threads, runtime } = Route.useLoaderData()
  const navigate = useNavigate()
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const start = async () => {
    setBusy(true)
    setError(null)
    try {
      const t = await newThread({ data: {} })
      await router.invalidate()
      await navigate({ to: '/app/chat/$threadId', params: { threadId: t.id } })
    } catch (err) {
      setError(`Could not start a conversation: ${err instanceof Error ? err.message : String(err)}`)
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
          <p className="cw-help cw-m0">
            Model: {runtime.provider}
            {runtime.model ? ` · ${runtime.model}` : ''}
          </p>
        )}
        {error && (
          <p className="cw-field-error" role="alert">
            {error}
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
                            setError(null)
                            try {
                              await removeThread({ data: { threadId: t.id } })
                              setConfirm(null)
                              await router.invalidate()
                              await navigate({ to: '/app/chat' })
                            } catch (err) {
                              setError(`Could not delete “${t.title}”: ${err instanceof Error ? err.message : String(err)}. Try again.`)
                            }
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
