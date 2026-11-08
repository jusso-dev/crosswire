import { config } from 'zod'

/**
 * zod 4 probes for eval support with `Function('')` the first time it builds an object schema.
 * Under our CSP (no 'unsafe-eval') the probe fails safely but is still reported as a violation,
 * so switch the JIT off. This module must be imported before anything that builds a schema;
 * src/router.tsx imports it first. Jitless parsing is plenty fast for our forms.
 */
config({ jitless: true })
