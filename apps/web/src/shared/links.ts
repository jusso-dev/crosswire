/**
 * Links built from feed or tenant data. Only http and https are ever rendered as a link; anything
 * else (javascript:, data:, file:, relative paths, junk) comes back as undefined so the caller shows
 * plain text. Pure, safe in client and server code.
 */
export function safeHref(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const value = raw.trim()
  if (!value) return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined
  } catch {
    return undefined
  }
}

/** True when a Markdown link target stays inside the app: a path ("/app/..."), never protocol-relative ("//host"). */
export function isInternalHref(href: string | undefined, origin?: string) {
  if (!href) return false
  if (href.startsWith('/')) return !href.startsWith('//') && !href.startsWith('/\\')
  return Boolean(origin) && (href === origin || href.startsWith(`${origin}/`))
}
