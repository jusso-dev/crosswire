import { getRouteApi, useNavigate } from '@tanstack/react-router'

/**
 * Shared handles for the Agents page views (#176). The route itself lives in `app.agents.tsx`;
 * each view reads search, context and loader data through this API so the files stay apart.
 */
export const agentsRoute = getRouteApi('/app/agents')

export type AgentsSearch = ReturnType<typeof agentsRoute.useSearch>

/** Patch the page's search params in place (replace, so Back leaves the page, not each filter). */
export function useSetSearch() {
  const navigate = useNavigate({ from: '/app/agents' })
  return (patch: Partial<AgentsSearch>) => navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true })
}
