import { Link, Outlet, createFileRoute, useMatchRoute, useNavigate, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { fetchThreads, newThread, removeThread } from '../fns/chat'
import { Notice, SkeletonPage } from '../components/ui'
import { plainMessage } from '../shared/messages'
import { getDisplayTimeZone } from '../components/format'
import { pageTitle } from '../components/errors'
import { useAction } from '../components/action'
import { ConfirmDialog } from '../components/confirm'

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
  head: () => ({ meta: [{ title: pageTitle('Conversations') }] }),
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
  const matchRoute = useMatchRoute()
  const start = useAction()
  const remove = useAction()
  const [confirm, setConfirm] = useState<Thread | null>(null)
  const startThread = () =>
    void start.run('start', async () => {
      const t = await newThread({ data: {} })
      await router.invalidate()
      await navigate({ to: '/app/chat/$threadId', params: { threadId: t.id } })
    })
  const deleteThread = async () => {
    const t = confirm
    if (!t) return
    const done = await remove.run('delete', async () => {
      await removeThread({ data: { threadId: t.id } })
      return true
    })
    if (!done) return
    setConfirm(null)
    // Leave the thread only if it was the one open.
    const open = matchRoute({ to: '/app/chat/$threadId', params: { threadId: t.id } })
    if (open) await navigate({ to: '/app/chat' })
    await router.invalidate().catch(() => {})
  }
  return (
    <div className="cw-chat">
      <nav className="cw-threads" aria-label="Conversations">
        <button className="cw-btn" type="button" data-block disabled={start.busy !== null || !runtime.configured} aria-busy={start.busy !== null || undefined} onClick={startThread}>
          {start.busy ? 'Starting…' : 'New conversation'}
        </button>
        {runtime.configured && (
          <p className="cw-help cw-m0">
            Model: {runtime.provider}
            {runtime.model ? ` · ${runtime.model}` : ''}
          </p>
        )}
        {start.error && (
          <p className="cw-field-error" role="alert">
            Could not start a conversation. {start.error}
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
                    <button
                      type="button"
                      className="cw-iconbtn cw-thread-del"
                      onClick={() => {
                        remove.setError(null)
                        setConfirm(t)
                      }}
                    >
                      <span aria-hidden>✕</span>
                      <span className="cw-sr-only">Delete conversation {t.title}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </nav>
      <ConfirmDialog
        open={confirm !== null}
        tone="danger"
        title={`Delete the conversation “${confirm?.title ?? ''}”?`}
        body={<p>Its messages and your ratings go with it. This cannot be undone. Agent runs and the decision log keep their own record.</p>}
        confirmLabel="Delete conversation"
        busy={remove.busy !== null}
        error={remove.error}
        onCancel={() => setConfirm(null)}
        onConfirm={() => void deleteThread()}
      />
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
