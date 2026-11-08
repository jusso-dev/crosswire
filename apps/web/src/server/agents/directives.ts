import { and, desc, eq } from 'drizzle-orm'
import { getDb } from '../db/client'
import { orgDirectives, socHandovers, socReviews } from '../db/schema'
import { writeAudit } from '../audit'
import { sha256 } from './canonical'

export class DirectiveError extends Error {}

/** Approved org directives for the system prompt. Drafts and the activity log stay out. */
export async function approvedDirectiveBlock(orgId: string) {
  const rows = await getDb()
    .select()
    .from(orgDirectives)
    .where(and(eq(orgDirectives.orgId, orgId), eq(orgDirectives.status, 'approved')))
    .orderBy(desc(orgDirectives.approvedAt))
    .limit(20)
  if (!rows.length) return ''
  return ['## Approved org directives', ...rows.map((row) => `- (v${row.version}) ${row.title}: ${row.body}`)].join('\n')
}

export async function createDirective(input: {
  orgId: string
  title: string
  body: string
  createdBy: string
  source?: 'operator' | 'lesson' | 'review' | 'import'
  provenance?: Record<string, unknown>
}) {
  const body = input.body.trim()
  if (!body) throw new DirectiveError('Directive body is empty.')
  const [row] = await getDb()
    .insert(orgDirectives)
    .values({
      orgId: input.orgId,
      title: input.title.trim(),
      body,
      contentSha256: sha256(body),
      status: 'draft',
      source: input.source ?? 'operator',
      createdBy: input.createdBy,
      provenance: input.provenance ?? {},
    })
    .returning()
  return row!
}

/** A different person approves a draft. The author cannot approve it. */
export async function approveDirective(orgId: string, directiveId: string, approverUserId: string) {
  const [row] = await getDb().select().from(orgDirectives).where(and(eq(orgDirectives.orgId, orgId), eq(orgDirectives.id, directiveId))).limit(1)
  if (!row) throw new DirectiveError('Directive not found.')
  if (row.status !== 'draft') throw new DirectiveError(`Directive is already ${row.status}.`)
  if (!row.createdBy || row.createdBy === approverUserId) throw new DirectiveError('You cannot approve your own directive.')
  const [updated] = await getDb()
    .update(orgDirectives)
    .set({ status: 'approved', approvedBy: approverUserId, approvedAt: new Date() })
    .where(and(eq(orgDirectives.id, directiveId), eq(orgDirectives.status, 'draft')))
    .returning()
  if (!updated) throw new DirectiveError('Directive was already decided.')
  await writeAudit({ category: 'memory', action: 'directive_approve', actorType: 'user', actorId: approverUserId, orgId, targetId: directiveId })
  return updated
}

export async function recordIncidentReview(input: { orgId: string; incidentRef: string; body: string; createdBy: string }) {
  const [row] = await getDb()
    .insert(socReviews)
    .values({ orgId: input.orgId, incidentRef: input.incidentRef, body: input.body.trim(), createdBy: input.createdBy })
    .returning()
  return row!
}

export async function recordHandover(input: { orgId: string; shiftLabel: string; body: string; createdBy: string }) {
  const [row] = await getDb()
    .insert(socHandovers)
    .values({ orgId: input.orgId, shiftLabel: input.shiftLabel, body: input.body.trim(), createdBy: input.createdBy })
    .returning()
  return row!
}

/** A lesson becomes a draft directive. It is not approved and it is not injected. */
export async function proposeLesson(input: { orgId: string; title: string; body: string; createdBy: string; reviewId?: string }) {
  return createDirective({
    orgId: input.orgId,
    title: input.title,
    body: input.body,
    createdBy: input.createdBy,
    source: 'lesson',
    provenance: { reviewId: input.reviewId ?? null },
  })
}
