import { Link, Outlet, createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import { fetchThreads, newThread } from '../fns/chat'

export const Route = createFileRoute('/app/chat')({
  loader: () => fetchThreads(),
  component: ChatLayout,
})

function ChatLayout() {
  const threads = Route.useLoaderData()
  const navigate = useNavigate()
  const router = useRouter()
  return (
    <div className="cw-chat">
      <nav className="cw-threads" aria-label="Threads">
        <button
          className="cw-btn"
          type="button"
          style={{ width: '100%', marginBottom: 8 }}
          onClick={async () => {
            const t = await newThread({ data: {} })
            await router.invalidate()
            await navigate({ to: '/app/chat/$threadId', params: { threadId: t.id } })
          }}
        >
          New thread
        </button>
        {threads.length === 0 && <p className="cw-empty">No threads yet.</p>}
        {threads.map((t) => (
          <Link key={t.id} to="/app/chat/$threadId" params={{ threadId: t.id }} title={t.title}>
            {t.title}
          </Link>
        ))}
      </nav>
      <Outlet />
    </div>
  )
}
