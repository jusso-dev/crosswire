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

export class CharterError extends Error {}

const REQUIRED_CHARTER_SENTENCE = 'Never execute containment without an approved proposal.'

let cache: Record<AgentKey, string> | undefined

/**
 * Fail closed. A missing, empty, or charter that drops the propose-only sentence is not replaced
 * with a generic prompt. defineAgent does not open charter files, so this loader is the check.
 */
export function loadCharters(): Record<AgentKey, string> {
  if (cache) return cache
  const dir = squadDir()
  const out = {} as Record<AgentKey, string>
  for (const key of AGENT_KEYS) {
    const file = path.join(dir, 'agents', key, 'charter.md')
    if (!existsSync(file)) throw new CharterError(`Charter file missing for ${key} at ${file}.`)
    const text = readFileSync(file, 'utf8').trim()
    if (!text) throw new CharterError(`Charter file for ${key} is empty.`)
    if (!text.includes(REQUIRED_CHARTER_SENTENCE)) throw new CharterError(`Charter for ${key} does not keep the propose-only rule.`)
    out[key] = text
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
