import { useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { approveDirectiveFn, createDirectiveFn, retireDirectiveFn, type fetchAgentDesk } from '../../fns/agents'
import { useAction } from '../../components/action'
import { ConfirmDialog } from '../../components/confirm'
import { Notice, TableWrap } from '../../components/ui'
import { humanise } from '../../components/format'
import { agentsRoute } from './route'

type Desk = Awaited<ReturnType<typeof fetchAgentDesk>>

const DIRECTIVE_WORD: Record<string, string> = { draft: 'Draft', approved: 'Approved', retired: 'Retired' }

/** Org directives: drafts, approval by a different person, and retirement. The server enforces the rules. */
export function Directives({ directives }: { directives: Desk['directives'] }) {
  const { session } = agentsRoute.useRouteContext()
  const router = useRouter()
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [retiring, setRetiring] = useState<Desk['directives'][number] | null>(null)
  const action = useAction()
  const retire = useAction()
  const busy = action.busy !== null
  const refresh = () => router.invalidate()
  const approved = directives.filter((directive) => directive.status === 'approved').length
  return (
    <details className="cw-panel2">
      <summary className="cw-panel2-head cw-pointer">
        <h2 id="directive-title" className="cw-h2-compact cw-inline-h">
          Directives <span className="cw-muted num">({approved} in the prompt)</span>
        </h2>
      </summary>
      <div className="cw-panel2-body">
        <p className="cw-muted">Approved directives go into every agent prompt. A draft needs a different owner or approver. Retire removes it from the prompt.</p>
        {action.error && <Notice tone="error">{action.error}</Notice>}
        <form
          className="cw-form"
          onSubmit={async (e) => {
            e.preventDefault()
            const r = await action.run('create', () => createDirectiveFn({ data: { title, body } }))
            if (!r) return
            setTitle('')
            setBody('')
            await refresh().catch(() => {})
          }}
        >
          <label>
            Title
            <input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={120} />
          </label>
          <label>
            Directive
            <textarea value={body} onChange={(e) => setBody(e.target.value)} required rows={3} maxLength={2000} />
          </label>
          <button className="cw-btn" type="submit" disabled={busy || !title.trim() || !body.trim()} aria-busy={action.busy === 'create' || undefined}>
            {action.busy === 'create' ? 'Saving…' : 'Save draft'}
          </button>
        </form>
        {directives.length === 0 ? (
          <p className="cw-empty">No directives yet.</p>
        ) : (
          <TableWrap label="Org directives">
            <table className="cw-table">
              <thead>
                <tr>
                  <th scope="col">Status</th>
                  <th scope="col">Directive</th>
                  {session.canApprove && <th scope="col">Actions</th>}
                </tr>
              </thead>
              <tbody>
                {directives.map((directive) => (
                  <tr key={directive.id}>
                    <td>{DIRECTIVE_WORD[directive.status] ?? humanise(directive.status)}</td>
                    <td>
                      <strong>{directive.title}</strong>
                      <div>{directive.body}</div>
                    </td>
                    {session.canApprove && (
                      <td>
                        {directive.status === 'draft' && directive.createdBy !== session.user.id && (
                          <button
                            type="button"
                            className="cw-btn"
                            data-size="sm"
                            disabled={busy}
                            aria-busy={action.busy === `approve:${directive.id}` || undefined}
                            onClick={async () => {
                              const r = await action.run(`approve:${directive.id}`, () => approveDirectiveFn({ data: { directiveId: directive.id } }))
                              if (r) await refresh().catch(() => {})
                            }}
                          >
                            {action.busy === `approve:${directive.id}` ? 'Working…' : 'Approve'}
                          </button>
                        )}
                        {directive.status === 'draft' && directive.createdBy === session.user.id && <span className="cw-muted">Another approver must approve this.</span>}
                        {directive.status === 'approved' && (
                          <button
                            type="button"
                            className="cw-btn"
                            data-variant="ghost"
                            data-size="sm"
                            disabled={busy}
                            onClick={() => {
                              retire.setError(null)
                              setRetiring(directive)
                            }}
                          >
                            Retire<span className="cw-sr-only"> {directive.title}</span>
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </div>
      <ConfirmDialog
        open={retiring !== null}
        tone="danger"
        title={`Retire the directive “${retiring?.title ?? ''}”?`}
        body={<p>Agents stop reading it from their next reply. It stays in the record. To use it again, save it as a new draft for approval.</p>}
        confirmLabel="Retire directive"
        busy={retire.busy !== null}
        error={retire.error}
        onCancel={() => setRetiring(null)}
        onConfirm={async () => {
          const target = retiring
          if (!target) return
          const r = await retire.run('retire', () => retireDirectiveFn({ data: { directiveId: target.id } }))
          if (!r) return
          setRetiring(null)
          await refresh().catch(() => {})
        }}
      />
    </details>
  )
}
