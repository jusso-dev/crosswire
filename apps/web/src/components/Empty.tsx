import type { ReactNode } from 'react'

/** Card-framed empty state with a heading. Prefer EmptyState from ui.tsx inside panels. */
export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="cw-card">
      <h3>{title}</h3>
      <div className="cw-empty">{children}</div>
      {action && <div className="cw-row cw-mt-sm">{action}</div>}
    </div>
  )
}
