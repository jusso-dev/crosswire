import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { BuilderValidationError, defineAgent, defineRouting } from '@bradygaster/squad-sdk/builders'
import { LocalMemoryStore } from '@bradygaster/squad-sdk/memory'
import { CostTracker } from '@bradygaster/squad-sdk/runtime/cost-tracker'
import { InMemoryStorageProvider } from '@bradygaster/squad-sdk/storage'
import {
  CONTEXT_WARNING_THRESHOLD,
  SQUAD_SDK_PIN,
  installedSquadSdkVersion,
  newCostTracker,
  squadSdkPackageHasBackendExport,
  writeWithSquad,
} from '../src/server/agents/squad-sdk'

const repoRoot = path.resolve(__dirname, '../../..')
const webRoot = path.resolve(__dirname, '..')
const PRIVATE_KEY = ['-----BEGIN PRIVATE KEY-----', 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7example', '-----END PRIVATE KEY-----'].join('\n')

function importSpecifiers(source: string) {
  const out: string[] = []
  for (const match of source.matchAll(/^\s*import\s+[\s\S]*?\sfrom\s+['"]([^'"]+)['"]/gm)) out.push(match[1]!)
  for (const match of source.matchAll(/^\s*export\s+[\s\S]*?\sfrom\s+['"]([^'"]+)['"]/gm)) out.push(match[1]!)
  for (const match of source.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) out.push(match[1]!)
  for (const match of source.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(match[1]!)
  return out
}

function walkTs(dir: string, acc: string[] = []) {
  return walkSource(dir, acc, false)
}

function walkSource(dir: string, acc: string[] = [], tsx = true) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue
    const file = path.join(dir, name)
    const stat = statSync(file)
    if (stat.isDirectory()) walkSource(file, acc, tsx)
    else if (name.endsWith('.ts') || (tsx && name.endsWith('.tsx'))) acc.push(file)
  }
  return acc
}

describe('Squad SDK 1.1.0 runtime boundary', () => {
  it('rejects an empty agent name with the SDK validation error', () => {
    expect(() => defineAgent({ name: '', role: 'x' })).toThrow(BuilderValidationError)
  })

  it('accepts an empty routing rule list and rejects a routing object with no rules', () => {
    expect(defineRouting({ rules: [] })).toBeTruthy()
    expect(() => defineRouting({} as never)).toThrow(BuilderValidationError)
  })

  it('refuses FORBIDDEN and TRANSIENT writes on an in-memory store', async () => {
    const store = new LocalMemoryStore(new InMemoryStorageProvider(), 'memory://acceptance')
    const forbidden = await store.write({ content: 'ordinary note', requestedClass: 'FORBIDDEN' })
    expect(forbidden.stored).toBe(false)
    expect(forbidden.classification.class).toBe('FORBIDDEN')
    const transient = await store.write({ content: 'this turn only', requestedClass: 'TRANSIENT' })
    expect(transient.stored).toBe(false)
    expect(transient.classification.class).toBe('TRANSIENT')
    const key = await writeWithSquad({ content: PRIVATE_KEY })
    expect(key.stored).toBe(false)
    expect(key.classification.class).toBe('FORBIDDEN')
    expect(key.classification.allowed).toBe(false)
  })

  it('records caller-supplied tokens on CostTracker', () => {
    const tracker = new CostTracker()
    tracker.recordUsage({ sessionId: 's', model: 'customer-model', inputTokens: 11, outputTokens: 7, estimatedCost: 0 })
    const summary = tracker.getSummary()
    expect(summary.totalInputTokens).toBe(11)
    expect(summary.totalOutputTokens).toBe(7)
    const ours = newCostTracker()
    ours.recordUsage({ sessionId: 's2', model: 'customer-model', inputTokens: 3, outputTokens: 1, estimatedCost: 0 })
    expect(ours.getSummary().totalInputTokens).toBe(3)
  })

  it('pins 1.1.0 in package.json, the lockfile, and the installed package', () => {
    const pkg = JSON.parse(readFileSync(path.join(webRoot, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
    expect(pkg.dependencies['@bradygaster/squad-sdk']).toBe('1.1.0')
    const lock = readFileSync(path.join(repoRoot, 'pnpm-lock.yaml'), 'utf8')
    expect(lock).toContain('@bradygaster/squad-sdk@1.1.0')
    expect(installedSquadSdkVersion()).toBe(SQUAD_SDK_PIN)
    expect(squadSdkPackageHasBackendExport()).toBe(false)
  })

  it('keeps the supported export boundary and does not file-URL import unexported runtime files', () => {
    const boundary = readFileSync(path.join(webRoot, 'src/server/agents/squad-sdk.ts'), 'utf8')
    expect(boundary).not.toContain('usage-ledger.js')
    expect(boundary).not.toContain('context-utilization.js')
    expect(boundary).not.toMatch(/from '@bradygaster\/squad-sdk\/client'/)
    const costTrackerUrl = import.meta.resolve('@bradygaster/squad-sdk/runtime/cost-tracker')
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', costTrackerUrl), 'utf8')) as { exports?: Record<string, unknown> }
    expect(pkg.exports?.['./runtime/usage-ledger']).toBeUndefined()
    expect(pkg.exports?.['./runtime/context-utilization']).toBeUndefined()
    expect(pkg.exports?.['./runtime/cost-tracker']).toBeTruthy()
    const usageSource = readFileSync(new URL('./usage-ledger.js', costTrackerUrl), 'utf8')
    expect(usageSource).toContain("USAGE_LEDGER_PATH = 'log/usage.jsonl'")
    const contextSource = readFileSync(new URL('./context-utilization.js', costTrackerUrl), 'utf8')
    expect(contextSource).toContain('DEFAULT_CONTEXT_WARNING_THRESHOLD = 0.8')
    expect(CONTEXT_WARNING_THRESHOLD).toBe(0.8)
  })

  it('does not import Copilot, the Squad client, or a backend from the SOC graph', () => {
    const forbidden = [/@github\/copilot-sdk/, /@bradygaster\/squad-sdk\/client/, /@bradygaster\/squad-sdk\/backend/, /HarnessAdapter/, /usage-ledger\.js/, /context-utilization\.js/]
    const sdkRelative = [/^\.\/client(?:\.js)?$/, /^\.\/backend(?:\.js)?$/]
    const sourceFiles = [...walkTs(path.join(webRoot, 'src/server/agents')), path.join(webRoot, 'src/server/chat/handler.ts'), path.join(webRoot, 'src/server/chat/threads.ts'), path.join(webRoot, 'src/server/cli/worker.ts')]
    for (const file of sourceFiles) {
      const specifiers = importSpecifiers(readFileSync(file, 'utf8'))
      for (const spec of specifiers) {
        for (const pattern of forbidden) expect(spec, file).not.toMatch(pattern)
      }
      const text = readFileSync(file, 'utf8')
      expect(text, file).not.toMatch(/new FSStorageProvider|new SQLiteStorageProvider/)
    }
    const boundary = readFileSync(path.join(webRoot, 'src/server/agents/squad-sdk.ts'), 'utf8')
    expect(boundary).toContain("from '@bradygaster/squad-sdk/builders'")
    expect(boundary).toContain("from '@bradygaster/squad-sdk/memory'")
    expect(boundary).toContain("from '@bradygaster/squad-sdk/storage'")
    expect(boundary).toContain("from '@bradygaster/squad-sdk/runtime/cost-tracker'")
    expect(boundary).not.toContain('usage-ledger.js')
    expect(boundary).not.toContain('context-utilization.js')

    const starts = [
      import.meta.resolve('@bradygaster/squad-sdk/builders'),
      import.meta.resolve('@bradygaster/squad-sdk/memory'),
      import.meta.resolve('@bradygaster/squad-sdk/storage'),
      import.meta.resolve('@bradygaster/squad-sdk/runtime/cost-tracker'),
    ]
    const seen = new Set<string>()
    const queue = [...starts]
    while (queue.length) {
      const file = queue.pop()!
      if (seen.has(file) || !file.endsWith('.js')) continue
      seen.add(file)
      const source = readFileSync(new URL(file), 'utf8')
      for (const spec of importSpecifiers(source)) {
        for (const pattern of [...forbidden, ...sdkRelative]) expect(spec, file).not.toMatch(pattern)
        if (spec.startsWith('.')) queue.push(new URL(spec, file).href)
      }
    }
    expect([...seen].every((file) => file.includes('/@bradygaster/squad-sdk/'))).toBe(true)
    expect(seen.size).toBeGreaterThan(4)

    const production = walkSource(path.join(webRoot, 'src'))
    expect(production.length).toBeGreaterThan(10)
    for (const file of production) {
      for (const spec of importSpecifiers(readFileSync(file, 'utf8'))) {
        for (const pattern of [...forbidden, /squad-sdk-client-boundary/]) expect(spec, `${file} imports ${spec}`).not.toMatch(pattern)
      }
    }
  })
})
