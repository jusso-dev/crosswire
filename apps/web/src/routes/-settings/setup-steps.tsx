import { useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { fetchSetupState, restoreSetupFn } from '../../fns/setup'
import { useAction } from '../../components/action'

/** "Show setup steps again" (#165): brings back the control panel checklist hidden earlier. */
export function SetupSteps({ data }: { data: Awaited<ReturnType<typeof fetchSetupState>> }) {
  const router = useRouter()
  const { run, busy, error } = useAction()
  const [done, setDone] = useState<string | null>(null)
  const hidden = data.dismissed || data.hiddenForMe
  return (
    <>
      <p className="cw-m0">
        {!hidden
          ? 'The setup steps are showing on the control panel.'
          : data.dismissed
            ? data.isOwner
              ? 'An owner hid the setup steps for everyone.'
              : 'An owner hid the setup steps for everyone. Ask an owner to show them again.'
            : 'You hid the setup steps on the control panel.'}
      </p>
      {hidden && (data.isOwner || !data.dismissed) && (
        <div className="cw-row cw-mt-xs">
          <button
            type="button"
            className="cw-btn"
            data-variant="ghost"
            disabled={Boolean(busy)}
            aria-busy={Boolean(busy) || undefined}
            onClick={async () => {
              setDone(null)
              const r = await run('restore', () => restoreSetupFn())
              if (!r) return
              setDone(r.forEveryone ? 'The setup steps show again for everyone.' : 'The setup steps show again for you.')
              await router.invalidate()
            }}
          >
            {busy ? 'Working…' : 'Show setup steps again'}
          </button>
        </div>
      )}
      {error && (
        <p className="cw-field-error" role="alert">
          {error}
        </p>
      )}
      <p className="cw-help cw-m0" role="status">
        {done ?? ''}
      </p>
    </>
  )
}
