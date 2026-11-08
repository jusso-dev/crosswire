import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { SquadClient } from '@bradygaster/squad-sdk/client'

const webRoot = path.resolve(__dirname, '..')

/**
 * Stub proof only. The constructor stores options and does not call connect().
 * A live customer-model session would call createSession, which starts the Copilot CLI.
 * That call is not made here, and no credential file is read.
 */
describe('SquadClient compatibility boundary', () => {
  it('constructs a disconnected client and does not start a provider session', () => {
    const client = new SquadClient({
      cliPath: '/tmp/crosswire-squad-client-not-started',
      env: {},
      useLoggedInUser: false,
      autoStart: false,
      autoReconnect: false,
      logLevel: 'none',
    })
    expect(client.getState()).toBe('disconnected')
    expect(client.isConnected()).toBe(false)
    const clientUrl = import.meta.resolve('@bradygaster/squad-sdk/client')
    const source = readFileSync(new URL('../adapter/client.js', clientUrl), 'utf8')
    const constructorStart = source.indexOf('constructor(options = {})')
    const constructorEnd = source.indexOf('getState()', constructorStart)
    const constructor = source.slice(constructorStart, constructorEnd)
    expect(constructor).toContain('new CopilotClient')
    expect(constructor).not.toContain('this.connect(')
    const types = readFileSync(new URL('../adapter/types.d.ts', clientUrl), 'utf8')
    expect(types).toContain('type?: "openai" | "azure" | "anthropic"')
    expect(types).toContain('baseUrl: string')
    const agents = readFileSync(path.join(webRoot, 'src/server/agents/squad-sdk.ts'), 'utf8')
    const runtime = readFileSync(path.join(webRoot, 'src/server/agents/runtime.ts'), 'utf8')
    expect(agents).not.toMatch(/from ['"]@bradygaster\/squad-sdk\/client['"]/)
    expect(runtime).not.toMatch(/new SquadClient|createSession\(/)
  })
})
