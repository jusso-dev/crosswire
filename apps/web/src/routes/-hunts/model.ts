import type { fetchHunt } from '../../fns/hunts'
import { plural } from '../../components/format'
import { kqlApprovalBlock } from '../../shared/kql-approval'
import { coverageOf } from '../../shared/indicator-playbooks'
import type { Row } from '../../components/results'

/** Types and small pure helpers shared by the hunt workspace modules. */
export type Data = Awaited<ReturnType<typeof fetchHunt>> & {}
export type Proposal = Data['proposals'][number]
export type Schedule = Data['schedules'][number]
export type Summary = { mode?: string; rowCount?: number; truncated?: boolean; columns?: string[]; sample?: Row[]; durationMs?: number; sampleExpired?: boolean; sampleRetentionDays?: number }
export type ApprovalContext = { policy: Data['kqlApprovalPolicy']; canApprove: boolean; userId: string; role: string }

/**
 * Why this person cannot approve this proposal under KQL_APPROVAL_POLICY, or null when they can.
 * Same rules as the server (src/shared/kql-approval.ts); approveAndRunKql enforces them.
 */
export function approvalBlock(a: ApprovalContext, p: Proposal, edited: boolean): string | null {
  const block = kqlApprovalBlock(a.policy, { userId: a.userId, role: a.role }, p, edited)
  if (block === 'needs-approver') return 'Your organisation requires an approver to run searches.'
  if (block === 'own-request') return 'Another approver must run this search. You asked for it, and your organisation requires a second person to approve searches.'
  if (block === 'edited') return 'Your organisation requires a second person to approve searches, so an edited search must be proposed as a new search. Restore the original to approve it, or propose your edit.'
  return null
}

export function coverageFor(proposals: Proposal[]) {
  return coverageOf(
    [...proposals].reverse().map((proposal) => ({
      rationale: proposal.rationale,
      kql: proposal.kql,
      target: proposal.target,
      status: proposal.status,
      resultSummary:
        proposal.resultSummary && typeof proposal.resultSummary === 'object' && !Array.isArray(proposal.resultSummary)
          ? (proposal.resultSummary as { rowCount?: number })
          : null,
    })),
  )
}

/** Plain message in place of the result grid once retention has removed a stored sample. */
export function expiredSampleText(s: Summary) {
  return s.sampleRetentionDays
    ? `Sample removed after ${plural(s.sampleRetentionDays, 'day')} (retention). The row count and columns are kept.`
    : 'Sample removed by the retention policy. The row count and columns are kept.'
}

export function summaryOf(p: Proposal): Summary | null {
  return (p.resultSummary as Summary | null) ?? null
}
