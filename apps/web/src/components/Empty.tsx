import type { ReactNode } from 'react'

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="cw-card">
      <h3>{title}</h3>
      <div className="cw-empty">{children}</div>
    </div>
  )
}
