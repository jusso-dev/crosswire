import { eq } from 'drizzle-orm'
import { getDb } from '../db/client'
import { orgMemberships, user } from '../db/schema'
import { loadDemoFixtures, resetDemoFixtures } from '../ops/fixtures'
import { runCli } from './run'

/**
 * `pnpm fixtures:load --email you@example.test [--reset]` (#77): load the [DEMO] fixture pack into
 * that user's first org. Refuses in production unless ALLOW_DEMO_FIXTURES=true.
 */
const arg = (n: string) => {
  const i = process.argv.indexOf(n)
  return i > -1 ? process.argv[i + 1] : undefined
}
runCli('fixtures:load', async () => {
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_DEMO_FIXTURES !== 'true') throw new Error('Refusing to load demo fixtures in production (set ALLOW_DEMO_FIXTURES=true for a lab).')
  const email = arg('--email') ?? process.env.FIXTURES_EMAIL
  if (!email) throw new Error('Pass --email <user email> (the user must have signed up).')
  const [u] = await getDb().select({ id: user.id }).from(user).where(eq(user.email, email.toLowerCase())).limit(1)
  if (!u) throw new Error(`No user ${email}. Sign up first.`)
  const [m] = await getDb().select({ orgId: orgMemberships.orgId }).from(orgMemberships).where(eq(orgMemberships.userId, u.id)).limit(1)
  if (!m) throw new Error('User has no org.')
  if (process.argv.includes('--reset')) return resetDemoFixtures(m.orgId)
  return loadDemoFixtures(m.orgId, u.id)
})
