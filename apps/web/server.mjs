// Production entry: serves the TanStack Start fetch handler and built client assets on Node.
// Run with `node server.mjs` after `pnpm build`. Honours PORT (default 3000) and HOST (default 0.0.0.0).
import { serve } from 'srvx'
import { staticMiddleware } from 'srvx/static'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))

// Fail fast on bad configuration (#13): validate env before listening, not on the first request.
const { parseEnv } = await import(path.join(here, 'dist/server/env-check.js')).catch(() => ({ parseEnv: null }))
if (parseEnv) {
  try {
    parseEnv(process.env)
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
