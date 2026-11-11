// Production entry: serves the TanStack Start fetch handler and built client assets on Node.
// Run with `node server.mjs` after `pnpm build`. Honours PORT (default 3000) and HOST (default 0.0.0.0).
import { serve } from 'srvx'
import { staticMiddleware } from 'srvx/static'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))

const log = (level, msg, fields = {}) => console.log(JSON.stringify({ time: new Date().toISOString(), level, msg, ...fields }))

// Fail fast on bad configuration (#13): validate env before listening, not on the first request.
// In production a missing validator stops the server (#150): starting without the check would hide
// a bad configuration. Outside production it is a loud warning, for a partial local build.
const envCheckPath = path.join(here, 'dist/server/env-check.js')
let envCheck = null
try {
  envCheck = await import(envCheckPath)
} catch (err) {
  const detail = err instanceof Error ? err.message : String(err)
  if (process.env.NODE_ENV === 'production') {
    log('error', 'environment check missing; refusing to start', { path: envCheckPath, error: detail })
    process.exit(1)
  }
  log('warn', 'environment check missing; starting without configuration validation (development only)', { path: envCheckPath, error: detail })
}
if (envCheck) {
  try {
    const e = envCheck.parseEnv(process.env)
    envCheck.logStartupWarnings(e)
    // Response safety state (#83) and the approval policy in force (#133): logged loudly at boot.
    const safety = envCheck.responseSafety(e)
    log(safety.warnings.length ? 'warn' : 'info', 'response safety', { dryRun: safety.dryRun, executors: safety.executors, warnings: safety.warnings })
    log('info', 'approval policy', { kqlApprovalPolicy: e.KQL_APPROVAL_POLICY, responseAllowSelfApproval: e.RESPONSE_ALLOW_SELF_APPROVAL })
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
}
const { default: app } = await import(path.join(here, 'dist/server/server.js'))

const server = serve({
  port: Number(process.env.PORT ?? 3000),
  hostname: process.env.HOST ?? '0.0.0.0',
  middleware: [staticMiddleware({ dir: path.join(here, 'dist/client') })],
  fetch: app.fetch,
  gracefulShutdown: true,
})
await server.ready()
