/**
 * Pure helpers for the Agents page (#161, #174). No React, no server code, so tests can call them.
 */

/**
 * What the log search box should show after the URL's `q` changes (#174).
 * - URL unchanged: keep what the person is typing.
 * - URL now equals what this box last wrote (its own debounced write coming back): keep typing.
 * - Anything else came from outside (Back, Forward, a palette link): show the URL's value.
 */
export function syncSearchText(input: { local: string; prevUrl: string; url: string; written: string | null }) {
  if (input.url === input.prevUrl) return input.local
  if (input.written !== null && input.url === input.written) return input.local
  return input.url
}

/**
 * Share of the daily token budget used, rounded down, so 99.5% reads 99%, never 100% while calls
 * still succeed (#161). Capped at 100.
 */
export function budgetPercent(used: number, cap: number) {
  if (cap <= 0) return 0
  return Math.min(100, Math.floor((used / cap) * 100))
}

/** "Showing the latest 100" when a list stops at its page size and older rows exist (#171). */
export function cappedNote(shown: number, hasMore: boolean, noun: string, total?: number) {
  if (!hasMore) return null
  return total !== undefined && total > shown ? `Showing the latest ${shown} of ${total} ${noun}.` : `Showing the latest ${shown} ${noun}. Older ones exist.`
}
