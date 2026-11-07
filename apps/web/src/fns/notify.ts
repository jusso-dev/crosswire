import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { authed } from './middleware'
import { addChannel, deleteChannel, listChannels, NOTIFY_EVENTS, testChannel, updateChannel } from '../server/notify/notify'
import { getResponseConnectorView, upsertResponseConnector } from '../server/response/connector'

const ownerOnly = (role: string) => {
  if (role !== 'owner') throw new Error('Only org owners can change this.')
}
const wrap = async <T>(fn: () => Promise<T>) => {
  try {
    return { ok: true as const, result: await fn() }
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
  }
}

// ---------- Notifications (#91) ----------
export const fetchChannels = createServerFn({ method: 'GET' })
  .middleware([authed])
  .handler(async ({ context }) => ({ canEdit: context.session.org.role === 'owner', channels: context.session.org.role === 'owner' ? await listChannels(context.session.org.id) : [] }))

export const addChannelFn = createServerFn({ method: 'POST' })
  .middleware([authed])
  .validator(z.object({ kind: z.enum(['teams', 'slack']), name: z.string().max(100), url: z.string().min(10).max(2000), events: z.array(z.enum(NOTIFY_EVENTS)).min(1) }))
  .handler(async ({ context, data }) =>
    wrap(async () => {
      ownerOnly(context.session.org.role)
      return { id: await addChannel(context.session.org.id, context.session.user.id, data) }
    }),
  )

export const updateChannelFn = createServerFn({ method: 'POST' })
  .middleware([authed])
  .validator(z.object({ id: z.string().min(1), enabled: z.boolean().optional(), events: z.array(z.enum(NOTIFY_EVENTS)).optional() }))
  .handler(async ({ context, data }) =>
    wrap(async () => {
      ownerOnly(context.session.org.role)
      await updateChannel(context.session.org.id, context.session.user.id, data.id, data)
    }),
  )

export const deleteChannelFn = createServerFn({ method: 'POST' })
  .middleware([authed])
  .validator(z.object({ id: z.string().min(1) }))
  .handler(async ({ context, data }) =>
    wrap(async () => {
      ownerOnly(context.session.org.role)
      await deleteChannel(context.session.org.id, context.session.user.id, data.id)
    }),
  )

export const testChannelFn = createServerFn({ method: 'POST' })
  .middleware([authed])
  .validator(z.object({ id: z.string().min(1) }))
  .handler(async ({ context, data }) =>
    wrap(async () => {
      ownerOnly(context.session.org.role)
      return testChannel(context.session.org.id, data.id)
    }),
  )

// ---------- Response connector (#88) ----------
export const fetchResponseConnector = createServerFn({ method: 'GET' })
  .middleware([authed])
  .handler(async ({ context }) => ({ connector: await getResponseConnectorView(context.session.org.id), canEdit: context.session.org.role === 'owner' }))

export const saveResponseConnector = createServerFn({ method: 'POST' })
  .middleware([authed])
  .validator(
    z.object({
      tenantId: z.uuid(),
      clientId: z.uuid(),
      clientSecret: z.string().min(1).max(500).optional(),
      clientSecretRef: z.string().regex(/^env:[A-Z0-9_]+$/).optional(),
      playbookAllowlist: z.array(z.string().max(400)).max(50).optional(),
    }),
  )
  .handler(async ({ context, data }) =>
    wrap(async () => {
      ownerOnly(context.session.org.role)
      await upsertResponseConnector(context.session.org.id, context.session.user.id, data)
    }),
  )
