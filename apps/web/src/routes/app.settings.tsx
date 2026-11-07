import { createFileRoute, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { fetchConnector, saveConnector } from '../fns/hunts'
import { fetchAuthAudit, fetchMembers, setRoleFn } from '../fns/settings'
import { addChannelFn, deleteChannelFn, fetchChannels, fetchResponseConnector, saveResponseConnector, testChannelFn, updateChannelFn } from '../fns/notify'
import { fmtTime } from '../components/format'

export const Route = createFileRoute('/app/settings')({
  loader: async () => {
    const [members, connector, audit, response, channels] = await Promise.all([fetchMembers(), fetchConnector(), fetchAuthAudit(), fetchResponseConnector(), fetchChannels()])
    return { members, connector, audit, response, channels }
  },
  component: Settings,
})

function Settings() {
  const { members, connector, audit, response, channels } = Route.useLoaderData()
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

      <h2>Response connector</h2>
      <ResponseConnectorForm data={response} onError={setError} />

      <h2>Notifications</h2>
      <Channels data={channels} onError={setError} />

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

function ResponseConnectorForm({ data, onError }: { data: Awaited<ReturnType<typeof fetchResponseConnector>>; onError: (e: string | null) => void }) {
  const router = useRouter()
  const c = data.connector
  if (!data.canEdit) return <p className="cw-muted">{c ? `Configured for tenant ${c.tenantId} (${c.playbookAllowlist.length} allowlisted playbooks).` : 'Not configured: live Sentinel and Defender executors are refused.'} Owners can change this.</p>
  return (
    <form
      className="cw-form"
      onSubmit={async (e) => {
        e.preventDefault()
        const f = new FormData(e.currentTarget)
        const get = (k: string) => String(f.get(k) ?? '').trim() || undefined
        const r = await saveResponseConnector({
          data: {
            tenantId: get('tenantId')!,
            clientId: get('clientId')!,
            clientSecret: get('clientSecret'),
            clientSecretRef: get('clientSecretRef'),
            playbookAllowlist: String(f.get('playbooks') ?? '')
              .split(/\r?\n/)
              .map((x) => x.trim())
              .filter(Boolean),
          },
        })
        onError(r.ok ? null : r.error)
        await router.invalidate()
      }}
    >
      <p className="cw-muted">
        A separate Entra app with only response permissions (Defender Machine.Isolate; Sentinel Responder and playbook run). The read-only hunting app is never used for response. {c ? `Configured (secret: ${c.secretSource}). Leave the secret blank to keep it.` : 'Not configured.'} See docs/runbooks/entra-setup.md.
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
        {'or secret reference: env:CROSSWIRE_RESP_<ORGID>_<NAME>'}
        <input name="clientSecretRef" placeholder="env:CROSSWIRE_RESP_<ORGID>_SECRET" />
      </label>
      <label>
        Playbook allowlist (one Logic App resource id per line; Sentinel playbook proposals may only run these)
        <textarea name="playbooks" className="mono" rows={3} defaultValue={c?.playbookAllowlist.join('\n') ?? ''} />
      </label>
      <div>
        <button className="cw-btn" type="submit">
          Save response connector
        </button>
      </div>
    </form>
  )
}

const EVENT_LABELS = { watch_hit: 'New watch hits', approval_pending: 'Response awaiting approval', execution: 'Response executed / failed', scheduled_hunt: 'Scheduled hunt results' } as const
type EventKey = keyof typeof EVENT_LABELS

function Channels({ data, onError }: { data: Awaited<ReturnType<typeof fetchChannels>>; onError: (e: string | null) => void }) {
  const router = useRouter()
  const [kind, setKind] = useState<'teams' | 'slack'>('teams')
  if (!data.canEdit) return <p className="cw-muted">Owners manage Teams and Slack notifications.</p>
  const act = async (p: Promise<{ ok: boolean; error?: string }>) => {
    const r = await p
    onError(r.ok ? null : (r.error ?? 'Failed'))
    await router.invalidate()
  }
  return (
    <>
      <p className="cw-muted">Messages carry titles, counts and links back to Crosswire only: no query results or secrets. Webhook URLs are stored encrypted and never shown again.</p>
      {data.channels.length > 0 && (
        <table className="cw-table">
          <thead>
            <tr>
              <th>Channel</th>
              <th>Events</th>
              <th>Last delivery</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.channels.map((c) => (
              <tr key={c.id}>
                <td>
                  {c.name} <span className="cw-muted">{c.kind} · {c.urlHost}</span>
                </td>
                <td>{c.events.map((e) => EVENT_LABELS[e]).join(', ')}</td>
                <td>{c.lastStatus ? `${c.lastStatus} · ${fmtTime(c.lastSentAt!)}` : 'never'}</td>
                <td>
                  <div className="cw-row">
                    <button className="cw-btn" data-variant="ghost" onClick={() => act(testChannelFn({ data: { id: c.id } }).then((r) => (r.ok && !r.result.ok ? { ok: false, error: `Test failed: ${r.result.status}` } : r)))}>
                      Send test
                    </button>
                    <button className="cw-btn" data-variant="ghost" onClick={() => act(updateChannelFn({ data: { id: c.id, enabled: !c.enabled } }))}>
                      {c.enabled ? 'Disable' : 'Enable'}
                    </button>
                    <button className="cw-btn" data-variant="danger" onClick={() => act(deleteChannelFn({ data: { id: c.id } }))}>
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <form
        className="cw-form"
        onSubmit={async (e) => {
          e.preventDefault()
          const form = e.currentTarget
          const f = new FormData(form)
          const events = (Object.keys(EVENT_LABELS) as EventKey[]).filter((k) => f.get(`ev-${k}`) === 'on')
          const r = await addChannelFn({ data: { kind, name: String(f.get('name') ?? ''), url: String(f.get('url') ?? ''), events } })
          onError(r.ok ? null : r.error)
          // Keep what the owner typed when saving fails, so they can fix the URL and retry.
          if (r.ok) form.reset()
          await router.invalidate()
        }}
      >
        <div className="cw-row">
          <label>
            Kind
            <select aria-label="Channel kind" value={kind} onChange={(e) => setKind(e.target.value as 'teams' | 'slack')}>
              <option value="teams">Microsoft Teams (Workflows webhook)</option>
              <option value="slack">Slack (incoming webhook)</option>
            </select>
          </label>
          <label style={{ flex: 1 }}>
            Name
            <input name="name" placeholder="SOC channel" />
          </label>
        </div>
        <label>
          Webhook URL
          <input name="url" type="password" autoComplete="off" required placeholder={kind === 'slack' ? 'https://hooks.slack.com/services/…' : 'https://….logic.azure.com/workflows/…'} />
        </label>
        <fieldset className="cw-fieldset">
          <legend>Events</legend>
          {(Object.keys(EVENT_LABELS) as EventKey[]).map((k) => (
            <label key={k} className="cw-check">
              <input type="checkbox" name={`ev-${k}`} defaultChecked={k !== 'watch_hit'} /> {EVENT_LABELS[k]}
            </label>
          ))}
        </fieldset>
        <div>
          <button className="cw-btn" type="submit">
            Add channel
          </button>
        </div>
      </form>
    </>
  )
}
