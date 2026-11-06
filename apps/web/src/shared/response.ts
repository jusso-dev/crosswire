import type { JsonObject } from './json'

/**
 * Response proposal shared types (#28, #50). The DB table `response_proposals` is the source of
 * truth; this module is what UI and agents import. Keep both in sync.
 */
export const RESPONSE_ACTION_TYPES = ['sentinel_playbook', 'logic_app', 'graph_containment', 'other'] as const
export type ResponseActionType = (typeof RESPONSE_ACTION_TYPES)[number]

export const RESPONSE_STATUSES = ['pending', 'approved', 'rejected', 'expired', 'executed', 'failed'] as const
export type ResponseStatus = (typeof RESPONSE_STATUSES)[number]

export interface BlastRadius {
  summary: string
  devices: number
  users: number
  incidents: number
}

export interface ResponseTargets {
  devices?: string[]
  users?: string[]
  incidents?: string[]
}

export interface ResponseProposalView {
  id: string
  huntId: string | null
  title: string
  actionType: ResponseActionType
  targets: ResponseTargets
  blastRadius: BlastRadius
  payload: JsonObject
  requesterType: 'user' | 'agent'
  requesterId: string
  status: ResponseStatus
  expiresAt: string
  createdAt: string
  decidedBy: string | null
  decidedAt: string | null
  decisionComment: string | null
  lastDryRun: JsonObject | null
  execution: JsonObject | null
  rollbackNotes: string | null
}
