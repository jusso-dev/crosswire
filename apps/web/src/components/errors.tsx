import { Link, useRouter } from '@tanstack/react-router'
import { plainMessage } from '../shared/messages'
import { Notice } from './ui'

/**
 * Route error boundary. Shows a plain sentence, never the raw server text, and a way forward.
 * The router uses it as the default for every route that does not set its own.
 */
export function RouteError({ error, title = 'This page did not load' }: { error: unknown; title?: string }) {
  const router = useRouter()
  return (
    <div className="cw-pad">
      <Notice tone="error" title={title}>
        {plainMessage(error)}{' '}
        <button type="button" className="cw-linkbtn" onClick={() => void router.invalidate()}>
          Try again
        </button>
        {' or '}
        <Link to="/app">go to the control panel</Link>.
      </Notice>
    </div>
  )
}

/** Browser tab title for a page: "Approvals · Crosswire". Keep values that identify a tenant out of it. */
export function pageTitle(...parts: Array<string | null | undefined>) {
  return [...parts.filter((p): p is string => Boolean(p && p.trim())).map((p) => (p.length > 60 ? `${p.slice(0, 57)}…` : p)), 'Crosswire'].join(' · ')
}
