import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { AGENT_KEYS } from '../src/shared/agents'

const root = path.resolve(__dirname, '../../..')

describe('Copilot agent defs stay in sync with charters (#34)', () => {
  it('every agent has a .agent.md with parseable front matter and the charter safety rules', () => {
    const files = readdirSync(path.join(root, '.github/agents'))
    for (const key of AGENT_KEYS) {
      expect(files).toContain(`${key}.agent.md`)
      const def = readFileSync(path.join(root, '.github/agents', `${key}.agent.md`), 'utf8')
      const fm = /^---\n([\s\S]*?)\n---/.exec(def)?.[1] ?? ''
      expect(fm).toMatch(new RegExp(`^name: crosswire-${key}$`, 'm'))
      expect(fm).toMatch(/^description: ".+"$/m)
      const charter = readFileSync(path.join(root, '.squad/agents', key, 'charter.md'), 'utf8')
      const neverLines = charter.split('\n').filter((l) => l.startsWith('- Never'))
      for (const l of neverLines) expect(def, `${key} missing: ${l}`).toContain(l)
      expect(def).toMatch(/Never execute containment without an approved proposal/)
    }
  })
})
