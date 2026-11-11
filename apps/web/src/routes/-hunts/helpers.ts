import { plural } from '../../components/format'
import { checkLabel } from '../../shared/indicator-playbooks'

/**
 * Pure helpers for the hunt workspace. No React, no server code, so Vitest covers them directly.
 */

type PendingLike = { id: string; status: string; kql: string; rationale: string }

/** Edited KQL per proposal id, shared by every search panel and by "Approve all" (#123). */
export type KqlEdits = Readonly<Record<string, string>>

/** The query a panel shows for a proposal: the analyst's edit when there is one, else the proposal. */
export function shownKql(p: { id: string; kql: string }, edits: KqlEdits): string {
  return edits[p.id] ?? p.kql
}

export type ApproveAllItem = { proposalId: string; name: string; kql: string; edited: boolean }

/**
 * What "Approve all" sends (#123): every pending search, oldest first, each with exactly the text its
 * panel shows. `edited` is true when that text differs from the proposal, so the confirmation can say
 * how many were changed. The server still applies every KQL approval rule to each one.
 */
export function approveAllPlan(proposals: PendingLike[], edits: KqlEdits): ApproveAllItem[] {
  return proposals
    .filter((p) => p.status === 'proposed')
    .reverse()
    .map((p) => {
      const kql = shownKql(p, edits)
      return { proposalId: p.id, name: checkLabel(p.rationale, p.kql), kql, edited: kql.trim() !== p.kql.trim() }
    })
}

/** "every hour", "every 6 hours", "every day", "every 2 weeks" (#167 item 9). */
export function intervalText(minutes: number): string {
  if (minutes % 10080 === 0) return minutes === 10080 ? 'every week' : `every ${plural(minutes / 10080, 'week')}`
  if (minutes % 1440 === 0) return minutes === 1440 ? 'every day' : `every ${plural(minutes / 1440, 'day')}`
  if (minutes % 60 === 0) return minutes === 60 ? 'every hour' : `every ${plural(minutes / 60, 'hour')}`
  return `every ${plural(minutes, 'minute')}`
}

export const FORMER_MEMBER = 'a former member'

/** Display name for a user id on this hunt, or "a former member" once the account has left (#160). */
export function personName(people: Readonly<Record<string, string>>, id: string | null | undefined): string {
  return (id && people[id]) || FORMER_MEMBER
}

/** Who proposed a search: the agent's name, or the person. An agent acting for someone names them too. */
export function proposerText(people: Readonly<Record<string, string>>, p: { proposedByType: 'user' | 'agent'; proposedById: string; requestedBy: string | null }): string {
  if (p.proposedByType === 'user') return personName(people, p.proposedById)
  return p.requestedBy ? `agent ${p.proposedById}, for ${personName(people, p.requestedBy)}` : `agent ${p.proposedById}`
}

/** True when the query that ran is not the one the agent or analyst proposed (#160). */
export function editedBeforeApproval(p: { kql: string; originalKql: string }): boolean {
  return p.kql.trim() !== p.originalKql.trim()
}
