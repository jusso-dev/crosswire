import { and, asc, eq } from 'drizzle-orm'
import { getDb } from '../db/client'
import { orgNotificationChannels } from '../db/schema'
import { env } from '../env'
import { decryptSecret, encryptSecret } from '../lib/crypto'
import { redactString, truncate } from '../lib/redact'
import { logger } from '../lib/logger'
import { writeAudit } from '../audit'

/**
 * Teams / Slack webhook notifications (#91). Webhook URLs are bearer secrets: stored encrypted, never
 * returned, never logged. Payloads carry titles, counts and deep links only (no KQL results, no
 * secrets). Delivery never throws into the caller: a broken webhook cannot fail an approval, a
 * matcher run or an execution.
 */
export const NOTIFY_EVENTS = ['watch_hit', 'approval_pending', 'execution', 'scheduled_hunt'] as const
export type NotifyEvent = (typeof NOTIFY_EVENTS)[number]
export type ChannelKind = 'teams' | 'slack'

export interface NotifyMessage {
  title: string
  lines?: string[]
  /** App-relative path (e.g. /app/approvals/<id>); APP_URL is prepended. */
  link?: string
}

const HOSTS: Record<ChannelKind, Array<(h: string) => boolean>> = {
  slack: [(h) => h === 'hooks.slack.com'],
  teams: [
    // Teams Workflows (Power Automate) webhooks, and legacy Office 365 connectors.
    (h) => /^[a-z0-9-]+(\.[a-z0-9-]+)*\.logic\.azure\.com$/.test(h),
    (h) => /^[a-z0-9-]+(\.[a-z0-9-]+)*\.api\.powerplatform\.com$/.test(h),
    (h) => /^[a-z0-9-]+\.webhook\.office\.com$/.test(h),
  ],
}

export class WebhookUrlError extends Error {}

/** Validate a webhook URL for a channel kind: https, default port, no credentials, allowlisted host. */
export function assertWebhookUrl(kind: ChannelKind, raw: string): URL {
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    throw new WebhookUrlError('Webhook URL is not a valid URL.')
  }
  if (u.protocol !== 'https:') throw new WebhookUrlError('Webhook URL must use https.')
  if (u.username || u.password) throw new WebhookUrlError('Webhook URL must not contain credentials.')
  if (u.port && u.port !== '443') throw new WebhookUrlError('Webhook URL must use the default https port.')
  const host = u.hostname.toLowerCase()
  if (!HOSTS[kind].some((ok) => ok(host))) {
    throw new WebhookUrlError(
      kind === 'slack'
        ? 'Slack webhooks must be on hooks.slack.com.'
        : 'Teams webhooks must be a Teams Workflows URL (*.logic.azure.com or *.api.powerplatform.com) or *.webhook.office.com.',
    )
  }
  return u
}

const appLink = (path?: string) => (path ? `${env().APP_URL.replace(/\/$/, '')}${path}` : undefined)

/** Build the provider payload. Every string is redacted and truncated. */
export function buildPayload(kind: ChannelKind, msg: NotifyMessage) {
  const title = truncate(redactString(msg.title), 200)
  const lines = (msg.lines ?? []).slice(0, 10).map((l) => truncate(redactString(l), 300))
  const url = appLink(msg.link)
  if (kind === 'slack') {
    return {
      text: title,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: `*${title}*${lines.length ? `\n${lines.join('\n')}` : ''}` } },
        ...(url ? [{ type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Open in Crosswire' }, url }] }] : []),
      ],
    }
  }
  return {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.4',
          body: [{ type: 'TextBlock', text: title, weight: 'Bolder', wrap: true }, ...lines.map((l) => ({ type: 'TextBlock', text: l, wrap: true, isSubtle: true }))],
          actions: url ? [{ type: 'Action.OpenUrl', title: 'Open in Crosswire', url }] : [],
        },
      },
    ],
  }
}

let fetchImpl: typeof fetch = (...args) => fetch(...args)
/** Test hook. */
export function setNotifyFetch(f: typeof fetch) {
  fetchImpl = f
}

async function post(kind: ChannelKind, url: string, msg: NotifyMessage): Promise<{ ok: boolean; status: string }> {
  try {
    assertWebhookUrl(kind, url)
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildPayload(kind, msg)),
      redirect: 'error',
      signal: AbortSignal.timeout(5_000),
    })
    return { ok: res.ok, status: `HTTP ${res.status}` }
  } catch (err) {
    // Never include the URL: it is the secret.
    return { ok: false, status: err instanceof WebhookUrlError ? err.message : err instanceof Error ? err.name : 'error' }
  }
}

/** Fan a message out to every enabled channel subscribed to `event`. Never throws. */
export async function notify(orgId: string, event: NotifyEvent, msg: NotifyMessage): Promise<{ sent: number; failed: number }> {
  let sent = 0
  let failed = 0
  try {
    if (!env().NOTIFICATIONS_ENABLED) return { sent, failed }
    const channels = await getDb()
      .select()
      .from(orgNotificationChannels)
      .where(and(eq(orgNotificationChannels.orgId, orgId), eq(orgNotificationChannels.enabled, true)))
    for (const c of channels.filter((ch) => ch.events.includes(event))) {
      const r = await post(c.kind, decryptSecret(c.urlEnc), msg)
      if (r.ok) sent++
      else failed++
      await getDb().update(orgNotificationChannels).set({ lastStatus: r.status, lastSentAt: new Date() }).where(eq(orgNotificationChannels.id, c.id))
      if (!r.ok) {
        logger.warn('notification delivery failed', { orgId, channelId: c.id, kind: c.kind, event, status: r.status })
        await writeAudit({ category: 'system', action: 'notification_failed', result: 'failure', actorType: 'system', orgId, targetType: 'notification_channel', targetId: c.id, data: { event, status: r.status } })
      }
    }
  } catch (err) {
    logger.error('notify failed', { orgId, event, error: err instanceof Error ? err.message : String(err) })
  }
  return { sent, failed }
}

// ---------- Channel management (owners) ----------
export interface ChannelView {
  id: string
  kind: ChannelKind
  name: string
  urlHost: string
  events: NotifyEvent[]
  enabled: boolean
  lastStatus: string | null
  lastSentAt: string | null
}

export async function listChannels(orgId: string): Promise<ChannelView[]> {
  const rows = await getDb().select().from(orgNotificationChannels).where(eq(orgNotificationChannels.orgId, orgId)).orderBy(asc(orgNotificationChannels.createdAt))
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    name: r.name,
    urlHost: r.urlHost,
    events: r.events.filter((e): e is NotifyEvent => (NOTIFY_EVENTS as readonly string[]).includes(e)),
    enabled: r.enabled,
    lastStatus: r.lastStatus,
    lastSentAt: r.lastSentAt?.toISOString() ?? null,
  }))
}

export async function addChannel(orgId: string, userId: string, input: { kind: ChannelKind; name: string; url: string; events: NotifyEvent[] }) {
  const u = assertWebhookUrl(input.kind, input.url)
  const events = [...new Set(input.events)].filter((e) => (NOTIFY_EVENTS as readonly string[]).includes(e))
  if (events.length === 0) throw new Error('Pick at least one event.')
  const existing = await getDb().select({ id: orgNotificationChannels.id }).from(orgNotificationChannels).where(eq(orgNotificationChannels.orgId, orgId))
  if (existing.length >= 10) throw new Error('At most 10 notification channels per org.')
  const [row] = await getDb()
    .insert(orgNotificationChannels)
    .values({ orgId, kind: input.kind, name: input.name.trim().slice(0, 100) || input.kind, urlEnc: encryptSecret(u.toString()), urlHost: u.hostname, events, createdBy: userId })
    .returning({ id: orgNotificationChannels.id })
  await writeAudit({ category: 'system', action: 'notification_channel_added', actorType: 'user', actorId: userId, orgId, targetType: 'notification_channel', targetId: row!.id, data: { kind: input.kind, host: u.hostname, events } })
  return row!.id
}

export async function updateChannel(orgId: string, userId: string, id: string, patch: { enabled?: boolean; events?: NotifyEvent[] }) {
  const set: Partial<typeof orgNotificationChannels.$inferInsert> = {}
  if (patch.enabled !== undefined) set.enabled = patch.enabled
  if (patch.events) set.events = [...new Set(patch.events)]
  const rows = await getDb().update(orgNotificationChannels).set(set).where(and(eq(orgNotificationChannels.orgId, orgId), eq(orgNotificationChannels.id, id))).returning({ id: orgNotificationChannels.id })
  if (!rows.length) throw new Error('Channel not found.')
  await writeAudit({ category: 'system', action: 'notification_channel_updated', actorType: 'user', actorId: userId, orgId, targetType: 'notification_channel', targetId: id, data: patch })
}

export async function deleteChannel(orgId: string, userId: string, id: string) {
  const rows = await getDb().delete(orgNotificationChannels).where(and(eq(orgNotificationChannels.orgId, orgId), eq(orgNotificationChannels.id, id))).returning({ id: orgNotificationChannels.id })
  if (!rows.length) throw new Error('Channel not found.')
  await writeAudit({ category: 'system', action: 'notification_channel_deleted', actorType: 'user', actorId: userId, orgId, targetType: 'notification_channel', targetId: id })
}

export async function testChannel(orgId: string, id: string) {
  const [c] = await getDb().select().from(orgNotificationChannels).where(and(eq(orgNotificationChannels.orgId, orgId), eq(orgNotificationChannels.id, id))).limit(1)
  if (!c) throw new Error('Channel not found.')
  const r = await post(c.kind, decryptSecret(c.urlEnc), { title: 'Crosswire test notification', lines: ['If you can read this, the channel works.'], link: '/app/settings' })
  await getDb().update(orgNotificationChannels).set({ lastStatus: r.status, lastSentAt: new Date() }).where(eq(orgNotificationChannels.id, c.id))
  return r
}
