import { getDb } from '../src/server/db/client'
import { orgMemberships, orgs, user } from '../src/server/db/schema'
import type { OrgRole } from '../src/server/orgs'

let n = 0
export async function makeUser(email?: string) {
  n++
  const id = crypto.randomUUID()
  await getDb().insert(user).values({ id, name: `User ${n}`, email: email ?? `user${n}-${id.slice(0, 6)}@example.test`, emailVerified: true })
  return id
}

export async function makeOrg(name = 'Org') {
  const [o] = await getDb().insert(orgs).values({ name, slug: `${name.toLowerCase()}-${crypto.randomUUID().slice(0, 8)}` }).returning()
  return o!.id
}

export async function member(orgId: string, userId: string, role: OrgRole = 'analyst') {
  await getDb().insert(orgMemberships).values({ orgId, userId, role })
}

/** One org with an owner, an approver and an analyst. */
export async function team() {
  const orgId = await makeOrg('Team')
  const owner = await makeUser()
  const approver = await makeUser()
  const analyst = await makeUser()
  await member(orgId, owner, 'owner')
  await member(orgId, approver, 'approver')
  await member(orgId, analyst, 'analyst')
  return { orgId, owner, approver, analyst }
}

export async function readSse(res: Response) {
  const text = await res.text()
  return text
    .split('\n\n')
    .map((b) => b.replace(/^data: /, '').trim())
    .filter(Boolean)
    .map((b) => JSON.parse(b) as { type: string; delta?: string; message?: string })
}
