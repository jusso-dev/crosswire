import { useCallback, useRef, useState } from 'react'
import { plainMessage } from '../shared/messages'

type Refusal = { ok: false; error?: string }

function isRefusal(r: unknown): r is Refusal {
  return typeof r === 'object' && r !== null && 'ok' in r && (r as { ok: unknown }).ok === false
}

/**
 * One way to run a server call from a button:
 * - a second press while the first is running does nothing (no double approvals or sign-ins);
 * - `busy` names what is running, so the pressed button can say "Working…" and siblings can disable;
 * - a thrown error or an `{ ok: false }` result becomes a plain-words `error`, never raw text;
 * - `busy` is always cleared, even when the call throws.
 * Returns the call's result, or undefined when it threw or was skipped.
 */
export function useAction() {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const running = useRef(false)

  const run = useCallback(async <T>(label: string, fn: () => Promise<T>): Promise<T | undefined> => {
    if (running.current) return undefined
    running.current = true
    setBusy(label)
    setError(null)
    try {
      const r = await fn()
      if (isRefusal(r)) setError(plainMessage(r.error ?? 'The server refused this step.'))
      return r
    } catch (err) {
      setError(plainMessage(err))
      return undefined
    } finally {
      running.current = false
      setBusy(null)
    }
  }, [])

  return { run, busy, error, setError }
}
