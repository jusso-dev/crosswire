import { Notice } from '../../components/ui'

/** "What your decision is bound to": the content fingerprint the approval covers. Read-only. */
export function BindingPanel({ binding }: { binding: { sha256: string | null; schemaVersion: number; matches: boolean; enforced: boolean } }) {
  return (
    <section className="cw-panel2" aria-labelledby="bind-title">
      <div className="cw-panel2-head">
        <h2 id="bind-title">What your decision is bound to</h2>
      </div>
      <div className="cw-panel2-body">
        {binding.sha256 ? (
          <>
            <p>Approval covers this exact title, action, targets, blast radius and details. If any of them change, execution is refused and a new action is needed.</p>
            <dl className="cw-provenance">
              <dt>Content fingerprint</dt>
              <dd>
                <code className="cw-hash">{binding.sha256}</code>
              </dd>
              <dt>Format version</dt>
              <dd className="num">{binding.schemaVersion}</dd>
              <dt>Check now</dt>
              <dd>
                {binding.matches ? (
                  <span className="cw-badge" data-tone="ok">
                    Matches the stored content
                  </span>
                ) : (
                  <span className="cw-badge" data-tone="danger">
                    Does not match. Execution will be refused
                  </span>
                )}
              </dd>
              {!binding.enforced && (
                <>
                  <dt>Enforcement</dt>
                  <dd>
                    <span className="cw-badge" data-tone="warn">
                      Off (APPROVAL_BINDING=legacy)
                    </span>
                  </dd>
                </>
              )}
            </dl>
          </>
        ) : (
          <Notice tone="warn" title="Not bound">
            This action was created before content binding, so it has no fingerprint. {binding.enforced ? 'Execution will be refused. Ask for a new action.' : 'Binding enforcement is off in this deployment.'}
          </Notice>
        )}
      </div>
    </section>
  )
}
