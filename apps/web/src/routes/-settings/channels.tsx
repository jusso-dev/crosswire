import { useState } from 'react'
import { addChannelFn, deleteChannelFn, fetchChannels, testChannelFn, updateChannelFn } from '../../fns/notify'
import { ConfirmDialog } from '../../components/confirm'
import { TableWrap } from '../../components/ui'
import { Freshness } from '../../components/signals'
import { Field, useSave } from './shared'

const EVENT_LABELS = { watch_hit: 'New watch hits', approval_pending: 'Action waiting for approval', execution: 'Action executed or failed', scheduled_hunt: 'Repeat search results' } as const
type EventKey = keyof typeof EVENT_LABELS
type Channel = Awaited<ReturnType<typeof fetchChannels>>['channels'][number]

export function Channels({ data }: { data: Awaited<ReturnType<typeof fetchChannels>> }) {
  const [kind, setKind] = useState<'teams' | 'slack'>('teams')
  const [deleting, setDeleting] = useState<Channel | null>(null)
  const { busy, save, feedback, error, setError } = useSave()
  if (!data.canEdit) return <p className="cw-muted">Owners manage Teams and Slack alerts.</p>
  return (
    <>
      <p className="cw-muted">Messages carry titles, counts and links back to Crosswire only: no query results or secrets. Webhook URLs are stored encrypted and never shown again.</p>
      {!deleting && feedback}
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
                  <td>
                    {c.lastStatus ? (
                      <>
                        {c.lastStatus} · <Freshness at={c.lastSentAt} />
                      </>
                    ) : (
                      <span className="cw-muted">never</span>
                    )}
                  </td>
                  <td>
                    <div className="cw-row cw-nowrap-flex">
                      <button
                        type="button"
                        className="cw-btn"
                        data-variant="ghost"
                        data-size="sm"
                        disabled={Boolean(busy)}
                        aria-busy={busy === `test:${c.id}` || undefined}
                        onClick={() => save(`test:${c.id}`, () => testChannelFn({ data: { id: c.id } }).then((r) => (r.ok && !r.result.ok ? { ok: false, error: `The test message was not delivered (${r.result.status}). Check the webhook URL.` } : r)), `Test sent to ${c.name}.`)}
                      >
                        {busy === `test:${c.id}` ? 'Working…' : 'Send test'}
                        <span className="cw-sr-only"> to {c.name}</span>
                      </button>
                      <button
                        type="button"
                        className="cw-btn"
                        data-variant="ghost"
                        data-size="sm"
                        disabled={Boolean(busy)}
                        aria-busy={busy === `toggle:${c.id}` || undefined}
                        onClick={() => save(`toggle:${c.id}`, () => updateChannelFn({ data: { id: c.id, enabled: !c.enabled } }), `${c.name} turned ${c.enabled ? 'off' : 'on'}.`)}
                      >
                        {busy === `toggle:${c.id}` ? 'Working…' : c.enabled ? 'Turn off' : 'Turn on'}
                        <span className="cw-sr-only"> {c.name}</span>
                      </button>
                      <button
                        type="button"
                        className="cw-btn"
                        data-variant="danger"
                        data-size="sm"
                        disabled={Boolean(busy)}
                        onClick={() => {
                          setError(null)
                          setDeleting(c)
                        }}
                      >
                        Delete<span className="cw-sr-only"> {c.name}</span>
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
      <ConfirmDialog
        open={deleting !== null}
        tone="danger"
        title={deleting ? `Delete the channel ${deleting.name}?` : ''}
        body={deleting && <p>Crosswire stops posting alerts to {deleting.kind === 'teams' ? 'Teams' : 'Slack'} ({deleting.urlHost}). To use it again, add it with its webhook URL.</p>}
        confirmLabel="Delete channel"
        busy={Boolean(busy)}
        error={deleting ? error : null}
        onCancel={() => {
          setError(null)
          setDeleting(null)
        }}
        onConfirm={async () => {
          if (!deleting) return
          if (await save(`delete:${deleting.id}`, () => deleteChannelFn({ data: { id: deleting.id } }), `${deleting.name} deleted.`)) setDeleting(null)
        }}
      />
      <form
        className="cw-form"
        data-wide
        aria-labelledby="add-channel-title"
        onSubmit={(e) => {
          e.preventDefault()
          const form = e.currentTarget
          const f = new FormData(form)
          const events = (Object.keys(EVENT_LABELS) as EventKey[]).filter((k) => f.get(`ev-${k}`) === 'on')
          // The form resets only after a successful save, so a failed URL can be fixed and retried.
          void save('add', () => addChannelFn({ data: { kind, name: String(f.get('name') ?? ''), url: String(f.get('url') ?? ''), events } }), 'Channel added.', form)
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
          <button className="cw-btn" type="submit" disabled={Boolean(busy)} aria-busy={busy === 'add' || undefined}>
            {busy === 'add' ? 'Adding…' : 'Add channel'}
          </button>
        </div>
      </form>
    </>
  )
}
