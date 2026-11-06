import { getDb } from '../db/client'
import { orgs } from '../db/schema'
import { compactMemory } from '../agents/memory'
import { AGENT_KEYS } from '../../shared/agents'
import { runCli } from './run'

/** `pnpm compact-memory [--org <id>] [--keep 20]`: Squad `nap` analogue. Org-scoped and audited. */
const arg = (name: string) => {
  const i = process.argv.indexOf(name)
  return i > -1 ? process.argv[i + 1] : undefined
}
runCli('compact-memory', async () => {
  const orgId = arg('--org')
  const keepLatest = Number(arg('--keep') ?? 20)
  const targets = orgId ? [{ id: orgId }] : await getDb().select({ id: orgs.id }).from(orgs)
  const results = []
  for (const o of targets) for (const k of AGENT_KEYS) results.push({ orgId: o.id, ...(await compactMemory(o.id, k, { keepLatest })) })
  return { compacted: results.filter((r) => r.before !== r.after).length, runs: results.length }
})
