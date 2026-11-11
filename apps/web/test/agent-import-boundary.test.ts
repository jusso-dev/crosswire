import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { ESLint } from 'eslint'

/**
 * Propose-only boundary for agent code (#158): the lint rule must catch every spelling of the
 * proposals and executors modules, not just `../response/proposals`.
 */
const root = path.resolve(__dirname, '..')
const eslint = new ESLint({ cwd: root })
const agentFile = path.join(root, 'src/server/agents/__boundary_fixture__.ts')

async function restricted(code: string) {
  const [result] = await eslint.lintText(code, { filePath: agentFile })
  return result!.messages.filter((m) => m.ruleId === 'no-restricted-imports').map((m) => m.message)
}

describe('agent import boundary lint rule (#158)', () => {
  it.each([
    "import { executeProposal } from '../response/proposals'",
    "import { decideProposal } from '../../server/response/proposals'",
    "import { dryRunProposal } from '~/server/response/proposals'",
  ])('refuses decide/execute imports: %s', async (code) => {
    expect(await restricted(`${code}\nexport {}\n`)).toEqual([expect.stringMatching(/only create proposals/)])
  })

  it.each(["import * as x from '../response/executors'", "import * as x from '~/server/response/executors'", "import * as x from '../../server/response/executors'"])(
    'refuses executor imports: %s',
    async (code) => {
      expect(await restricted(`${code}\nexport { x }\n`)).toEqual([expect.stringMatching(/must not import executors/)])
    },
  )

  it('allows creating proposals', async () => {
    expect(await restricted("import { createProposal } from '../response/proposals'\nexport { createProposal }\n")).toEqual([])
  })
})
