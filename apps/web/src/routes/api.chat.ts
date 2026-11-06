import { createFileRoute } from '@tanstack/react-router'
import { handleChat } from '../server/chat/handler'

/** POST /api/chat: TanStack AI basic-chat SSE endpoint (#25). Session-guarded inside handleChat. */
export const Route = createFileRoute('/api/chat')({
  server: { handlers: { POST: ({ request }) => handleChat(request) } },
})
