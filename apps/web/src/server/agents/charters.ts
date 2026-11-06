import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { AGENT_KEYS, type AgentKey } from '../../shared/agents'

/**
 * Charters live in `.squad/agents/<key>/charter.md` at the repo root (#30). The image copies them to
 * `/app/.squad`; SQUAD_DIR overrides the location. Loaded once and cached.
 */
function squadDir() {
  if (process.env.SQUAD_DIR) return process.env.SQUAD_DIR
  const candidates = [path.resolve(process.cwd(), '.squad'), path.resolve(process.cwd(), '../../.squad')]
  return candidates.find((c) => existsSync(c)) ?? candidates[0]!
}

let cache: Record<AgentKey, string> | undefined

export function loadCharters(): Record<AgentKey, string> {
  if (cache) return cache
  const dir = squadDir()
  const out = {} as Record<AgentKey, string>
  for (const key of AGENT_KEYS) {
    const file = path.join(dir, 'agents', key, 'charter.md')
    out[key] = existsSync(file) ? readFileSync(file, 'utf8') : `# ${key}\n\nCharter file missing at ${file}. Never execute containment without an approved proposal.`
  }
  cache = out
  return out
}

export function charter(key: AgentKey) {
  return loadCharters()[key]
}

export function resetChartersForTests() {
  cache = undefined
}
