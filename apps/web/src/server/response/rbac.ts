import type { OrgRole } from '../orgs'
import { env } from '../env'

/**
 * RBAC (#55). Roles: owner (implicit approver), approver, analyst (default for new members).
 * - propose: any member (and agents acting for a member)
 * - approve/reject/execute/dry-run: owner or approver
 * - self-approval (deciding a proposal you requested) is denied unless RESPONSE_ALLOW_SELF_APPROVAL=true
 */
export const APPROVER_ROLES: readonly OrgRole[] = ['owner', 'approver']

export function canApprove(role: OrgRole) {
  return APPROVER_ROLES.includes(role)
}

export function canManageMembers(role: OrgRole) {
  return role === 'owner'
}

export class ForbiddenError extends Error {}

export function assertCanDecide(role: OrgRole, userId: string, proposal: { requestedByUserId: string | null }) {
  if (!canApprove(role)) throw new ForbiddenError('Only owners and approvers can decide response proposals.')
  if (!env().RESPONSE_ALLOW_SELF_APPROVAL && proposal.requestedByUserId === userId) {
    throw new ForbiddenError('You requested this proposal, so you cannot approve it. Ask another approver (self-approval is off).')
  }
}
