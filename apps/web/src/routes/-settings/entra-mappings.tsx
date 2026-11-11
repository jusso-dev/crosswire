import { useState } from 'react'
import { addEntraMappingFn, fetchEntraMappings, removeEntraMappingFn, setEntraRequireMappedGroupFn } from '../../fns/settings'
import { ConfirmDialog } from '../../components/confirm'
import { TableWrap } from '../../components/ui'
import { Field, ROLE_LABEL, useSave } from './shared'

type Data = Awaited<ReturnType<typeof fetchEntraMappings>>
type Mapping = Data['mappings'][number]
type Kind = 'group' | 'app_role'

const KIND_LABEL: Record<Kind, string> = { group: 'Entra group', app_role: 'App role' }

/**
 * Entra group and app-role mappings (owner request, #195). Owners add and remove them; everyone can
 * read them. Removing one, or turning on "Only people in a mapped group can sign in", needs a confirm.
 */
export function EntraMappings({ data }: { data: Data }) {
  const { busy, save, feedback, error, setError } = useSave()
  const [removing, setRemoving] = useState<Mapping | null>(null)
  const [confirmRequire, setConfirmRequire] = useState(false)
  const [kind, setKind] = useState<Kind>('group')

  if (!data.tenantBound) return <p className="cw-muted">This organisation is not connected to an Entra tenant, so group mappings do not apply.</p>

  return (
    <>
      <p className="cw-muted">
        At each Microsoft sign-in, a person gets the highest role their Entra groups or app roles map to. That includes a lower role when they leave a group. People who match nothing join as
        analysts, and anyone whose role came from a group drops to analyst. Roles set by hand are kept.
      </p>
      {!removing && !confirmRequire && feedback}
      {data.mappings.length === 0 ? (
        <p className="cw-empty">No mappings yet. Everyone from your tenant joins as an analyst, and owners set roles by hand.</p>
      ) : (
        <TableWrap label="Entra group mappings">
          <table className="cw-table">
            <thead>
              <tr>
                <th scope="col">Type</th>
                <th scope="col">Group ID or app role</th>
                <th scope="col">Crosswire role</th>
                {data.canManage && (
                  <th scope="col">
                    <span className="cw-sr-only">Actions</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {data.mappings.map((m) => (
                <tr key={m.id}>
                  <td>{KIND_LABEL[m.kind]}</td>
                  <td className="mono">{m.value}</td>
                  <td>{ROLE_LABEL[m.role]}</td>
                  {data.canManage && (
                    <td>
                      <button
                        type="button"
                        className="cw-btn"
                        data-variant="danger"
                        data-size="sm"
                        disabled={Boolean(busy)}
                        onClick={() => {
                          setError(null)
                          setRemoving(m)
                        }}
                      >
                        Remove<span className="cw-sr-only"> mapping for {m.value}</span>
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}

      {data.canManage ? (
        <label className="cw-check cw-entra-require">
          <input
            type="checkbox"
            checked={data.requireMappedGroup}
            disabled={Boolean(busy)}
            onChange={(e) => {
              setError(null)
              if (e.target.checked) setConfirmRequire(true)
              else void save('require', () => setEntraRequireMappedGroupFn({ data: { on: false } }), 'Anyone from your tenant can sign in again.')
            }}
          />{' '}
          Only people in a mapped group can sign in
        </label>
      ) : (
        <p className="cw-muted">{data.requireMappedGroup ? 'Only people in a mapped group or app role can sign in.' : 'Anyone from your tenant can sign in.'} Owners change mappings.</p>
      )}

      <ConfirmDialog
        open={removing !== null}
        tone="danger"
        title={removing ? `Remove the mapping for ${removing.value}?` : ''}
        body={
          removing && (
            <p>
              People in this {removing.kind === 'group' ? 'group' : 'app role'} stop getting {ROLE_LABEL[removing.role]} from it. At their next sign-in they get the highest role another mapping gives,
              or analyst if none.
            </p>
          )
        }
        confirmLabel="Remove mapping"
        busy={Boolean(busy)}
        error={removing ? error : null}
        onCancel={() => {
          setError(null)
          setRemoving(null)
        }}
        onConfirm={async () => {
          if (!removing) return
          if (await save(`remove:${removing.id}`, () => removeEntraMappingFn({ data: { id: removing.id } }), `Mapping for ${removing.value} removed.`)) setRemoving(null)
        }}
      />

      <ConfirmDialog
        open={confirmRequire}
        tone="danger"
        title="Only let people in a mapped group sign in?"
        body={<p>From their next sign-in, anyone whose groups and app roles match no mapping is refused. Check that every owner and approver is in a mapped group first.</p>}
        confirmLabel="Turn on"
        busy={Boolean(busy)}
        error={confirmRequire ? error : null}
        onCancel={() => {
          setError(null)
          setConfirmRequire(false)
        }}
        onConfirm={async () => {
          if (await save('require', () => setEntraRequireMappedGroupFn({ data: { on: true } }), 'Only people in a mapped group can sign in now.')) setConfirmRequire(false)
        }}
      />

      {data.canManage && (
        <form
          className="cw-form"
          data-wide
          aria-labelledby="add-mapping-title"
          onSubmit={(e) => {
            e.preventDefault()
            const form = e.currentTarget
            const f = new FormData(form)
            void save(
              'add',
              () => addEntraMappingFn({ data: { kind, value: String(f.get('value') ?? ''), role: String(f.get('role') ?? 'analyst') as 'owner' | 'approver' | 'analyst' } }),
              "Mapping added. It applies at each person's next sign-in.",
              form,
            )
          }}
        >
          <h3 id="add-mapping-title" className="cw-m0 cw-mt-sm">
            Add a mapping
          </h3>
          <div className="cw-formgrid">
            <Field label="Type">
              {(p) => (
                <select {...p} value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
                  <option value="group">Entra group (Object ID)</option>
                  <option value="app_role">App role (Value)</option>
                </select>
              )}
            </Field>
            <Field label="Role in Crosswire">
              {(p) => (
                <select {...p} name="role" defaultValue="analyst">
                  <option value="analyst">Analyst</option>
                  <option value="approver">Approver</option>
                  <option value="owner">Owner</option>
                </select>
              )}
            </Field>
          </div>
          <Field label={kind === 'group' ? 'Group Object ID' : 'App role value'} hint={kind === 'group' ? 'From Entra admin centre, Groups, the group, Object ID.' : 'From the app registration, App roles, Value.'}>
            {(p) => <input {...p} name="value" required autoComplete="off" spellCheck={false} placeholder={kind === 'group' ? '1b2c3d4e-0000-1111-2222-333344445555' : 'Crosswire.Approver'} />}
          </Field>
          <div>
            <button className="cw-btn" type="submit" disabled={Boolean(busy)} aria-busy={busy === 'add' || undefined}>
              {busy === 'add' ? 'Adding…' : 'Add mapping'}
            </button>
          </div>
        </form>
      )}
    </>
  )
}
