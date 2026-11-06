import { readFileSync } from 'node:fs'
import { fetchAndIngestKev, ingestKev } from '../ti/kev'
import { runCli } from './run'

/** `pnpm ingest:cve` ingests CISA KEV (the CVE backbone; see docs/ti/cve.watch.md). `--fixtures <file>` for offline. */
const idx = process.argv.indexOf('--fixtures')
runCli('ingest:cve', async () => {
  if (idx > -1) return ingestKev(readFileSync(process.argv[idx + 1] ?? 'test/fixtures/kev.json', 'utf8'))
  return fetchAndIngestKev()
})
