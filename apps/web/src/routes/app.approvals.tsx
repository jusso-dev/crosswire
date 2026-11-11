import { Outlet, createFileRoute } from '@tanstack/react-router'

/**
 * Approvals layout. It loads nothing itself: the inbox is the index child (`app.approvals.index.tsx`),
 * so opening one approval never fetches the whole inbox (#170).
 */
export const Route = createFileRoute('/app/approvals')({
  component: Outlet,
})
