import { and, desc, eq } from 'drizzle-orm'
import { getDb } from '../db/client'
import { huntPlaybooks } from '../db/schema'
import { assertSafeKql } from './safety'
import { createHunt, ForbiddenStepError, NotFoundError, proposeKql, StateError } from './hunts'
import { canApprove } from '../response/rbac'
import type { OrgRole } from '../orgs'
import {
  builtinPlaybook,
  checkRationale,
  fillIndicator,
  INDICATOR_LABEL,
  normaliseIndicator,
  type IndicatorKind,
  type PlaybookCheck,
  type PlaybookTemplate,
} from '../../shared/indicator-playbooks'

const MAX_CHECKS = 8
const SAMPLE: Record<IndicatorKind, string> = {
  ip: '203.0.113.10',
  domain: 'example.invalid',
  hash: 'a'.repeat(64),
}

export function checkedTemplate(checks: PlaybookCheck[], kind: IndicatorKind) {
  if (checks.length < 1 || checks.length > MAX_CHECKS) throw new StateError(`A playbook needs 1 to ${MAX_CHECKS} checks.`)
  return checks.map((check) => {
    const name = check.name.trim()
    if (!name || name.length > 80 || /[\r\n]/.test(name)) throw new StateError('Each check needs a name of 1 to 80 characters.')
    if (check.target !== 'defender' && check.target !== 'sentinel') throw new StateError('Each check targets Defender or Sentinel.')
    let filled: string
    try {
      filled = fillIndicator(check.kql, SAMPLE[kind])
    } catch {
      throw new StateError(`Each query must contain {{indicator}}.`)
    }
    try {
      assertSafeKql(filled)
    } catch (err) {
      throw new StateError(err instanceof Error ? err.message : String(err))
    }
    return { name, target: check.target, kql: check.kql.trim() }
  })
}

export async function listSavedPlaybooks(orgId: string) {
  return getDb().select().from(huntPlaybooks).where(eq(huntPlaybooks.orgId, orgId)).orderBy(desc(huntPlaybooks.updatedAt)).limit(100)
}

export async function savePlaybook(
  orgId: string,
  userId: string,
  input: { name: string; description?: string; indicatorKind: IndicatorKind; checks: PlaybookCheck[] },
) {
  const name = input.name.trim()
  if (!name || name.length > 80) throw new StateError('Name the playbook in 1 to 80 characters.')
  const description = (input.description ?? '').trim().slice(0, 500)
  const checks = checkedTemplate(input.checks, input.indicatorKind)
  const [existing] = await getDb()
    .select({ id: huntPlaybooks.id })
    .from(huntPlaybooks)
    .where(and(eq(huntPlaybooks.orgId, orgId), eq(huntPlaybooks.name, name)))
    .limit(1)
  if (existing) throw new StateError('This organisation already has a playbook with that name.')
  const [row] = await getDb()
    .insert(huntPlaybooks)
    .values({ orgId, name, description, indicatorKind: input.indicatorKind, checks, createdBy: userId })
    .returning()
  return row!
}

/** Delete a saved playbook. Playbooks are shared by the organisation, so only owners and approvers may. */
export async function deletePlaybook(orgId: string, actor: { userId: string; role: OrgRole }, playbookId: string) {
  if (!canApprove(actor.role)) throw new ForbiddenStepError('Only owners and approvers can delete a saved playbook.')
  if (playbookId.startsWith('builtin:')) throw new StateError('Built-in playbooks stay available.')
  const [row] = await getDb()
    .delete(huntPlaybooks)
    .where(and(eq(huntPlaybooks.orgId, orgId), eq(huntPlaybooks.id, playbookId)))
    .returning({ id: huntPlaybooks.id })
  if (!row) throw new NotFoundError('Playbook not found.')
}

async function loadPlaybook(orgId: string, playbookId: string): Promise<PlaybookTemplate | null> {
  const builtin = builtinPlaybook(playbookId)
  if (builtin) return builtin
  const [row] = await getDb().select().from(huntPlaybooks).where(and(eq(huntPlaybooks.orgId, orgId), eq(huntPlaybooks.id, playbookId))).limit(1)
  if (!row) return null
  return { id: row.id, name: row.name, description: row.description, indicatorKind: row.indicatorKind, checks: row.checks }
}

/**
 * Open a hunt and propose every check with the indicator filled in.
 * Does not run KQL. approveAndRunKql remains the only execute path.
 */
export async function startPlaybook(orgId: string, userId: string, input: { playbookId: string; indicator: string }) {
  const template = await loadPlaybook(orgId, input.playbookId)
  if (!template) throw new NotFoundError('Playbook not found.')
  const indicator = normaliseIndicator(template.indicatorKind, input.indicator)
  if (!indicator) throw new StateError(`Enter one ${INDICATOR_LABEL[template.indicatorKind]}.`)
  const rendered = template.checks.map((check) => {
    let kql: string
    try {
      kql = assertSafeKql(fillIndicator(check.kql, indicator))
    } catch (err) {
      throw new StateError(err instanceof Error ? err.message : String(err))
    }
    return { name: check.name, target: check.target, kql }
  })
  const hunt = await createHunt(orgId, userId, {
    title: `${template.name}: ${indicator}`.slice(0, 200),
    hypothesis: `Any hits on this ${INDICATOR_LABEL[template.indicatorKind]} (${indicator})? Playbook: ${template.name}. Each search is proposed and waits for a person to approve it before it runs.`,
  })
  const proposalIds: string[] = []
  for (const check of rendered) {
    const proposal = await proposeKql(orgId, { type: 'user', id: userId }, { huntId: hunt.id, target: check.target, kql: check.kql, rationale: checkRationale(check.name) })
    proposalIds.push(proposal.id)
  }
  return { huntId: hunt.id, proposalIds }
}
