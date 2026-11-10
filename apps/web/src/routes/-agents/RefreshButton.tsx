import { useRouter } from '@tanstack/react-router'
import { useAction } from '../../components/action'

/** Reload the page's data. A failed reload says so and leaves the button usable (#159). */
export function RefreshButton() {
  const router = useRouter()
  const { run, busy, error } = useAction()
  return (
    <>
      <button type="button" className="cw-btn" data-variant="ghost" data-size="sm" disabled={busy !== null} aria-busy={busy !== null || undefined} onClick={() => void run('refresh', () => router.invalidate())}>
        {busy ? 'Refreshing…' : 'Refresh'}
      </button>
      {error && (
        <span className="cw-field-error" role="alert">
          Did not refresh. {error}
        </span>
      )}
    </>
  )
}
