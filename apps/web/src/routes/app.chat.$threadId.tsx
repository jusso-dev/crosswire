import { Link, createFileRoute, notFound } from '@tanstack/react-router'
import { z } from 'zod'
import { fetchThread } from '../fns/chat'
import { SkeletonPage } from '../components/ui'
import { RouteError, pageTitle } from '../components/errors'
import { ThreadChat } from './-chat/ThreadChat'

/**
 * One conversation, ChatGPT-style: centred transcript, markdown answers that stream token by token,
 * a sticky composer that grows with the text, stop/regenerate/copy, and auto-scroll that pauses
 * when the reader scrolls up. Streaming arrives over SSE (AG-UI) from Crosswire's agent runtime.
 * The view lives in `routes/-chat/` (#176).
 */
export const Route = createFileRoute('/app/chat/$threadId')({
  // ?q= prefills the composer (triage hand-off). It is never sent without the analyst pressing Send.
  validateSearch: z.object({ q: z.string().max(2000).optional() }),
  loader: async ({ params }) => {
    const t = await fetchThread({ data: { threadId: params.threadId } })
    if (!t) throw notFound()
    return t
  },
  pendingComponent: () => <SkeletonPage rows={3} label="Loading the conversation" />,
  errorComponent: ({ error }) => <RouteError error={error} title="This conversation did not load" />,
  notFoundComponent: () => (
    <div className="cw-center">
      <h1>Conversation not found</h1>
      <p className="cw-muted">It may have been deleted, or it belongs to someone else. Conversations are private to the person who started them.</p>
      <Link to="/app/chat" className="cw-btn">
        Back to chat
      </Link>
    </div>
  ),
  head: ({ loaderData }) => ({ meta: [{ title: pageTitle(loaderData?.thread.title || 'Conversation') }] }),
  component: Thread,
})

function Thread() {
  const data = Route.useLoaderData()
  const { threadId } = Route.useParams()
  // One mount per thread (#169). A finished reply patches ids in place, so this never remounts
  // mid-conversation, and useChat state never leaks between threads.
  return <ThreadChat key={threadId} data={data} threadId={threadId} />
}
