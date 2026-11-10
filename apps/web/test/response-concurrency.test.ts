import { describe } from 'vitest'
import { responseRaceSuite } from './response-races'

/**
 * Approval races on PGlite (one connection, so overlap happens at await points). The same suite runs
 * on real Postgres with parallel connections in pg-real.test.ts.
 */
describe('approval races (PGlite)', () => {
  responseRaceSuite()
})
