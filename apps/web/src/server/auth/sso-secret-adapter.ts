import type { DBAdapter, DBAdapterInstance, DBTransactionAdapter, Where } from 'better-auth'
import { encryptSsoConfig, readSsoConfig, SSO_CONFIG_FIELDS } from './sso-secrets'

const MODEL = 'ssoProvider'
const hasConfig = (data: Record<string, unknown>) => SSO_CONFIG_FIELDS.some((field) => data[field] !== undefined)

function encryptFields(data: Record<string, unknown>, id: string) {
  const out = { ...data }
  for (const field of SSO_CONFIG_FIELDS) {
    const value = out[field]
    if (value === undefined || value === null) continue
    if (typeof value !== 'string') throw new Error('SSO configuration must be JSON text.')
    out[field] = encryptSsoConfig(value, id, field)
  }
  return out
}

function decryptRow<T>(row: T, select?: string[]): T {
  if (!row || typeof row !== 'object') return row
  const out = { ...row } as Record<string, unknown>
  for (const field of SSO_CONFIG_FIELDS) {
    if (typeof out[field] !== 'string') continue
    if (typeof out.id !== 'string') throw new Error('SSO provider row id is missing.')
    out[field] = readSsoConfig(out[field], out.id, field).plaintext
  }
  if (select && !select.includes('id')) delete out.id
  return out as T
}

const withId = (select?: string[]) => select ? [...new Set([...select, 'id'])] : undefined

function checkWhere(where?: Where[]) {
  // Randomised ciphertext cannot support plaintext predicates. Reject rather than leak a secret
  // into a query or silently change its meaning. The SSO plugin selects by id/domain/providerId.
  if (where?.some((w) => SSO_CONFIG_FIELDS.some((field) => w.field === field))) throw new Error('SSO configuration predicates are not supported.')
}

function checkUpdate(data: Record<string, unknown>, bulk = false) {
  if ('id' in data) throw new Error('SSO provider row ids cannot be changed.')
  if (bulk && hasConfig(data)) throw new Error('SSO configurations must be updated one provider at a time.')
}

/** Wrap transaction adapters too: the SSO plugin reads and updates configs through getCurrentAdapter. */
function wrap(adapter: DBTransactionAdapter): DBTransactionAdapter {
  return {
    ...adapter,
    async create<T extends Record<string, unknown>, R = T>(args: Parameters<DBAdapter['create']>[0]): Promise<R> {
      if (args.model !== MODEL) return adapter.create(args)
      const id = args.forceAllowId && typeof args.data.id === 'string' ? args.data.id : crypto.randomUUID()
      return decryptRow(await adapter.create<Record<string, unknown>, R>({ ...args, data: { ...encryptFields(args.data, id), id }, forceAllowId: true, select: withId(args.select) }), args.select)
    },
    async findOne<T>(args: Parameters<DBAdapter['findOne']>[0]): Promise<T | null> {
      if (args.model !== MODEL) return adapter.findOne(args)
      checkWhere(args.where)
      return decryptRow(await adapter.findOne<T>({ ...args, select: withId(args.select) }), args.select)
    },
    async findMany<T>(args: Parameters<DBAdapter['findMany']>[0]): Promise<T[]> {
      if (args.model !== MODEL) return adapter.findMany(args)
      checkWhere(args.where)
      return (await adapter.findMany<T>({ ...args, select: withId(args.select) })).map((row) => decryptRow(row, args.select))
    },
    async update<T>(args: Parameters<DBAdapter['update']>[0]): Promise<T | null> {
      if (args.model !== MODEL) return adapter.update(args)
      checkWhere(args.where)
      checkUpdate(args.update)
      if (args.where.length === 0) return null
      if (!hasConfig(args.update)) return decryptRow(await adapter.update<T>(args))
      const row = await adapter.findOne<{ id: string }>({ model: MODEL, where: args.where, select: ['id'] })
      if (!row) return null
      return decryptRow(await adapter.update<T>({ ...args, where: [...args.where, { field: 'id', value: row.id }], update: encryptFields(args.update, row.id) }))
    },
    async updateMany(args) {
      if (args.model === MODEL) {
        checkWhere(args.where)
        checkUpdate(args.update, true)
      }
      return adapter.updateMany(args)
    },
    async incrementOne<T>(args: Parameters<DBAdapter['incrementOne']>[0]): Promise<T | null> {
      if (args.model !== MODEL) return adapter.incrementOne(args)
      checkWhere(args.where)
      checkUpdate({ ...args.increment, ...args.set }, true)
      return decryptRow(await adapter.incrementOne<T>(args))
    },
    async consumeOne<T>(args: Parameters<DBAdapter['consumeOne']>[0]): Promise<T | null> {
      if (args.model !== MODEL) return adapter.consumeOne(args)
      checkWhere(args.where)
      return decryptRow(await adapter.consumeOne<T>(args))
    },
    async count(args) {
      if (args.model === MODEL) checkWhere(args.where)
      return adapter.count(args)
    },
    async delete(args) {
      if (args.model === MODEL) checkWhere(args.where)
      return adapter.delete(args)
    },
    async deleteMany(args) {
      if (args.model === MODEL) checkWhere(args.where)
      return adapter.deleteMany(args)
    },
  }
}

/** Encrypt whole SSO config JSON at the storage boundary, without modifying the SSO package. */
export function ssoSecretAdapter(factory: DBAdapterInstance): DBAdapterInstance {
  return (options) => {
    const adapter = factory(options)
    return { ...wrap(adapter), transaction: (callback) => adapter.transaction((tx) => callback(wrap(tx))) }
  }
}
