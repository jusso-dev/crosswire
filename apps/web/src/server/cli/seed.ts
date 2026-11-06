import { auth } from '../auth/auth'
import { getDb } from '../db/client'
import { orgMemberships, user } from '../db/schema'
import { eq } from 'drizzle-orm'
import { runCli } from './run'

/**
 * `pnpm db:seed`: local demo users (development only). Creates owner@example.test (owner of a demo
 * org) and analyst@example.test in the same org. Password from SEED_PASSWORD (min 12 chars).
 */
runCli('db:seed', async () => {
  if (process.env.NODE_ENV === 'production') throw new Error('Refusing to seed in production.')
  const password = process.env.SEED_PASSWORD
  if (!password || password.length < 12) throw new Error('Set SEED_PASSWORD (12+ characters) to seed demo users.')
  const created: string[] = []
  for (const email of ['owner@example.test', 'analyst@example.test']) {
    const [existing] = await getDb().select().from(user).where(eq(user.email, email))
    if (existing) continue
    await auth().api.signUpEmail({ body: { email, password, name: email.split('@')[0]! } })
    created.push(email)
  }
  const [owner] = await getDb().select().from(user).where(eq(user.email, 'owner@example.test'))
  const [analyst] = await getDb().select().from(user).where(eq(user.email, 'analyst@example.test'))
  if (owner && analyst) {
    const [ownerOrg] = await getDb().select().from(orgMemberships).where(eq(orgMemberships.userId, owner.id))
    if (ownerOrg) await getDb().insert(orgMemberships).values({ orgId: ownerOrg.orgId, userId: analyst.id, role: 'analyst' }).onConflictDoNothing()
  }
  return { created }
})
