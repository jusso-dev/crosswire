import { and, desc, eq } from 'drizzle-orm'
import { getDb } from './db/client'
import { auditEvents } from './db/schema'
import { redactValue, truncate } from './lib/redact'

export type AuditCategory = (typeof auditEvents.$inferInsert)['category']

export interface AuditInput {
  category: AuditCategory
  action: string
  result?: 'success' | 'failure'
  actorType: 'user' | 'agent' | 'system'
  actorId?: string | null
  orgId?: string | null
  ipAddress?: string | null
  userAgent?: string | null
  targetType?: string
  targetId?: string
  data?: Record<string, unknown>
}

/** Append-only audit writer. Payloads are redacted and size-capped before storage. */
export async function writeAudit(input: AuditInput) {
  const data = redactValue(input.data ?? {}) as Record<string, unknown>
  const serialized = JSON.stringify(data)
  await getDb()
    .insert(auditEvents)
    .values({
      category: input.category,
      action: input.action,
      result: input.result ?? 'success',
      actorType: input.actorType,
      actorId: input.actorId ?? null,
      orgId: input.orgId ?? null,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ? truncate(input.userAgent, 300) : null,
      targetType: input.targetType,
      targetId: input.targetId,
      data: serialized.length > 8000 ? { truncated: truncate(serialized, 8000) } : data,
    })
}

export async function listAudit(orgId: string, category?: AuditCategory, limit = 100) {
  const where = category ? and(eq(auditEvents.orgId, orgId), eq(auditEvents.category, category)) : eq(auditEvents.orgId, orgId)
  return getDb().select().from(auditEvents).where(where).orderBy(desc(auditEvents.createdAt)).limit(Math.min(limit, 500))
}
