import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

/**
 * Every error-level log line the app writes must raise an Azure alert (#153). The job-failures rule
 * in alerts.bicep matches a fixed list of messages plus two patterns. A new logger.error message
 * fails this test until it is added to the list or matched by a pattern.
 */
const SRC = path.resolve(__dirname, '../src')
const BICEP = readFileSync(path.resolve(__dirname, '../../../infra/azure/modules/alerts.bicep'), 'utf8')

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    return statSync(full).isDirectory() ? files(full) : /\.tsx?$/.test(name) ? [full] : []
  })
}

const listed = new Set([...(BICEP.match(/var failureEvents = '(.*)'/)?.[1] ?? '').matchAll(/"([^"]+)"/g)].map((m) => m[1]))

/** Template-literal messages and the rule that covers each. */
const PATTERNS: Record<string, string> = {
  'job ${name} failed': 'worker jobs: m startswith "job " and m endswith " failed"',
  'hunt ${step} failed': 'hunting refusals: m startswith "hunt " and m endswith " failed"',
  'agent ${what} failed': 'agent clean-up (bestEffort): m startswith "agent " and m endswith " failed"',
  '${what} failed': 'run recovery (reconcileStep): every step name starts with "reconcile ", matched by m startswith "reconcile "',
  '${name} failed': 'one-off CLI commands (runCli). In Azure only the migrate job runs them, and the migration-failed rule catches every error it logs.',
}

describe('alert coverage (#153)', () => {
  const calls = files(SRC).flatMap((f) =>
    [...readFileSync(f, 'utf8').matchAll(/logger\.error\(\s*(['`])((?:(?!\1).)*)\1/g)].map((m) => ({ file: path.relative(SRC, f), quote: m[1], msg: m[2] ?? '' })),
  )

  it('finds the error log calls', () => {
    expect(calls.length).toBeGreaterThan(10)
  })

  it('lists every fixed error message in the job-failures rule', () => {
    const missing = calls.filter((c) => c.quote === "'" && !listed.has(c.msg)).map((c) => `${c.file}: ${c.msg}`)
    expect(missing).toEqual([])
  })

  it('names every run-recovery step with the reconcile prefix', () => {
    const runs = readFileSync(path.join(SRC, 'server/agents/runs.ts'), 'utf8')
    const steps = [...runs.matchAll(/reconcileStep\(\s*'([^']+)'/g)].map((m) => m[1])
    expect(steps.length).toBeGreaterThan(0)
    expect(steps.filter((s) => !s?.startsWith('reconcile '))).toEqual([])
  })

  it('covers every templated error message with a known pattern', () => {
    const unknown = calls.filter((c) => c.quote === '`' && !(c.msg in PATTERNS)).map((c) => `${c.file}: ${c.msg}`)
    expect(unknown).toEqual([])
    expect(BICEP).toContain('(m startswith "job " and m endswith " failed")')
    expect(BICEP).toContain('(m startswith "hunt " and m endswith " failed")')
    expect(BICEP).toContain('(m startswith "agent " and m endswith " failed")')
    expect(BICEP).toContain('(m startswith "reconcile " and m endswith " failed")')
  })
})
