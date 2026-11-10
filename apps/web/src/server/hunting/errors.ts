import { logger } from '../lib/logger'
import { HuntingNotConfiguredError } from './broker'
import { NotFoundError, StateError } from './hunts'
import { UnsafeQueryError } from './safety'

/** Errors whose message was written for the analyst. Anything else may hold SQL, ids or a Graph body. */
const SAFE_ERRORS = [StateError, NotFoundError, UnsafeQueryError, HuntingNotConfiguredError]

/**
 * The reason to show for a refused hunting step (#129). Known rule errors keep their plain message.
 * Any other error is logged in full with a short reference, and the screen gets the reference only.
 */
export function refusalMessage(err: unknown, step: string) {
  if (SAFE_ERRORS.some((E) => err instanceof E)) return (err as Error).message
  const ref = crypto.randomUUID().slice(0, 8)
  logger.error(`hunt ${step} failed`, { ref, error: err instanceof Error ? err.message : String(err) })
  return `Something went wrong on the server. Try again. If it keeps happening, give an owner this reference: ${ref}.`
}
