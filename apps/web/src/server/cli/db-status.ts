import { migrationStatus } from '../ops/migrations'
import { runCli } from './run'

/** `pnpm db:status`: applied vs expected migration (#69). Exit code 1 when not up to date. */
runCli('db:status', async () => {
  const s = await migrationStatus()
  if (!s.upToDate) process.exitCode = 1
  return s
})
