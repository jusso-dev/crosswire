import { and, isNotNull, sql } from 'drizzle-orm'
import { getDb } from '../db/client'
import { orgs } from '../db/schema'

/** Lower-cased domain of an address, or null when it is not an address. */
export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf('@')
  const d = at > 0 ? email.slice(at + 1).trim().toLowerCase() : ''
  return d && !d.includes('@') ? d : null
}

/**
 * True when an org bound to an Entra tenant claims this address's domain (`orgs.email_domain`,
 * #203). People with such an address sign in with Microsoft. A local sign-up or a SAML provider
 * cannot create their account first and lock them out.
 */
export async function entraClaimedDomain(email: string): Promise<boolean> {
  const d = emailDomain(email)
  if (!d) return false
  const [row] = await getDb()
    .select({ id: orgs.id })
    .from(orgs)
    .where(and(isNotNull(orgs.entraTenantId), sql`lower(${orgs.emailDomain}) = ${d}`))
    .limit(1)
  return Boolean(row)
}
