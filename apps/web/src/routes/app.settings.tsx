import { createFileRoute, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { fetchConnector, saveConnector } from '../fns/hunts'
import { fetchAuthAudit, fetchMembers, setRoleFn } from '../fns/settings'
import { fmtTime } from '../components/format'

export const Route = createFileRoute('/app/settings')({
  loader: async () => {
    const [members, connector, audit] = await Promise.all([fetchMembers(), fetchConnector(), fetchAuthAudit()])
    return { members, connector, audit }
  },
  component: Settings,
})

function Settings() {
  const { members, connector, audit } = Route.useLoaderData()
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  return (
    <>
      <h1>Settings</h1>
      {error && (
        <p className="cw-error" role="alert">
          {error}
        </p>
      )}
      <h2>Members and roles</h2>
      <p className="cw-muted">Owners and approvers can approve response proposals. New members join as analysts. Only owners change roles.</p>
      <table className="cw-table">
        <thead>
          <tr>
            <th>Member</th>
            <th>Role</th>
          </tr>
        </thead>
        <tbody>
          {members.members.map((m) => (
            <tr key={m.userId}>
              <td>
                {m.name} <span className="cw-muted">{m.email}</span>
              </td>
              <td>
                {members.canManage && m.userId !== members.me ? (
                  <select
                    aria-label={`Role for ${m.email}`}
                    value={m.role}
                    onChange={async (e) => {
                      try {
                        await setRoleFn({ data: { userId: m.userId, role: e.target.value as 'owner' | 'approver' | 'analyst' } })
                        await router.invalidate()
                      } catch (err) {
                        setError(err instanceof Error ? err.message : String(err))
                      }
                    }}
                  >
                    <option value="analyst">analyst</option>
                    <option value="approver">approver</option>
                    <option value="owner">owner</option>
                  </select>
                ) : (
                  m.role
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Hunting connector</h2>
      <ConnectorForm data={connector} onError={setError} />

      <h2>Audit log</h2>
      {!audit.allowed ? (
        <p className="cw-muted">Only owners can view the audit log.</p>
      ) : audit.events.length === 0 ? (
        <p className="cw-empty">No events.</p>
      ) : (
        <table className="cw-table">
          <thead>
            <tr>
              <th>When</th>
              <th>Category</th>
              <th>Action</th>
              <th>Result</th>
              <th>Actor</th>
              <th>IP</th>
            </tr>
          </thead>
          <tbody>
            {audit.events.map((e) => (
              <tr key={e.id}>
                <td>{fmtTime(e.createdAt)}</td>
                <td>{e.category}</td>
                <td>{e.action}</td>
                <td>{e.result}</td>
                <td>
                  {e.actorType} {e.actorId ?? ''}
                </td>
                <td>{e.ipAddress ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  )
}

function ConnectorForm({ data, onError }: { data: Awaited<ReturnType<typeof fetchConnector>>; onError: (e: string | null) => void }) {
  const router = useRouter()
  const c = data.connector
  if (!data.canEdit) {
    return <p className="cw-muted">{c ? `Configured for tenant ${c.tenantId}.` : data.demoMode ? 'Not configured: hunting runs in demo mode.' : 'Not configured.'} Owners can change this.</p>
  }
  return (
    <form
      className="cw-form"
      onSubmit={async (e) => {
        e.preventDefault()
        const f = new FormData(e.currentTarget)
        const get = (k: string) => {
          const v = String(f.get(k) ?? '').trim()
          return v || undefined
        }
        try {
          await saveConnector({
            data: {
              tenantId: get('tenantId')!,
              clientId: get('clientId')!,
              clientSecret: get('clientSecret'),
              clientSecretRef: get('clientSecretRef'),
              sentinelSubscriptionId: get('sentinelSubscriptionId'),
              sentinelResourceGroup: get('sentinelResourceGroup'),
              sentinelWorkspaceName: get('sentinelWorkspaceName'),
              sentinelWorkspaceId: get('sentinelWorkspaceId'),
            },
          })
          onError(null)
          await router.invalidate()
        } catch (err) {
          onError(err instanceof Error ? err.message : String(err))
        }
      }}
    >
      <p className="cw-muted">
        {c ? `Configured (secret: ${c.secretSource}). Saving replaces it.` : data.demoMode ? 'Not configured: hunting runs in demo mode with fixture data.' : 'Not configured.'} See docs/hunting.md for the least-privilege app registration.
      </p>
      <label>
        Tenant ID
        <input name="tenantId" defaultValue={c?.tenantId} required />
      </label>
      <label>
        Client ID
        <input name="clientId" defaultValue={c?.clientId} required />
      </label>
      <label>
        Client secret (stored encrypted; never shown again)
        <input name="clientSecret" type="password" autoComplete="off" />
      </label>
      <label>
        {'or secret reference: env:CROSSWIRE_HUNT_<ORGID>_<NAME> (a Key Vault-backed container secret; see docs/hunting.md)'}
        <input name="clientSecretRef" placeholder="env:CROSSWIRE_HUNT_<ORGID>_SECRET" />
      </label>
      <label>
        Sentinel subscription ID
        <input name="sentinelSubscriptionId" defaultValue={c?.sentinelSubscriptionId ?? ''} />
      </label>
      <label>
        Sentinel resource group
        <input name="sentinelResourceGroup" defaultValue={c?.sentinelResourceGroup ?? ''} />
      </label>
      <label>
        Sentinel workspace name
        <input name="sentinelWorkspaceName" defaultValue={c?.sentinelWorkspaceName ?? ''} />
      </label>
      <label>
        Log Analytics workspace ID (GUID)
        <input name="sentinelWorkspaceId" defaultValue={c?.sentinelWorkspaceId ?? ''} />
      </label>
      <div>
        <button className="cw-btn" type="submit">
          Save connector
        </button>
      </div>
    </form>
  )
}
