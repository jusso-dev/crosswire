import { runRetention } from '../ops/retention'
import { runCli } from './run'

/** `pnpm retention`: run the data retention purge once (RETENTION_* settings; 0 keeps forever). */
runCli('retention', () => runRetention())
