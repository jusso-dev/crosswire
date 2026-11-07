import { appDay, runDailyDigest } from '../ti/digest'
import { runCli } from './run'

/** `pnpm digest:daily [YYYY-MM-DD]` (default: today in APP_TIMEZONE). Idempotent per org-day. */
const day = process.argv[2] && /^\d{4}-\d{2}-\d{2}$/.test(process.argv[2]) ? process.argv[2] : appDay()
runCli('digest:daily', () => runDailyDigest(day))
