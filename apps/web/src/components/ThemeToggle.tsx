import { useEffect, useState } from 'react'

type Pref = 'system' | 'light' | 'dark'

function apply(pref: Pref) {
  const dark = pref === 'dark' || (pref === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
}

/** Theme choice as a native labelled select: System follows the OS live; the choice is saved per browser. */
export function ThemeToggle() {
  const [pref, setPref] = useState<Pref>('system')
  useEffect(() => {
    let saved: string | null = null
    try {
      saved = localStorage.getItem('cw-theme')
    } catch {
      // Storage blocked: follow the system theme.
    }
    // Sync from storage after hydration (the pre-paint script already applied it).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (saved === 'light' || saved === 'dark') setPref(saved)
  }, [])
  useEffect(() => {
    if (pref !== 'system') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const on = () => apply('system')
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [pref])
  return (
    <label className="cw-theme">
      <span>Theme</span>
      <select
        value={pref}
        onChange={(e) => {
          const next = e.target.value as Pref
          setPref(next)
          try {
            if (next === 'system') localStorage.removeItem('cw-theme')
            else localStorage.setItem('cw-theme', next)
          } catch {
            // Storage blocked: the choice applies to this page only.
          }
          apply(next)
        }}
      >
        <option value="system">System</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </label>
  )
}
