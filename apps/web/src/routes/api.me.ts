import { createFileRoute } from '@tanstack/react-router'
import { requireApiSession, jsonError } from '../server/auth/session'

/** GET /api/me: 401 JSON when signed out (#20). */
export const Route = createFileRoute('/api/me')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const s = await requireApiSession(request)
          return Response.json({ user: s.user, org: { id: s.org.id, name: s.org.name, role: s.org.role } })
        } catch (err) {
          return jsonError(err)
        }
      },
    },
  },
})
