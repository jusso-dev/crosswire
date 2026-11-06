import { closeDb } from '../db/client'
import { logger } from '../lib/logger'

/** Shared CLI runner: logs a JSON result, sets exit code on failure, always closes the DB. */
export function runCli(name: string, fn: () => Promise<unknown>) {
  fn()
    .then((result) => logger.info(`${name} complete`, { result: result as Record<string, unknown> }))
    .catch((err: unknown) => {
      logger.error(`${name} failed`, { error: err instanceof Error ? err.message : String(err) })
      process.exitCode = 1
    })
    .finally(() => closeDb())
}
