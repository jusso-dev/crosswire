import type { ReactNode } from 'react'

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="cw-card">
      <h3>{title}</h3>
      <div className="cw-empty">{children}</div>
      {action && <div className="cw-row" style={{ marginTop: 'var(--space-sm)' }}>{action}</div>}
    </div>
  )
}
