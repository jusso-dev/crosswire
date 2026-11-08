import { rotateSecrets } from './rotate-secrets'
import { runCli } from './run'

/** `pnpm rotate-secrets`: re-encrypt stored secrets with the current APP_ENCRYPTION_KEY (see rotate-secrets.ts). */
runCli('rotate-secrets', rotateSecrets)
