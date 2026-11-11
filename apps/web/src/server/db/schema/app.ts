import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import { user } from './auth'

const id = () =>
  text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID())
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date())
const orgRef = () =>
  text('org_id')
    .notNull()
    .references(() => orgs.id, { onDelete: 'cascade' })

// ---------- Tenancy (#21) ----------
export const orgRole = pgEnum('org_role', ['owner', 'approver', 'analyst'])

export const orgs = pgTable('orgs', {
  id: id(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  entraTenantId: text('entra_tenant_id').unique(),
  emailDomain: text('email_domain'),
  isPersonal: boolean('is_personal').notNull().default(false),
  /** Set by `pnpm bootstrap` (#78): the first Entra/SAML sign-in with this email becomes owner. */
  bootstrapOwnerEmail: text('bootstrap_owner_email'),
  /** Owner setting (#195): when true, an Entra sign-in that matches no group or app-role mapping is refused. */
  entraRequireMappedGroup: boolean('entra_require_mapped_group').notNull().default(false),
  /** First-run checklist dismissed (#79). */
  setupDismissedAt: timestamp('setup_dismissed_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const orgMemberships = pgTable(
  'org_memberships',
  {
    id: id(),
    orgId: orgRef(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    role: orgRole('role').notNull().default('analyst'),
    /** 'entra' when the role was set from an Entra group or app-role mapping at sign-in (#195), else 'manual'. */
    roleSource: text('role_source').$type<'manual' | 'entra'>().notNull().default('manual'),
    /** #102: confirmed address for digest email (used instead of the sign-in email when set). */
    digestEmail: text('digest_email'),
    /** Address awaiting confirmation, with a SHA-256 hash of the emailed token and its expiry. */
    digestEmailPending: text('digest_email_pending'),
    digestEmailTokenHash: text('digest_email_token_hash'),
    digestEmailTokenExpiresAt: timestamp('digest_email_token_expires_at', { withTimezone: true }),
    /** When the last confirmation link was requested. Clear and confirm leave it, so the resend limit holds. */
    digestEmailRequestedAt: timestamp('digest_email_requested_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('org_memberships_org_user_uq').on(t.orgId, t.userId), index('org_memberships_user_idx').on(t.userId)],
)

/**
 * People an owner removed from an org (#195). SSO places people into their org on every sign-in, so
 * this row keeps a removed person out. Delete the row to let them back in (docs/auth.md).
 */
export const orgMemberRemovals = pgTable(
  'org_member_removals',
  {
    id: id(),
    orgId: orgRef(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    removedBy: text('removed_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('org_member_removals_org_user_uq').on(t.orgId, t.userId)],
)

/**
 * Entra group or app-role mappings (#195). `kind` 'group' matches a group object id in the ID token's
 * `groups` claim; 'app_role' matches a value in its `roles` claim. Each maps to one Crosswire role.
 * Mappings belong to one org; the org itself is still chosen by the token's tenant id.
 */
export const entraRoleMappings = pgTable(
  'entra_role_mappings',
  {
    id: id(),
    orgId: orgRef(),
    kind: text('kind').$type<'group' | 'app_role'>().notNull(),
    value: text('value').notNull(),
    role: orgRole('role').notNull(),
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('entra_role_mappings_org_kind_value_uq').on(t.orgId, t.kind, t.value)],
)

// ---------- Audit (#22, shared shape) ----------
export const auditCategory = pgEnum('audit_category', ['auth', 'agent', 'memory', 'ti', 'hunt', 'response', 'system'])

export const auditEvents = pgTable(
  'audit_events',
  {
    id: id(),
    orgId: text('org_id').references(() => orgs.id, { onDelete: 'set null' }),
    category: auditCategory('category').notNull(),
    action: text('action').notNull(),
    result: text('result', { enum: ['success', 'failure'] }).notNull().default('success'),
    actorType: text('actor_type', { enum: ['user', 'agent', 'system'] }).notNull(),
    actorId: text('actor_id'),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    targetType: text('target_type'),
    targetId: text('target_id'),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index('audit_events_org_created_idx').on(t.orgId, t.createdAt), index('audit_events_category_idx').on(t.category, t.createdAt), index('audit_events_created_idx').on(t.createdAt)],
)

// ---------- Chat (#26, #27) ----------
export const chatThreads = pgTable(
  'chat_threads',
  {
    id: id(),
    orgId: orgRef(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    title: text('title').notNull().default('New thread'),
    agentKey: text('agent_key').notNull().default('lead'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('chat_threads_org_user_idx').on(t.orgId, t.userId, t.updatedAt)],
)

export const chatMessages = pgTable(
  'chat_messages',
  {
    id: id(),
    orgId: orgRef(),
    threadId: text('thread_id')
      .notNull()
      .references(() => chatThreads.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['user', 'assistant', 'system'] }).notNull(),
    content: text('content').notNull(),
    agentKey: text('agent_key'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index('chat_messages_thread_idx').on(t.threadId, t.createdAt), index('chat_messages_created_idx').on(t.createdAt)],
)

export const messageFeedback = pgTable(
  'message_feedback',
  {
    id: id(),
    orgId: orgRef(),
    messageId: text('message_id')
      .notNull()
      .references(() => chatMessages.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    rating: text('rating', { enum: ['useful', 'wrong', 'escalate'] }).notNull(),
    rationale: text('rationale'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('message_feedback_msg_user_uq').on(t.messageId, t.userId)],
)

// ---------- Agent memory + decisions (#31, #33, #35) ----------
export const agentMemories = pgTable(
  'agent_memories',
  {
    id: id(),
    orgId: orgRef(),
    agentKey: text('agent_key').notNull(),
    body: text('body').notNull().default(''),
    version: integer('version').notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('agent_memories_org_agent_uq').on(t.orgId, t.agentKey)],
)

export const agentMemoryEntries = pgTable(
  'agent_memory_entries',
  {
    id: id(),
    orgId: orgRef(),
    agentKey: text('agent_key').notNull(),
    kind: text('kind', { enum: ['fact', 'feedback', 'safety', 'summary'] }).notNull().default('fact'),
    body: text('body').notNull(),
    sourceType: text('source_type'),
    sourceId: text('source_id'),
    redacted: boolean('redacted').notNull().default(false),
    /** operator: written by a person or a safety rule. quarantine: not for the model. reviewed: a different person promoted it. */
    trust: text('trust', { enum: ['operator', 'quarantine', 'reviewed'] }).notNull().default('operator'),
    visibility: text('visibility', { enum: ['private_case', 'org'] }).notNull().default('org'),
    sdkClass: text('sdk_class'),
    sdkAllowed: boolean('sdk_allowed'),
    authorId: text('author_id'),
    promotedBy: text('promoted_by'),
    promotedAt: timestamp('promoted_at', { withTimezone: true }),
    supersededBy: text('superseded_by'),
    tombstonedAt: timestamp('tombstoned_at', { withTimezone: true }),
    contentSha256: text('content_sha256'),
    compactedAt: timestamp('compacted_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('agent_memory_entries_org_agent_idx').on(t.orgId, t.agentKey, t.createdAt)],
)

export const agentDecisions = pgTable(
  'agent_decisions',
  {
    id: id(),
    orgId: orgRef(),
    actorType: text('actor_type', { enum: ['agent', 'user', 'system'] }).notNull(),
    actorKey: text('actor_key').notNull(),
    action: text('action').notNull(),
    inputSummary: text('input_summary').notNull().default(''),
    outputSummary: text('output_summary').notNull().default(''),
    threadId: text('thread_id'),
    huntId: text('hunt_id'),
    createdAt: createdAt(),
  },
  (t) => [index('agent_decisions_org_created_idx').on(t.orgId, t.createdAt), index('agent_decisions_created_idx').on(t.createdAt)],
)

// ---------- Threat intel (#36, #37, #42) — global, not org-scoped ----------
export const tiFetchCache = pgTable('ti_fetch_cache', {
  url: text('url').primaryKey(),
  etag: text('etag'),
  lastModified: text('last_modified'),
  status: integer('status').notNull(),
  body: text('body').notNull(),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull(),
})

export const pwnIncidents = pgTable(
  'pwn_incidents',
  {
    slug: text('slug').primaryKey(),
    title: text('title').notNull(),
    summary: text('summary').notNull().default(''),
    category: text('category'),
    severity: text('severity'),
    status: text('status'),
    patchStatus: text('patch_status'),
    product: text('product'),
    tags: text('tags').array().notNull().default([]),
    stacks: text('stacks').array().notNull().default([]),
    cveIds: text('cve_ids').array().notNull().default([]),
    startedAt: text('started_at'),
    upstreamUpdatedAt: text('upstream_updated_at'),
    url: text('url').notNull(),
    source: text('source').notNull().default('pwn.watch'),
    sourceUrl: text('source_url').notNull(),
    retrievedAt: timestamp('retrieved_at', { withTimezone: true }).notNull(),
    raw: jsonb('raw').$type<Record<string, unknown>>().notNull(),
  },
  (t) => [index('pwn_incidents_retrieved_idx').on(t.retrievedAt)],
)

export const pwnChanges = pgTable('pwn_changes', {
  id: text('id').primaryKey(),
  incidentSlug: text('incident_slug').notNull(),
  incidentTitle: text('incident_title'),
  category: text('category'),
  severity: text('severity'),
  status: text('status'),
  date: text('date'),
  title: text('title').notNull(),
  body: text('body'),
  url: text('url'),
  upstreamSourceUrl: text('upstream_source_url'),
  source: text('source').notNull().default('pwn.watch'),
  sourceUrl: text('source_url').notNull(),
  retrievedAt: timestamp('retrieved_at', { withTimezone: true }).notNull(),
})

export const pwnTags = pgTable('pwn_tags', {
  id: text('id').primaryKey(),
  label: text('label').notNull(),
  group: text('group'),
  groupLabel: text('group_label'),
  incidents: integer('incidents').notNull().default(0),
  url: text('url'),
  source: text('source').notNull().default('pwn.watch'),
  sourceUrl: text('source_url').notNull(),
  retrievedAt: timestamp('retrieved_at', { withTimezone: true }).notNull(),
})

/** Generic CVE store so CISA KEV, NVD, cve.watch (if it returns) share one shape. */
export const cveRecords = pgTable(
  'cve_records',
  {
    id: id(),
    source: text('source', { enum: ['cisa-kev', 'nvd', 'cve.watch'] }).notNull(),
    cveId: text('cve_id').notNull(),
    vendor: text('vendor'),
    product: text('product'),
    title: text('title'),
    description: text('description'),
    severity: text('severity'),
    publishedAt: text('published_at'),
    dueDate: text('due_date'),
    knownRansomware: text('known_ransomware'),
    url: text('url'),
    sourceUrl: text('source_url').notNull(),
    retrievedAt: timestamp('retrieved_at', { withTimezone: true }).notNull(),
    raw: jsonb('raw').$type<Record<string, unknown>>().notNull(),
  },
  (t) => [uniqueIndex('cve_records_source_cve_uq').on(t.source, t.cveId), index('cve_records_cve_idx').on(t.cveId)],
)

// ---------- Watchlists (#38, #39, #40) ----------
export const watchType = pgEnum('watch_type', ['keyword', 'cve', 'vendor', 'tag'])

export const watchEntries = pgTable(
  'watch_entries',
  {
    id: id(),
    orgId: orgRef(),
    type: watchType('type').notNull(),
    value: text('value').notNull(),
    normalized: text('normalized').notNull(),
    notes: text('notes'),
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
  },
  (t) => [index('watch_entries_org_idx').on(t.orgId)],
)

export const watchHits = pgTable(
  'watch_hits',
  {
    id: id(),
    orgId: orgRef(),
    entryId: text('entry_id')
      .notNull()
      .references(() => watchEntries.id, { onDelete: 'cascade' }),
    source: text('source').notNull(),
    sourceId: text('source_id').notNull(),
    title: text('title').notNull(),
    snippet: text('snippet').notNull().default(''),
    url: text('url'),
    cveIds: text('cve_ids').array().notNull().default([]),
    createdAt: createdAt(),
    seenAt: timestamp('seen_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('watch_hits_dedupe_uq').on(t.orgId, t.entryId, t.source, t.sourceId),
    index('watch_hits_org_created_idx').on(t.orgId, t.createdAt),
  ],
)

export const digests = pgTable(
  'digests',
  {
    id: id(),
    orgId: orgRef(),
    day: date('day').notNull(),
    hitCount: integer('hit_count').notNull().default(0),
    items: jsonb('items').$type<Array<{ hitId: string; title: string; url: string | null; source: string; entry: string }>>().notNull().default([]),
    emailedAt: timestamp('emailed_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('digests_org_day_uq').on(t.orgId, t.day)],
)

// ---------- Hunting (#44 - #49) ----------
export const orgConnectors = pgTable('org_connectors', {
  id: id(),
  orgId: orgRef().unique(),
  tenantId: text('tenant_id').notNull(),
  clientId: text('client_id').notNull(),
  /** AES-256-GCM ciphertext (APP_ENCRYPTION_KEY). Never returned to clients. */
  clientSecretEnc: text('client_secret_enc'),
  /** Alternative to clientSecretEnc: an env var or Key Vault secret name, resolved server-side. */
  clientSecretRef: text('client_secret_ref'),
  sentinelSubscriptionId: text('sentinel_subscription_id'),
  sentinelResourceGroup: text('sentinel_resource_group'),
  sentinelWorkspaceName: text('sentinel_workspace_name'),
  sentinelWorkspaceId: text('sentinel_workspace_id'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const huntCases = pgTable(
  'hunt_cases',
  {
    id: id(),
    orgId: orgRef(),
    title: text('title').notNull(),
    hypothesis: text('hypothesis').notNull().default(''),
    status: text('status', { enum: ['open', 'closed'] }).notNull().default('open'),
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    threadId: text('thread_id').references(() => chatThreads.id, { onDelete: 'set null' }),
    watchHitId: text('watch_hit_id').references(() => watchHits.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('hunt_cases_org_idx').on(t.orgId, t.updatedAt)],
)

export const huntEvidence = pgTable(
  'hunt_evidence',
  {
    id: id(),
    orgId: orgRef(),
    huntId: text('hunt_id')
      .notNull()
      .references(() => huntCases.id, { onDelete: 'cascade' }),
    type: text('type', {
      enum: [
        'note',
        'kql_proposed',
        'kql_approved',
        'kql_rejected',
        'kql_result',
        'kql_failed',
        'incidents',
        'response_proposed',
        'schedule_created',
        'schedule_disabled',
        'scheduled_result',
        'scheduled_failed',
      ],
    }).notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    actorType: text('actor_type', { enum: ['user', 'agent', 'system'] }).notNull(),
    actorId: text('actor_id'),
    createdAt: createdAt(),
  },
  (t) => [index('hunt_evidence_hunt_idx').on(t.huntId, t.createdAt), index('hunt_evidence_created_idx').on(t.createdAt)],
)

export const kqlStatus = pgEnum('kql_status', ['proposed', 'approved', 'rejected', 'run', 'failed', 'expired'])

export const kqlProposals = pgTable(
  'kql_proposals',
  {
    id: id(),
    orgId: orgRef(),
    huntId: text('hunt_id')
      .notNull()
      .references(() => huntCases.id, { onDelete: 'cascade' }),
    target: text('target', { enum: ['defender', 'sentinel'] }).notNull(),
    kql: text('kql').notNull(),
    originalKql: text('original_kql').notNull(),
    rationale: text('rationale').notNull().default(''),
    status: kqlStatus('status').notNull().default('proposed'),
    proposedByType: text('proposed_by_type', { enum: ['user', 'agent'] }).notNull(),
    proposedById: text('proposed_by_id').notNull(),
    /** The person who asked for the search: the proposer, or the chat user behind an agent proposal. */
    requestedBy: text('requested_by'),
    decidedBy: text('decided_by'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    ranAt: timestamp('ran_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    resultSummary: jsonb('result_summary').$type<Record<string, unknown>>(),
    error: text('error'),
    createdAt: createdAt(),
  },
  (t) => [index('kql_proposals_hunt_idx').on(t.huntId, t.createdAt)],
)

/** Org-saved indicator playbooks. Built-in IP, domain, and hash packs stay in code. */
export const huntPlaybooks = pgTable(
  'hunt_playbooks',
  {
    id: id(),
    orgId: orgRef(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    indicatorKind: text('indicator_kind', { enum: ['ip', 'domain', 'hash'] }).notNull(),
    checks: jsonb('checks').$type<Array<{ name: string; target: 'defender' | 'sentinel'; kql: string }>>().notNull(),
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('hunt_playbooks_org_idx').on(t.orgId, t.updatedAt), uniqueIndex('hunt_playbooks_org_name_uq').on(t.orgId, t.name)],
)

// ---------- Response (#50 - #56) ----------
export const responseActionType = pgEnum('response_action_type', ['sentinel_playbook', 'logic_app', 'graph_containment', 'other'])
export const responseStatus = pgEnum('response_status', ['pending', 'approved', 'rejected', 'expired', 'executed', 'failed'])

export const responseProposals = pgTable(
  'response_proposals',
  {
    id: id(),
    orgId: orgRef(),
    huntId: text('hunt_id').references(() => huntCases.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    actionType: responseActionType('action_type').notNull(),
    targets: jsonb('targets').$type<{ devices?: string[]; users?: string[]; incidents?: string[] }>().notNull(),
    blastRadius: jsonb('blast_radius').$type<{ summary: string; devices: number; users: number; incidents: number }>().notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    /** sha256 of canonical approval content (schema, title, action, targets, blast radius, payload). Execution refuses a mismatch when APPROVAL_BINDING=enforced. */
    payloadSha256: text('payload_sha256'),
    payloadSchemaVersion: integer('payload_schema_version').notNull().default(1),
    requesterType: text('requester_type', { enum: ['user', 'agent'] }).notNull(),
    requesterId: text('requester_id').notNull(),
    requestedByUserId: text('requested_by_user_id'),
    status: responseStatus('status').notNull().default('pending'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    decidedBy: text('decided_by'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decisionComment: text('decision_comment'),
    lastDryRun: jsonb('last_dry_run').$type<Record<string, unknown>>(),
    execution: jsonb('execution').$type<Record<string, unknown>>(),
    rollbackNotes: text('rollback_notes'),
    /** v2 (#90): this proposal reverses `rollback_of_id`. At most one rollback per original. */
    rollbackOfId: text('rollback_of_id').references((): AnyPgColumn => responseProposals.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('response_proposals_org_status_idx').on(t.orgId, t.status, t.createdAt),
    // One live rollback per original; a rejected/expired/failed rollback can be proposed again.
    uniqueIndex('response_proposals_rollback_of_uq')
      .on(t.rollbackOfId)
      .where(sql`${t.rollbackOfId} IS NOT NULL AND ${t.status} IN ('pending', 'approved', 'executed')`),
  ],
)

export const responseEvents = pgTable(
  'response_events',
  {
    id: id(),
    orgId: orgRef(),
    proposalId: text('proposal_id')
      .notNull()
      .references(() => responseProposals.id, { onDelete: 'cascade' }),
    event: text('event', {
      enum: ['created', 'dry_run', 'approved', 'rejected', 'expired', 'execute_attempt', 'executed', 'execute_failed', 'rollback_proposed'],
    }).notNull(),
    actorType: text('actor_type', { enum: ['user', 'agent', 'system'] }).notNull(),
    actorId: text('actor_id'),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index('response_events_proposal_idx').on(t.proposalId, t.createdAt)],
)

// SAML provider -> Crosswire org binding (#65). Crosswire owns orgs; Better Auth's organization plugin is not used.
export const ssoOrgBindings = pgTable('sso_org_bindings', {
  providerId: text('provider_id').primaryKey(),
  orgId: orgRef(),
  createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
})

// ---------- v2: response connector (#88) ----------
/**
 * Response credentials, separate from the read-only hunting connector. Only response executors
 * mint tokens from this row; the hunting client can never use it, and response never uses hunting's.
 */
export const orgResponseConnectors = pgTable('org_response_connectors', {
  id: id(),
  orgId: orgRef().unique(),
  tenantId: text('tenant_id').notNull(),
  clientId: text('client_id').notNull(),
  clientSecretEnc: text('client_secret_enc'),
  clientSecretRef: text('client_secret_ref'),
  /** Owner-managed allowlist of Logic App resource ids a Sentinel playbook proposal may run. */
  playbookAllowlist: text('playbook_allowlist').array().notNull().default([]),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

// ---------- v2: notifications (#91) ----------
export const notificationKind = pgEnum('notification_kind', ['teams', 'slack'])

export const orgNotificationChannels = pgTable(
  'org_notification_channels',
  {
    id: id(),
    orgId: orgRef(),
    kind: notificationKind('kind').notNull(),
    name: text('name').notNull(),
    /** AES-GCM ciphertext of the webhook URL (the URL is a bearer secret). Never returned to clients. */
    urlEnc: text('url_enc').notNull(),
    /** Host only, for display. */
    urlHost: text('url_host').notNull(),
    events: text('events').array().notNull().default([]),
    enabled: boolean('enabled').notNull().default(true),
    lastStatus: text('last_status'),
    lastSentAt: timestamp('last_sent_at', { withTimezone: true }),
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [index('org_notification_channels_org_idx').on(t.orgId)],
)

// ---------- v2: scheduled hunts (#92) ----------
export const huntSchedules = pgTable(
  'hunt_schedules',
  {
    id: id(),
    orgId: orgRef(),
    huntId: text('hunt_id')
      .notNull()
      .references(() => huntCases.id, { onDelete: 'cascade' }),
    sourceProposalId: text('source_proposal_id').references(() => kqlProposals.id, { onDelete: 'set null' }),
    target: text('target', { enum: ['defender', 'sentinel'] }).notNull(),
    /** Frozen copy of the KQL that a human approved and ran. Never edited in place. */
    kql: text('kql').notNull(),
    intervalMinutes: integer('interval_minutes').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    approvedBy: text('approved_by').notNull(),
    approvedAt: timestamp('approved_at', { withTimezone: true }).notNull(),
    approvalExpiresAt: timestamp('approval_expires_at', { withTimezone: true }).notNull(),
    nextRunAt: timestamp('next_run_at', { withTimezone: true }).notNull(),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    lastStatus: text('last_status'),
    lastRowCount: integer('last_row_count'),
    lastError: text('last_error'),
    disabledReason: text('disabled_reason'),
    createdAt: createdAt(),
  },
  (t) => [index('hunt_schedules_due_idx').on(t.enabled, t.nextRunAt), index('hunt_schedules_hunt_idx').on(t.huntId)],
)

// ---------- Rate limits shared across replicas ----------
export const appRateLimits = pgTable('app_rate_limits', {
  key: text('key').primaryKey(),
  count: integer('count').notNull(),
  windowStartedAt: timestamp('window_started_at', { withTimezone: true }).notNull(),
  /** End of this row's own window. The sweep deletes by it, so limiters with different windows can share the table. */
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
})

// ---------- Squad governance: runs, budgets, directives (CW-SDK-003, 005, 007, 008) ----------
export const agentRuns = pgTable(
  'agent_runs',
  {
    id: id(),
    orgId: orgRef(),
    parentRunId: text('parent_run_id').references((): AnyPgColumn => agentRuns.id, { onDelete: 'set null' }),
    threadId: text('thread_id'),
    agentKey: text('agent_key').notNull(),
    status: text('status', { enum: ['running', 'completed', 'failed', 'interrupted'] }).notNull().default('running'),
    modelProvider: text('model_provider'),
    modelName: text('model_name'),
    charterSha256: text('charter_sha256'),
    policySha256: text('policy_sha256'),
    toolsetSha256: text('toolset_sha256'),
    memorySha256: text('memory_sha256'),
    sdkVersion: text('sdk_version'),
    cancelRequestedAt: timestamp('cancel_requested_at', { withTimezone: true }),
    /** Set only after acquireSlot succeeds for this row. Reconcile must not decrement a run that never held a slot. */
    slotHeld: boolean('slot_held').notNull().default(false),
    /** Set when this row's slot is returned. A second release, including one from another process, does not decrement again. */
    slotReleased: boolean('slot_released').notNull().default(false),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [index('agent_runs_org_status_idx').on(t.orgId, t.status, t.startedAt), index('agent_runs_parent_idx').on(t.parentRunId)],
)

export const agentRunEvents = pgTable(
  'agent_run_events',
  {
    id: id(),
    orgId: orgRef(),
    runId: text('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    kind: text('kind').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('agent_run_events_run_seq_uq').on(t.runId, t.seq)],
)

export const agentRunOutputs = pgTable(
  'agent_run_outputs',
  {
    id: id(),
    orgId: orgRef(),
    runId: text('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    body: text('body').notNull(),
    contentSha256: text('content_sha256').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('agent_run_outputs_run_idx').on(t.runId, t.createdAt)],
)

export const agentUsage = pgTable(
  'agent_usage',
  {
    id: id(),
    orgId: orgRef(),
    runId: text('run_id').references(() => agentRuns.id, { onDelete: 'set null' }),
    agentKey: text('agent_key').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    estimatedCostMicros: integer('estimated_cost_micros'),
    observed: boolean('observed').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [index('agent_usage_org_created_idx').on(t.orgId, t.createdAt)],
)

/** Shared inflight count. Acquire is one conditional update so replicas cannot oversubscribe. */
export const agentCapacity = pgTable('agent_capacity', {
  orgId: text('org_id')
    .primaryKey()
    .references(() => orgs.id, { onDelete: 'cascade' }),
  inflight: integer('inflight').notNull().default(0),
})

export const orgDirectives = pgTable(
  'org_directives',
  {
    id: id(),
    orgId: orgRef(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    version: integer('version').notNull().default(1),
    contentSha256: text('content_sha256').notNull(),
    status: text('status', { enum: ['draft', 'approved', 'retired'] }).notNull().default('draft'),
    source: text('source', { enum: ['operator', 'lesson', 'review', 'import'] }).notNull().default('operator'),
    createdBy: text('created_by'),
    approvedBy: text('approved_by'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    supersedes: text('supersedes'),
    provenance: jsonb('provenance').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index('org_directives_org_status_idx').on(t.orgId, t.status, t.createdAt)],
)

export const socReviews = pgTable('soc_reviews', {
  id: id(),
  orgId: orgRef(),
  incidentRef: text('incident_ref').notNull(),
  body: text('body').notNull(),
  createdBy: text('created_by'),
  createdAt: createdAt(),
})

export const socHandovers = pgTable('soc_handovers', {
  id: id(),
  orgId: orgRef(),
  shiftLabel: text('shift_label').notNull(),
  body: text('body').notNull(),
  createdBy: text('created_by'),
  createdAt: createdAt(),
})
