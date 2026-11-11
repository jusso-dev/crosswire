import { createFileRoute, useRouter } from '@tanstack/react-router'
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { fetchConnector, saveConnector } from '../fns/hunts'
import { clearDigestEmailFn, fetchAuthAudit, fetchDigestEmail, fetchMembers, requestDigestEmailFn, setRoleFn } from '../fns/settings'
import { addChannelFn, deleteChannelFn, fetchChannels, fetchResponseConnector, saveResponseConnector, testChannelFn, updateChannelFn } from '../fns/notify'
import { fmtTime } from '../components/format'
import { Notice, PageHead, TableWrap, SkeletonPage } from '../components/ui'
import { plainMessage } from '../shared/messages'
import { Freshness } from '../components/signals'
import { pageTitle } from '../components/errors'

/**
 * Settings: one page, sectioned, with in-page navigation. Every save is enforced server-side
 * (owners only); non-owners see read-only summaries that say who can change them.
 */
export const Route = createFileRoute('/app/settings')({
  loader: async () => {
    const [members, connector, audit, response, channels, digestEmail] = await Promise.all([fetchMembers(), fetchConnector(), fetchAuthAudit(), fetchResponseConnector(), fetchChannels(), fetchDigestEmail()])
    return { members, connector, audit, response, channels, digestEmail }
  },
  pendingComponent: () => <SkeletonPage label="Loading settings" />,
  errorComponent: ({ error }) => (
    <Notice tone="error" title="Settings did not load">
      {plainMessage(error)} Refresh the page to try again.
    </Notice>
  ),
  head: () => ({ meta: [{ title: pageTitle('Settings') }] }),
  component: Settings,
})

const SECTIONS = [
  ['people', 'People and roles'],
  ['hunting', 'Defender and Sentinel'],
  ['response', 'Response connection'],
  ['alerts', 'Teams and Slack alerts'],
  ['digest-email', 'Digest email'],
  ['audit', 'Audit log'],
] as const

function Settings() {
  const { members, connector, audit, response, channels, digestEmail } = Route.useLoaderData()
  // Only owners receive digest email, so only they see that section.
  const sections = SECTIONS.filter(([id]) => id !== 'digest-email' || digestEmail.allowed)
  return (
    <>
      <PageHead title="Settings" intro="Who can do what, how Crosswire connects to Microsoft, and where alerts go. Owners change these; everyone can read them." />
      <div className="cw-settings">
        <nav aria-label="Settings sections" className="cw-toc">
          <ul>
            {sections.map(([id, label]) => (
              <li key={id}>
                <a href={`#${id}`}>{label}</a>
              </li>
            ))}
          </ul>
        </nav>
        <div>
          <Section id="people" title="People and roles" intro="Analysts investigate and ask for actions. Approvers decide on actions. Owners also manage people and settings. New people join as analysts.">
            <Members data={members} />
          </Section>
          <Section id="hunting" title="Defender and Sentinel" intro="A read-only connection so approved searches run on your real data. Until it is set, hunts return labelled demo data.">
            <ConnectorForm data={connector} />
          </Section>
          <Section id="response" title="Response connection (optional)" intro="Only needed if your organisation lets approved actions run for real. Safe mode stays on until an admin changes it.">
            <ResponseConnectorForm data={response} />
          </Section>
          <Section id="alerts" title="Teams and Slack alerts" intro="Post a short message when something needs a decision or a repeat search finds results.">
            <Channels data={channels} />
          </Section>
          {digestEmail.allowed && (
            <Section id="digest-email" title="Digest email" intro="Where your daily watch digest is emailed. Use a confirmed contact address if your sign-in email has no mailbox.">
              <DigestEmail data={digestEmail} />
            </Section>
          )}
          <Section id="audit" title="Audit log" intro="Sign-ins, role changes and response decisions, newest first.">
            {!audit.allowed ? (
              <p className="cw-muted">Only owners can view the audit log.</p>
            ) : audit.events.length === 0 ? (
              <p className="cw-empty">No events yet.</p>
            ) : (
              <TableWrap label="Audit log">
                <table className="cw-table">
                  <thead>
                    <tr>
                      <th scope="col">When</th>
                      <th scope="col">Category</th>
                      <th scope="col">Action</th>
                      <th scope="col">Result</th>
                      <th scope="col">Actor</th>
                      <th scope="col">IP address</th>
                    </tr>
                  </thead>
                  <tbody>
                    {audit.events.map((e) => (
                      <tr key={e.id}>
                        <td className="num">{fmtTime(e.createdAt)}</td>
                        <td>{e.category}</td>
                        <td className="mono">{e.action}</td>
                        <td>
                          <span className="cw-badge" data-tone={e.result === 'success' ? 'ok' : e.result === 'failure' ? 'danger' : undefined}>
                            {e.result}
                          </span>
                        </td>
                        <td>
                          {e.actorType} <span className="mono">{e.actorId ?? ''}</span>
                        </td>
                        <td className="mono">{e.ipAddress ?? <span className="cw-muted">not recorded</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            )}
          </Section>
        </div>
      </div>
    </>
  )
}

function Section({ id, title, intro, children }: { id: string; title: string; intro: string; children: ReactNode }) {
  return (
    <section id={id} className="cw-panel2 cw-anchor" aria-labelledby={`${id}-title`}>
      <div className="cw-panel2-head cw-stack-tight">
        <h2 id={`${id}-title`}>{title}</h2>
        <p className="cw-muted cw-m0">
          {intro}
        </p>
      </div>
      <div className="cw-panel2-body">{children}</div>
    </section>
  )
}

/** Submit state for a settings form: busy, error (announced) and a polite success message. */
function useSave() {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const run = async (fn: () => Promise<{ ok: boolean; error?: string } | void>, okMsg: string) => {
    setBusy(true)
    setError(null)
    setDone(null)
    try {
      const r = await fn()
      if (r && !r.ok) setError(r.error ?? 'Could not save.')
      else setDone(okMsg)
      await router.invalidate()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  const feedback = (
    <>
      {error && (
        <Notice tone="error" title="Not saved">
          {error}
        </Notice>
      )}
      <p className="cw-help" role="status">
        {done ?? ''}
      </p>
    </>
  )
  return { busy, run, feedback }
}

function Field({ label, hint, children }: { label: string; hint?: string; children: (props: { id: string; 'aria-describedby'?: string }) => ReactNode }) {
  const id = useId()
  const hintId = useId()
  return (
    <div className="cw-field">
      <label htmlFor={id}>{label}</label>
      {hint && (
        <p id={hintId} className="cw-help cw-m0">
          {hint}
        </p>
      )}
      {children({ id, 'aria-describedby': hint ? hintId : undefined })}
    </div>
  )
}

function Members({ data }: { data: Awaited<ReturnType<typeof fetchMembers>> }) {
  const { run, feedback } = useSave()
  return (
    <>
      {feedback}
      <TableWrap label="Members">
        <table className="cw-table">
          <thead>
            <tr>
              <th scope="col">Person</th>
              <th scope="col">Role</th>
            </tr>
          </thead>
          <tbody>
            {data.members.map((m) => (
              <tr key={m.userId}>
                <td>
                  {m.name}
                  <div className="cw-muted">{m.email}</div>
                </td>
                <td>
                  {data.canManage && m.userId !== data.me ? (
                    <select aria-label={`Role for ${m.email}`} value={m.role} onChange={(e) => run(() => setRoleFn({ data: { userId: m.userId, role: e.target.value as 'owner' | 'approver' | 'analyst' } }), `Role for ${m.email} changed to ${e.target.value}.`)}>
                      <option value="analyst">Analyst</option>
                      <option value="approver">Approver</option>
                      <option value="owner">Owner</option>
                    </select>
                  ) : (
                    <span className="cw-badge" data-tone={m.role === 'analyst' ? undefined : 'info'}>
                      {m.role}
                    </span>
                  )}
                  {m.userId === data.me && <span className="cw-muted"> (you)</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableWrap>
      {!data.canManage && <p className="cw-muted">Only owners change roles.</p>}
    </>
  )
}

function ConnectorForm({ data }: { data: Awaited<ReturnType<typeof fetchConnector>> }) {
  const c = data.connector
  const { busy, run, feedback } = useSave()
  const status = c ? `Connected to tenant ${c.tenantId} (secret: ${c.secretSource}).` : data.demoMode ? 'Not connected. Hunts return labelled demo data.' : 'Not connected.'
  if (!data.canEdit)
    return (
      <p>
        {status} <span className="cw-muted">Owners can change this.</span>
      </p>
    )
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    const get = (k: string) => String(f.get(k) ?? '').trim() || undefined
    void run(
      async () => {
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
      },
      'Connection saved.',
    )
  }
  return (
    <form className="cw-form" data-wide onSubmit={submit}>
      <p className="cw-muted cw-m0">
        {status} Use a separate read-only app registration (see docs/hunting.md). Saving replaces the stored connection.
      </p>
      <fieldset className="cw-fieldgroup">
        <legend>Entra app</legend>
        <div className="cw-formgrid">
          <Field label="Tenant ID" hint="Directory (tenant) GUID.">{(p) => <input {...p} name="tenantId" defaultValue={c?.tenantId} required autoComplete="off" className="mono" />}</Field>
          <Field label="Client ID" hint="Application (client) GUID.">{(p) => <input {...p} name="clientId" defaultValue={c?.clientId} required autoComplete="off" className="mono" />}</Field>
          <Field label="Client secret" hint="Stored encrypted and never shown again. Leave blank to use a secret reference.">{(p) => <input {...p} name="clientSecret" type="password" autoComplete="new-password" />}</Field>
          <Field label="Or secret reference" hint="env:CROSSWIRE_HUNT_<ORGID>_<NAME>, a Key Vault-backed container secret.">{(p) => <input {...p} name="clientSecretRef" placeholder="env:CROSSWIRE_HUNT_<ORGID>_SECRET" autoComplete="off" className="mono" />}</Field>
        </div>
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
        <button className="cw-btn" type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save connection'}
        </button>
      </div>
    </form>
  )
}

function ResponseConnectorForm({ data }: { data: Awaited<ReturnType<typeof fetchResponseConnector>> }) {
  const c = data.connector
  const { busy, run, feedback } = useSave()
  const status = c ? `Connected to tenant ${c.tenantId}, ${c.playbookAllowlist.length} allowlisted playbook${c.playbookAllowlist.length === 1 ? '' : 's'} (secret: ${c.secretSource}).` : 'Not connected. Live Sentinel and Defender executors are refused.'
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
        const f = new FormData(e.currentTarget)
        const get = (k: string) => String(f.get(k) ?? '').trim() || undefined
        void run(
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
          'Response connection saved.',
        )
      }}
    >
      <p className="cw-muted cw-m0">
        {status} Use a separate Entra app with response permissions only (see docs/runbooks/entra-setup.md). The read-only hunting app is never used for response.
      </p>
      <div className="cw-formgrid">
        <Field label="Tenant ID">{(p) => <input {...p} name="tenantId" defaultValue={c?.tenantId} required autoComplete="off" className="mono" />}</Field>
        <Field label="Client ID">{(p) => <input {...p} name="clientId" defaultValue={c?.clientId} required autoComplete="off" className="mono" />}</Field>
        <Field label="Client secret" hint="Stored encrypted. Leave blank to keep the current one.">{(p) => <input {...p} name="clientSecret" type="password" autoComplete="new-password" />}</Field>
        <Field label="Or secret reference" hint="env:CROSSWIRE_RESP_<ORGID>_<NAME>">{(p) => <input {...p} name="clientSecretRef" placeholder="env:CROSSWIRE_RESP_<ORGID>_SECRET" autoComplete="off" className="mono" />}</Field>
      </div>
      <Field label="Playbook allowlist" hint="One Logic App resource ID per line. Sentinel playbook actions may only run these.">
        {(p) => <textarea {...p} name="playbooks" className="mono" rows={3} defaultValue={c?.playbookAllowlist.join('\n') ?? ''} />}
      </Field>
      {feedback}
      <div>
        <button className="cw-btn" type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save response connection'}
        </button>
      </div>
    </form>
  )
}

const EVENT_LABELS = { watch_hit: 'New watch hits', approval_pending: 'Action waiting for approval', execution: 'Action executed or failed', scheduled_hunt: 'Repeat search results' } as const
type EventKey = keyof typeof EVENT_LABELS

function Channels({ data }: { data: Awaited<ReturnType<typeof fetchChannels>> }) {
  const [kind, setKind] = useState<'teams' | 'slack'>('teams')
  const { busy, run, feedback } = useSave()
  if (!data.canEdit) return <p className="cw-muted">Owners manage Teams and Slack alerts.</p>
  return (
    <>
      <p className="cw-muted">Messages carry titles, counts and links back to Crosswire only: no query results or secrets. Webhook URLs are stored encrypted and never shown again.</p>
      {feedback}
      {data.channels.length > 0 && (
        <TableWrap label="Alert channels">
          <table className="cw-table">
            <thead>
              <tr>
                <th scope="col">Channel</th>
                <th scope="col">Sends</th>
                <th scope="col">Last delivery</th>
                <th scope="col">
                  <span className="cw-sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.channels.map((c) => (
                <tr key={c.id}>
                  <td>
                    {c.name}
                    <div className="cw-muted">
                      {c.kind === 'teams' ? 'Teams' : 'Slack'} · <span className="mono">{c.urlHost}</span> · {c.enabled ? 'on' : 'off'}
                    </div>
                  </td>
                  <td>{c.events.map((e) => EVENT_LABELS[e]).join(', ')}</td>
                  <td>{c.lastStatus ? <>{c.lastStatus} · <Freshness at={c.lastSentAt} /></> : <span className="cw-muted">never</span>}</td>
                  <td>
                    <div className="cw-row cw-nowrap-flex">
                      <button type="button" className="cw-btn" data-variant="ghost" data-size="sm" disabled={busy} onClick={() => run(() => testChannelFn({ data: { id: c.id } }).then((r) => (r.ok && !r.result.ok ? { ok: false, error: `Test failed: ${r.result.status}` } : r)), `Test sent to ${c.name}.`)}>
                        Send test<span className="cw-sr-only"> to {c.name}</span>
                      </button>
                      <button type="button" className="cw-btn" data-variant="ghost" data-size="sm" disabled={busy} onClick={() => run(() => updateChannelFn({ data: { id: c.id, enabled: !c.enabled } }), `${c.name} turned ${c.enabled ? 'off' : 'on'}.`)}>
                        {c.enabled ? 'Turn off' : 'Turn on'}
                        <span className="cw-sr-only"> {c.name}</span>
                      </button>
                      <DeleteChannel name={c.name} busy={busy} onDelete={() => run(() => deleteChannelFn({ data: { id: c.id } }), `${c.name} deleted.`)} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
      <form
        className="cw-form"
        data-wide
        aria-labelledby="add-channel-title"
        onSubmit={(e) => {
          e.preventDefault()
          const form = e.currentTarget
          const f = new FormData(form)
          const events = (Object.keys(EVENT_LABELS) as EventKey[]).filter((k) => f.get(`ev-${k}`) === 'on')
          void run(async () => {
            const r = await addChannelFn({ data: { kind, name: String(f.get('name') ?? ''), url: String(f.get('url') ?? ''), events } })
            // Keep what the owner typed when saving fails, so they can fix the URL and retry.
            if (r.ok) form.reset()
            return r
          }, 'Channel added.')
        }}
      >
        <h3 id="add-channel-title" className="cw-m0 cw-mt-sm">
          Add a channel
        </h3>
        <div className="cw-formgrid">
          <Field label="Service">
            {(p) => (
              <select {...p} value={kind} onChange={(e) => setKind(e.target.value as 'teams' | 'slack')}>
                <option value="teams">Microsoft Teams (Workflows webhook)</option>
                <option value="slack">Slack (incoming webhook)</option>
              </select>
            )}
          </Field>
          <Field label="Name">{(p) => <input {...p} name="name" placeholder="SOC channel" autoComplete="off" />}</Field>
        </div>
        <Field label="Webhook URL" hint="Stored encrypted and never shown again.">
          {(p) => <input {...p} name="url" type="password" autoComplete="off" required placeholder={kind === 'slack' ? 'https://hooks.slack.com/services/…' : 'https://….logic.azure.com/workflows/…'} />}
        </Field>
        <fieldset className="cw-fieldgroup">
          <legend>Send a message for</legend>
          {(Object.keys(EVENT_LABELS) as EventKey[]).map((k) => (
            <label key={k} className="cw-check">
              <input type="checkbox" name={`ev-${k}`} defaultChecked={k !== 'watch_hit'} /> {EVENT_LABELS[k]}
            </label>
          ))}
        </fieldset>
        <div>
          <button className="cw-btn" type="submit" disabled={busy}>
            {busy ? 'Adding…' : 'Add channel'}
          </button>
        </div>
      </form>
    </>
  )
}

/** Two-step delete: Delete shows Confirm and Cancel; focus moves to Confirm, and back to Delete on Cancel. */
function DeleteChannel({ name, busy, onDelete }: { name: string; busy: boolean; onDelete: () => Promise<void> }) {
  const [confirm, setConfirm] = useState(false)
  const deleteRef = useRef<HTMLButtonElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const returnFocus = useRef(false)
  useEffect(() => {
    if (confirm) confirmRef.current?.focus()
    else if (returnFocus.current) {
      returnFocus.current = false
      deleteRef.current?.focus()
    }
  }, [confirm])
  const cancel = () => {
    returnFocus.current = true
    setConfirm(false)
  }
  if (!confirm)
    return (
      <button ref={deleteRef} type="button" className="cw-btn" data-variant="danger" data-size="sm" disabled={busy} onClick={() => setConfirm(true)}>
        Delete<span className="cw-sr-only"> {name}</span>
      </button>
    )
  return (
    <span
      className="cw-row cw-nowrap-flex"
      data-center
     
      onKeyDown={(e) => {
        if (e.key === 'Escape') cancel()
      }}
    >
      <button ref={confirmRef} type="button" className="cw-btn" data-variant="danger" data-size="sm" disabled={busy} onClick={() => void onDelete()}>
        Confirm delete<span className="cw-sr-only"> {name}</span>
      </button>
      <button type="button" className="cw-btn" data-variant="quiet" data-size="sm" disabled={busy} onClick={cancel}>
        Cancel<span className="cw-sr-only"> deleting {name}</span>
      </button>
    </span>
  )
}

type DigestEmailData = Extract<Awaited<ReturnType<typeof fetchDigestEmail>>, { allowed: true }>

/** Digest email address (#102): confirmed by a link sent to the new address. Owners only. */
function DigestEmail({ data }: { data: DigestEmailData }) {
  const router = useRouter()
  const errId = useId()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [removeError, setRemoveError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const current = data.digestEmail ?? data.signInEmail

  const send = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const form = e.currentTarget
    const email = String(new FormData(form).get('email') ?? '').trim()
    setBusy(true)
    setError(null)
    setRemoveError(null)
    setDone(null)
    try {
      const r = await requestDigestEmailFn({ data: { email } })
      if (!r.ok) setError(r.error)
      else {
        form.reset()
        setDone(`Confirmation link sent to ${r.result.pending}.`)
      }
      await router.invalidate()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    setBusy(true)
    setError(null)
    setRemoveError(null)
    setDone(null)
    try {
      const r = await clearDigestEmailFn()
      if (!r.ok) setRemoveError(r.error)
      else setDone(`Digests go to your sign-in email, ${data.signInEmail}, again.`)
      await router.invalidate()
    } catch (err) {
      setRemoveError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <p className="cw-mt0">
        Digests go to <strong>{current}</strong>
        {data.digestEmail ? ' (confirmed contact address).' : ' (your sign-in email).'}
      </p>
      {!data.digestEmail && data.signInMayBeUpn && (
        <Notice tone="warn" title="Your sign-in email may not receive mail">
          It came from your Microsoft sign-in name, which may have no mailbox. If digests do not arrive, add a contact address below.
        </Notice>
      )}
      {!data.smtp && (
        <Notice tone="info" title="Email is not set up">
          This Crosswire server has no SMTP settings, so digests are not emailed and a new address cannot be confirmed yet. Digests are still on the Daily digests page.
        </Notice>
      )}
      {data.pending && (
        <Notice tone="info" title="Waiting for confirmation">
          Check <strong>{data.pending.email}</strong> for a confirmation link; it expires in 24 hours ({fmtTime(data.pending.expiresAt)}). Open it while signed in to Crosswire as yourself.
        </Notice>
      )}
      <form className="cw-form" onSubmit={send} noValidate>
        <Field label={data.digestEmail || data.pending ? 'New digest email address' : 'Digest email address'} hint="We email a confirmation link to this address. Digests only go there after you open the link.">
          {(p) => (
            <input
              {...p}
              name="email"
              type="email"
              autoComplete="email"
              inputMode="email"
              maxLength={254}
              required
              aria-invalid={error ? true : undefined}
              aria-describedby={[p['aria-describedby'], error ? errId : undefined].filter(Boolean).join(' ') || undefined}
            />
          )}
        </Field>
        {error && (
          <p id={errId} className="cw-field-error" role="alert">
            {error}
          </p>
        )}
        <div className="cw-row">
          <button className="cw-btn" type="submit" disabled={busy}>
            {busy ? 'Sending…' : 'Send confirmation link'}
          </button>
          {(data.digestEmail || data.pending) && (
            <button type="button" className="cw-btn" data-variant="ghost" disabled={busy} onClick={() => void remove()}>
              Remove<span className="cw-sr-only"> digest address and use your sign-in email</span>
            </button>
          )}
        </div>
        {removeError && (
          <Notice tone="error" title="Not removed">
            {removeError}
          </Notice>
        )}
        <p className="cw-help cw-m0" role="status">
          {done ?? ''}
        </p>
      </form>
    </>
  )
}
