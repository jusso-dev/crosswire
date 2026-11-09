/**
 * KQL_APPROVAL_POLICY rules, shared by the server (which enforces them in approveAndRunKql) and the
 * hunt workspace (which only explains them next to the Approve button). One function, so the two
 * can never disagree. Pure: no server imports, safe in client code.
 *
 * - member: any org member may approve and run (the original behaviour).
 * - approver: the caller's role must be owner or approver.
 * - second-person: owner or approver, and the caller is neither the person who asked for the search
 *   nor the user who proposed it, and the KQL is run exactly as proposed.
 */
export type KqlApprovalPolicy = 'member' | 'approver' | 'second-person'
export type KqlApprovalBlock = 'needs-approver' | 'own-request' | 'edited'

export const KQL_APPROVAL_MESSAGES: Record<KqlApprovalBlock, string> = {
  'needs-approver': 'Only owners and approvers can run searches in this organisation.',
  'own-request': 'You asked for this search, so another approver must run it. This organisation requires a second person to approve searches.',
  edited: 'This organisation requires a second person to approve searches, so a search cannot be edited at approval. Propose the edited search as a new search; another approver must then run it.',
}

const APPROVER_ROLES: readonly string[] = ['owner', 'approver']

/** Why this caller may not approve this proposal, or null when they may. */
export function kqlApprovalBlock(
  policy: KqlApprovalPolicy,
  caller: { userId: string; role: string | undefined },
  proposal: { requestedBy: string | null; proposedByType: 'user' | 'agent'; proposedById: string },
  edited: boolean,
): KqlApprovalBlock | null {
  if (policy === 'member') return null
  // A missing role fails closed: only callers that state an approver role get through.
  if (!caller.role || !APPROVER_ROLES.includes(caller.role)) return 'needs-approver'
  if (policy !== 'second-person') return null
  // Legacy rows (before requested_by existed) have requestedBy null: for a user proposal the
  // proposer is the requester; for an agent proposal the requester is unknown, so any other
  // approver may run it.
  const requester = proposal.requestedBy ?? (proposal.proposedByType === 'user' ? proposal.proposedById : null)
  if (requester === caller.userId || (proposal.proposedByType === 'user' && proposal.proposedById === caller.userId)) return 'own-request'
  if (edited) return 'edited'
  return null
}

/**
 * True when Approve all is safe to show: this caller may run every still-proposed search,
 * and the org does not require a second person. One blocked search hides the button.
 */
export function canApproveEveryProposal(
  policy: KqlApprovalPolicy,
  caller: { userId: string; role: string | undefined },
  proposals: Array<{ status: string; requestedBy: string | null; proposedByType: 'user' | 'agent'; proposedById: string }>,
): boolean {
  if (policy === 'second-person') return false
  const pending = proposals.filter((proposal) => proposal.status === 'proposed')
  if (pending.length === 0) return false
  return pending.every((proposal) => kqlApprovalBlock(policy, caller, proposal, false) === null)
}
