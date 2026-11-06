// Bundle the env validator into dist/server/env-check.js so server.mjs can validate config at boot
// without tsx. Uses esbuild (already a Vite dependency).
import { build } from 'esbuild'

await build({
  entryPoints: ['src/server/env.ts'],
  outfile: 'dist/server/env-check.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  logLevel: 'warning',
})
