import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fetchAndIngestPwnWatch, ingestPwnWatch } from '../ti/pwnwatch'
import { runCli } from './run'

/**
 * `pnpm ingest:pwn` fetches pwn.watch politely (cached, TTL >= 1h).
 * `pnpm ingest:pwn --fixtures <dir>` ingests recorded JSON offline (incidents.json, changes.json, tags.json).
 */
const idx = process.argv.indexOf('--fixtures')
runCli('ingest:pwn', async () => {
  if (idx > -1) {
    const dir = process.argv[idx + 1] ?? 'test/fixtures/pwnwatch'
    const read = (f: string) => readFileSync(path.join(dir, f), 'utf8')
    return ingestPwnWatch({ incidents: read('incidents.json'), changes: read('changes.json'), tags: read('tags.json') })
  }
  return fetchAndIngestPwnWatch()
})
