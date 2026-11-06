import { runDailyDigest, utcDay } from '../ti/digest'
import { runCli } from './run'

/** `pnpm digest:daily [YYYY-MM-DD]` (default: today, UTC). Idempotent per org-day. */
const day = process.argv[2] && /^\d{4}-\d{2}-\d{2}$/.test(process.argv[2]) ? process.argv[2] : utcDay()
runCli('digest:daily', () => runDailyDigest(day))
