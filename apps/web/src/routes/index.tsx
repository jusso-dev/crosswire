import { createFileRoute, redirect } from '@tanstack/react-router'
import { fetchSession } from '../fns/session'

export const Route = createFileRoute('/')({
  beforeLoad: async () => {
    const s = await fetchSession()
    throw redirect({ to: s ? '/app' : '/sign-in' })
  },
})
