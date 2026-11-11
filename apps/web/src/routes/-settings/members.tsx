import { useState } from 'react'
import { fetchMembers, removeMemberFn, setRoleFn } from '../../fns/settings'
import { ConfirmDialog } from '../../components/confirm'
import { TableWrap } from '../../components/ui'
import { ROLE_LABEL, useSave } from './shared'

type Role = 'owner' | 'approver' | 'analyst'
type MembersData = Awaited<ReturnType<typeof fetchMembers>>
type Member = MembersData['members'][number]

/**
 * A role change needs a second look when it grants approval rights (Approver or Owner) or takes
 * Owner away. Owners cannot change their own role here; the server refuses it (fns/settings.ts).
 */
export function roleChangeNeedsConfirm(from: Role, to: Role) {
  return from !== to && (to === 'owner' || to === 'approver' || from === 'owner')
}

const ROLE_EFFECT: Record<Role, string> = {
  owner: 'They will be able to manage people, connections and settings, and approve actions.',
  approver: 'They will be able to approve or reject actions that change your tenant.',
  analyst: 'They will be able to investigate and ask for actions, but not approve them.',
}

export function Members({ data }: { data: MembersData }) {
  const { busy, save, feedback, setError, error } = useSave()
  const [pending, setPending] = useState<{ member: Member; role: Role } | null>(null)
  const [removing, setRemoving] = useState<Member | null>(null)

  const apply = (member: Member, role: Role) =>
    save(`role:${member.userId}`, () => setRoleFn({ data: { userId: member.userId, role } }), `${member.name || member.email} is now ${ROLE_LABEL[role]}.`)

  return (
    <>
      {!pending && !removing && feedback}
      <TableWrap label="Members">
        <table className="cw-table">
          <thead>
            <tr>
              <th scope="col">Person</th>
              <th scope="col">Role</th>
              {data.canManage && (
                <th scope="col">
                  <span className="cw-sr-only">Actions</span>
                </th>
              )}
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
                    <RoleControl
                      member={m}
                      busy={busy}
                      onApply={(role) => {
                        if (roleChangeNeedsConfirm(m.role as Role, role)) {
                          setError(null)
                          setPending({ member: m, role })
                        } else void apply(m, role)
                      }}
                    />
                  ) : (
                    <span className="cw-badge" data-tone={m.role === 'analyst' ? undefined : 'info'}>
                      {ROLE_LABEL[m.role] ?? m.role}
                    </span>
                  )}
                  {m.userId === data.me && <span className="cw-muted"> (you)</span>}
                  {m.roleSource === 'entra' && (
                    <div className="cw-muted cw-entra-managed">
                      <span className="cw-badge">Managed by Entra group</span>
                      {data.canManage && m.userId !== data.me && ' A change here is replaced at their next sign-in.'}
                    </div>
                  )}
                </td>
                {data.canManage && (
                  <td>
                    {m.userId !== data.me && (
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
                        Remove<span className="cw-sr-only"> {m.email}</span>
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </TableWrap>
      {!data.canManage && <p className="cw-muted">Only owners change roles.</p>}
      {data.canManage && <p className="cw-muted">Choose a role, then press Apply. You cannot change your own role or remove yourself. Ask another owner.</p>}
      <ConfirmDialog
        open={pending !== null}
        tone={pending?.member.role === 'owner' ? 'danger' : 'accent'}
        title={pending ? `Make ${pending.member.name || pending.member.email} ${ROLE_LABEL[pending.role]}?` : ''}
        body={
          pending && (
            <p>
              <strong>{pending.member.email}</strong> changes from {ROLE_LABEL[pending.member.role]} to {ROLE_LABEL[pending.role]}. {ROLE_EFFECT[pending.role]}
              {pending.member.roleSource === 'entra' && ' Their role is managed by an Entra group, so this change is replaced at their next sign-in.'}
            </p>
          )
        }
        confirmLabel={pending ? `Make ${ROLE_LABEL[pending.role]}` : 'Apply'}
        busy={Boolean(busy)}
        error={pending ? error : null}
        onCancel={() => {
          setError(null)
          setPending(null)
        }}
        onConfirm={async () => {
          if (!pending) return
          if (await apply(pending.member, pending.role)) setPending(null)
        }}
      />
      <ConfirmDialog
        open={removing !== null}
        tone="danger"
        title={removing ? `Remove ${removing.name || removing.email} from this organisation?` : ''}
        body={
          removing && (
            <p>
              <strong>{removing.email}</strong> loses access now and cannot sign in to this organisation again, even with Microsoft sign-in. To let them back in, an admin deletes their removal record
              (see docs/auth.md).
            </p>
          )
        }
        confirmLabel="Remove person"
        busy={Boolean(busy)}
        error={removing ? error : null}
        onCancel={() => {
          setError(null)
          setRemoving(null)
        }}
        onConfirm={async () => {
          if (!removing) return
          if (await save(`remove:${removing.userId}`, () => removeMemberFn({ data: { userId: removing.userId } }), `${removing.name || removing.email} removed.`)) setRemoving(null)
        }}
      />
    </>
  )
}

/** Choose, then Apply: a stray arrow key or scroll on the select changes nothing on its own. */
function RoleControl({ member, busy, onApply }: { member: Member; busy: string | null; onApply: (role: Role) => void }) {
  const [role, setRole] = useState<Role>(member.role as Role)
  const label = `Role for ${member.email}`
  const changed = role !== member.role
  const mine = busy === `role:${member.userId}`
  return (
    <span className="cw-row cw-nowrap-flex" data-center>
      <select aria-label={label} value={role} onChange={(e) => setRole(e.target.value as Role)} disabled={Boolean(busy)}>
        <option value="analyst">Analyst</option>
        <option value="approver">Approver</option>
        <option value="owner">Owner</option>
      </select>
      <button type="button" className="cw-btn" data-size="sm" disabled={!changed || Boolean(busy)} aria-busy={mine || undefined} onClick={() => onApply(role)}>
        {mine ? 'Working…' : 'Apply'}
        <span className="cw-sr-only"> role for {member.email}</span>
      </button>
      {changed && !busy && (
        <button type="button" className="cw-btn" data-variant="quiet" data-size="sm" onClick={() => setRole(member.role as Role)}>
          Undo<span className="cw-sr-only"> role choice for {member.email}</span>
        </button>
      )}
    </span>
  )
}
