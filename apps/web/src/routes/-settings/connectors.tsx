import { useState, type FormEvent } from 'react'
import { fetchConnector, saveConnector } from '../../fns/hunts'
import { fetchResponseConnector, saveResponseConnector } from '../../fns/notify'
import { fetchSetupState } from '../../fns/setup'
import { fmtAgo, fmtTime, plural } from '../../components/format'
import { Field, useSave } from './shared'

type Health = Awaited<ReturnType<typeof fetchSetupState>>['connector']

const SECRET_SOURCE: Record<string, string> = { encrypted: 'stored encrypted', env: 'from a secret reference', none: 'no secret stored' }

/** "Saved, not tested", "Working" or "Failing since TIME", from what the hunting code records. */
export function ConnectorHealthLine({ health, now }: { health: Health; now: number }) {
  switch (health.state) {
    case 'none':
      return null
    case 'untested':
      return (
        <p className="cw-m0">
          <span className="cw-badge" data-tone="warn">
            Saved, not tested
          </span>{' '}
          No live search has run since it was saved on {fmtTime(health.savedAt)}. Approve a search in a hunt to check it.
        </p>
      )
    case 'working':
      return (
        <p className="cw-m0">
          <span className="cw-badge" data-tone="ok">
            Working
          </span>{' '}
          The last live search succeeded {fmtAgo(health.lastOkAt, now)} ({fmtTime(health.lastOkAt)}).
        </p>
      )
    case 'failing':
      return (
        <p className="cw-m0">
          <span className="cw-badge" data-tone="danger">
            Failing since {fmtTime(health.since)}
          </span>{' '}
          Searches are refused by Microsoft. Check the client secret, its expiry and admin consent.
          {health.lastOkAt ? ` The last success was ${fmtTime(health.lastOkAt)}.` : ''}
        </p>
      )
  }
}

export function ConnectorForm({ data, health, now }: { data: Awaited<ReturnType<typeof fetchConnector>>; health: Health; now: number }) {
  const c = data.connector
  const { busy, save, feedback } = useSave()
  const [clearSecret, setClearSecret] = useState(false)
  const status = c ? `Connected to tenant ${c.tenantId}, secret ${SECRET_SOURCE[c.secretSource ?? 'none'] ?? c.secretSource}.` : data.demoMode ? 'Not connected. Hunts return labelled demo data.' : 'Not connected.'
  if (!data.canEdit)
    return (
      <>
        <p>
          {status} <span className="cw-muted">Owners can change this.</span>
        </p>
        <ConnectorHealthLine health={health} now={now} />
      </>
    )
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const form = e.currentTarget
    const f = new FormData(form)
    const get = (k: string) => String(f.get(k) ?? '').trim() || undefined
    const input = {
      tenantId: get('tenantId')!,
      clientId: get('clientId')!,
      clientSecret: get('clientSecret'),
      clientSecretRef: get('clientSecretRef'),
      sentinelSubscriptionId: get('sentinelSubscriptionId'),
      sentinelResourceGroup: get('sentinelResourceGroup'),
      sentinelWorkspaceName: get('sentinelWorkspaceName'),
      sentinelWorkspaceId: get('sentinelWorkspaceId'),
      // Sent only when ticked. The server keeps the stored secret for a blank field (#122).
      ...(clearSecret ? { clearSecret: true } : {}),
    }
    void save('hunting', () => saveConnector({ data: input }), 'Connection saved. Secret fields are cleared from the page.', form).then((ok) => {
      if (ok) setClearSecret(false)
    })
  }
  return (
    <form className="cw-form" data-wide onSubmit={submit}>
      <p className="cw-muted cw-m0">
        {status} Use a separate read-only app registration (see docs/hunting.md).
      </p>
      <ConnectorHealthLine health={health} now={now} />
      <fieldset className="cw-fieldgroup">
        <legend>Entra app</legend>
        <div className="cw-formgrid">
          <Field label="Tenant ID" hint="Directory (tenant) GUID.">{(p) => <input {...p} name="tenantId" defaultValue={c?.tenantId} required autoComplete="off" className="mono" />}</Field>
          <Field label="Client ID" hint="Application (client) GUID.">{(p) => <input {...p} name="clientId" defaultValue={c?.clientId} required autoComplete="off" className="mono" />}</Field>
          <Field label="Client secret" hint="Stored encrypted and never shown again. Leave blank to keep the stored secret.">{(p) => <input {...p} name="clientSecret" type="password" autoComplete="new-password" />}</Field>
          <Field label="Or secret reference" hint="env:CROSSWIRE_HUNT_<ORGID>_<NAME>, a Key Vault-backed container secret.">{(p) => <input {...p} name="clientSecretRef" placeholder="env:CROSSWIRE_HUNT_<ORGID>_SECRET" autoComplete="off" className="mono" />}</Field>
        </div>
        {c && c.secretSource !== 'none' && (
          <label className="cw-check">
            <input type="checkbox" checked={clearSecret} onChange={(e) => setClearSecret(e.target.checked)} /> Remove the stored secret
          </label>
        )}
      </fieldset>
      <fieldset className="cw-fieldgroup">
        <legend>Sentinel workspace (optional)</legend>
        <div className="cw-formgrid">
          <Field label="Subscription ID">{(p) => <input {...p} name="sentinelSubscriptionId" defaultValue={c?.sentinelSubscriptionId ?? ''} autoComplete="off" className="mono" />}</Field>
          <Field label="Resource group">{(p) => <input {...p} name="sentinelResourceGroup" defaultValue={c?.sentinelResourceGroup ?? ''} autoComplete="off" />}</Field>
          <Field label="Workspace name">{(p) => <input {...p} name="sentinelWorkspaceName" defaultValue={c?.sentinelWorkspaceName ?? ''} autoComplete="off" />}</Field>
          <Field label="Log Analytics workspace ID" hint="The workspace GUID.">{(p) => <input {...p} name="sentinelWorkspaceId" defaultValue={c?.sentinelWorkspaceId ?? ''} autoComplete="off" className="mono" />}</Field>
        </div>
      </fieldset>
      {feedback}
      <div>
        <button className="cw-btn" type="submit" disabled={Boolean(busy)} aria-busy={busy ? true : undefined}>
          {busy ? 'Saving…' : 'Save connection'}
        </button>
      </div>
    </form>
  )
}

export function ResponseConnectorForm({ data }: { data: Awaited<ReturnType<typeof fetchResponseConnector>> }) {
  const c = data.connector
  const { busy, save, feedback } = useSave()
  const status = c ? `Connected to tenant ${c.tenantId}, ${plural(c.playbookAllowlist.length, 'allowlisted playbook')}, secret ${SECRET_SOURCE[c.secretSource ?? 'none'] ?? c.secretSource}.` : 'Not connected. Live Sentinel and Defender executors are refused.'
  if (!data.canEdit)
    return (
      <p>
        {status} <span className="cw-muted">Owners can change this.</span>
      </p>
    )
  return (
    <form
      className="cw-form"
      data-wide
      onSubmit={(e) => {
        e.preventDefault()
        const form = e.currentTarget
        const f = new FormData(form)
        const get = (k: string) => String(f.get(k) ?? '').trim() || undefined
        void save(
          'response',
          () =>
            saveResponseConnector({
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
            }),
          'Response connection saved. Secret fields are cleared from the page.',
          form,
        )
      }}
    >
      <p className="cw-muted cw-m0">
        {status} Use a separate Entra app with response permissions only (see docs/runbooks/entra-setup.md). The read-only hunting app is never used for response.
      </p>
      <div className="cw-formgrid">
        <Field label="Tenant ID">{(p) => <input {...p} name="tenantId" defaultValue={c?.tenantId} required autoComplete="off" className="mono" />}</Field>
        <Field label="Client ID">{(p) => <input {...p} name="clientId" defaultValue={c?.clientId} required autoComplete="off" className="mono" />}</Field>
        <Field label="Client secret" hint="Stored encrypted. Leave blank to keep the stored secret.">{(p) => <input {...p} name="clientSecret" type="password" autoComplete="new-password" />}</Field>
        <Field label="Or secret reference" hint="env:CROSSWIRE_RESP_<ORGID>_<NAME>">{(p) => <input {...p} name="clientSecretRef" placeholder="env:CROSSWIRE_RESP_<ORGID>_SECRET" autoComplete="off" className="mono" />}</Field>
      </div>
      <Field label="Playbook allowlist" hint="One Logic App resource ID per line. Sentinel playbook actions may only run these.">
        {(p) => <textarea {...p} name="playbooks" className="mono" rows={3} defaultValue={c?.playbookAllowlist.join('\n') ?? ''} />}
      </Field>
      {feedback}
      <div>
        <button className="cw-btn" type="submit" disabled={Boolean(busy)} aria-busy={busy ? true : undefined}>
          {busy ? 'Saving…' : 'Save response connection'}
        </button>
      </div>
    </form>
  )
}
