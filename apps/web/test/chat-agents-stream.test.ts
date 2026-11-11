import { EventType, type StreamChunk } from '@tanstack/ai'
import type { UIMessage } from '@tanstack/ai-react'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { getDb } from '../src/server/db/client'
import { agentMemoryEntries, agentRuns } from '../src/server/db/schema'
import { createRelay, customEvent, isTerminal } from '../src/server/chat/relay'
import { finishRun, listRunsPage, requestRunCancel, runStatuses, startRun } from '../src/server/agents/runs'
import { appendMemory, countReviewQueue, listReviewQueuePage } from '../src/server/agents/memory'
import { isMacPlatform, paletteShortcut, setSingleKeyShortcuts, shouldHandleShortcut, singleKeyShortcutsOn, SHORTCUTS_KEY } from '../src/components/keys'
import { eventLabel, fmtCost, fmtDuration, outputLabel, runStatusChanged, runStatusView } from '../src/components/runs'
import { budgetPercent, cappedNote, syncSearchText } from '../src/routes/-agents/helpers'
import { refusalState } from '../src/fns/agents'
import { appendNewer, oldestStoredAt, prependOlder, savedTargetId, toUiMessages, withSaved, type Meta } from '../src/routes/-chat/messages'
import { makeOrg, makeUser } from './helpers'

const chunk = (type: string, extra: Record<string, unknown> = {}) => ({ type, timestamp: 1, ...extra }) as unknown as StreamChunk

async function drain(it: AsyncIterable<StreamChunk>) {
  const out: StreamChunk[] = []
  for await (const c of it) out.push(c)
  return out
}

describe('chat relay (#128)', () => {
  it('passes chunks through in order and ends when the run ends', async () => {
    const relay = createRelay()
    relay.push(chunk(EventType.RUN_STARTED))
    const reading = drain(relay.iterable)
    relay.push(chunk(EventType.TEXT_MESSAGE_CONTENT, { delta: 'hi' }))
    relay.end()
    expect((await reading).map((c) => c.type)).toEqual([EventType.RUN_STARTED, EventType.TEXT_MESSAGE_CONTENT])
  })

  it('a reader that stops early detaches: the run can keep pushing and nothing throws or buffers', async () => {
    const relay = createRelay()
    relay.push(chunk(EventType.RUN_STARTED))
    const iterator = relay.iterable[Symbol.asyncIterator]()
    expect((await iterator.next()).done).toBe(false)
    const waiting = iterator.next()
    await iterator.return!()
    expect((await waiting).done).toBe(true)
    expect(relay.detached).toBe(true)
    for (let i = 0; i < 1000; i++) relay.push(chunk(EventType.TEXT_MESSAGE_CONTENT, { delta: 'x' }))
    relay.end()
    expect((await iterator.next()).done).toBe(true)
  })

  it('names terminal events and builds custom events', () => {
    expect(isTerminal(chunk(EventType.RUN_FINISHED))).toBe(true)
    expect(isTerminal(chunk(EventType.RUN_ERROR))).toBe(true)
    expect(isTerminal(chunk(EventType.TEXT_MESSAGE_CONTENT))).toBe(false)
    expect(customEvent('crosswire:saved', { messageId: 'm' })).toMatchObject({ type: EventType.CUSTOM, name: 'crosswire:saved', value: { messageId: 'm' } })
  })
})

/**
 * A tiny stand-in for `document.querySelector` over a list of elements, enough to check the open
 * dialog selector: tag, `open`, `role` and `aria-modal`. There is no DOM in this test set-up.
 */
type FakeEl = { tag: string; open?: boolean; role?: string; ariaModal?: string }
function fakeDoc(els: FakeEl[]) {
  const matches = (el: FakeEl, part: string) => {
    if (part === 'dialog[open]') return el.tag === 'dialog' && Boolean(el.open)
    if (part === '[role="alertdialog"]:not(dialog)') return el.role === 'alertdialog' && el.tag !== 'dialog'
    if (part === '[role="dialog"][aria-modal="true"]:not(dialog)') return el.role === 'dialog' && el.ariaModal === 'true' && el.tag !== 'dialog'
    throw new Error(`fakeDoc does not know the selector part ${part}`)
  }
  return { querySelector: (sel: string) => (els.some((el) => sel.split(',').some((part) => matches(el, part.trim()))) ? ({} as Element) : null) }
}

describe('keyboard shortcuts (#168, #177)', () => {
  const doc = (open: string | null) => fakeDoc(open === 'dialog[open]' ? [{ tag: 'dialog', open: true }] : open === '[role="alertdialog"]' ? [{ tag: 'div', role: 'alertdialog' }] : [])
  const key = (over: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; defaultPrevented: boolean; target: EventTarget | null }> = {}) => ({
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    defaultPrevented: false,
    target: { tagName: 'BODY', isContentEditable: false } as unknown as EventTarget,
    ...over,
  })

  it('acts on a plain key press with no dialog open', () => {
    expect(shouldHandleShortcut(key(), doc(null))).toBe(true)
  })

  it('does nothing while typing', () => {
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) expect(shouldHandleShortcut(key({ target: { tagName } as unknown as EventTarget }), doc(null))).toBe(false)
    expect(shouldHandleShortcut(key({ target: { tagName: 'DIV', isContentEditable: true } as unknown as EventTarget }), doc(null))).toBe(false)
  })

  it('does nothing with a modifier held, or after another handler took the key', () => {
    expect(shouldHandleShortcut(key({ metaKey: true }), doc(null))).toBe(false)
    expect(shouldHandleShortcut(key({ ctrlKey: true }), doc(null))).toBe(false)
    expect(shouldHandleShortcut(key({ altKey: true }), doc(null))).toBe(false)
    expect(shouldHandleShortcut(key({ defaultPrevented: true }), doc(null))).toBe(false)
  })

  it('does nothing while a dialog or a confirmation is open', () => {
    expect(shouldHandleShortcut(key(), doc('dialog[open]'))).toBe(false)
    expect(shouldHandleShortcut(key(), doc('[role="alertdialog"]'))).toBe(false)
    expect(shouldHandleShortcut(key(), fakeDoc([{ tag: 'dialog', role: 'alertdialog', open: true }]))).toBe(false)
    expect(shouldHandleShortcut(key(), fakeDoc([{ tag: 'aside', role: 'dialog', ariaModal: 'true' }]))).toBe(false)
  })

  it('still works when a confirmation is mounted but closed', () => {
    // ConfirmDialog keeps its <dialog role="alertdialog"> in the page while closed.
    expect(shouldHandleShortcut(key(), fakeDoc([{ tag: 'dialog', role: 'alertdialog', open: false }, { tag: 'dialog' }]))).toBe(true)
    expect(shouldHandleShortcut(key(), fakeDoc([{ tag: 'dialog', role: 'dialog', ariaModal: 'true', open: false }]))).toBe(true)
    expect(shouldHandleShortcut(key(), fakeDoc([{ tag: 'aside', role: 'dialog', ariaModal: 'false' }]))).toBe(true)
  })

  it('stores the single-key setting, on by default, and survives a storage error', () => {
    const store = new Map<string, string>()
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) }
    expect(singleKeyShortcutsOn(storage)).toBe(true)
    setSingleKeyShortcuts(false, storage)
    expect(store.get(SHORTCUTS_KEY)).toBe('off')
    expect(singleKeyShortcutsOn(storage)).toBe(false)
    setSingleKeyShortcuts(true, storage)
    expect(singleKeyShortcutsOn(storage)).toBe(true)
    const broken = {
      getItem: () => {
        throw new Error('denied')
      },
    }
    expect(singleKeyShortcutsOn(broken)).toBe(true)
    expect(singleKeyShortcutsOn(undefined)).toBe(true)
  })

  it('names the palette shortcut by platform', () => {
    expect(isMacPlatform({ platform: 'MacIntel' })).toBe(true)
    expect(isMacPlatform({ userAgentData: { platform: 'macOS' } })).toBe(true)
    expect(isMacPlatform({ platform: 'Win32' })).toBe(false)
    expect(isMacPlatform({ platform: 'Linux x86_64' })).toBe(false)
    expect(isMacPlatform(undefined)).toBe(false)
    expect(paletteShortcut(true)).toEqual({ aria: 'Meta+K', hint: '⌘K' })
    expect(paletteShortcut(false)).toEqual({ aria: 'Control+K', hint: 'Ctrl K' })
  })
})

describe('run formatters (#161, #174, #177)', () => {
  it('rounds durations to whole seconds before splitting into minutes', () => {
    expect(fmtDuration(null)).toBe('still running')
    expect(fmtDuration(850)).toBe('850 ms')
    expect(fmtDuration(12_340)).toBe('12.3 s')
    expect(fmtDuration(59_940)).toBe('59.9 s')
    expect(fmtDuration(59_950)).toBe('1 min 0 s')
    expect(fmtDuration(59_960)).toBe('1 min 0 s')
    expect(fmtDuration(119_600)).toBe('2 min 0 s')
    expect(fmtDuration(125_000)).toBe('2 min 5 s')
  })

  it('gives an unknown run status a neutral tone and plain words', () => {
    expect(runStatusView('interrupted')).toEqual({ word: 'Stopped', tone: 'warn' })
    expect(runStatusView('completed')).toEqual({ word: 'Completed', tone: 'ok' })
    expect(runStatusView('waiting_on_model')).toEqual({ word: 'waiting on model', tone: undefined })
  })

  it('labels events and outputs, humanising unknown kinds', () => {
    expect(eventLabel('cancel_requested')).toBe('Stop requested')
    expect(eventLabel('new_kind_here')).toBe('new kind here')
    expect(outputLabel('assistant')).toBe('Reply')
    expect(outputLabel('tool:get_hunt:error')).toBe('Tool failed: get_hunt')
    expect(outputLabel('brand_new')).toBe('brand new')
  })

  it('shows run cost in US dollars', () => {
    expect(fmtCost(1234, true)).toBe('US$0.0012')
    expect(fmtCost(1234, false)).toBe('unpriced')
    expect(fmtCost(null, true)).toBe('unpriced')
  })

  it('notices when a polled run changes status or disappears', () => {
    expect(runStatusChanged({ a: 'running' }, [{ id: 'a', status: 'running' }])).toBe(false)
    expect(runStatusChanged({ a: 'running' }, [{ id: 'a', status: 'completed' }])).toBe(true)
    expect(runStatusChanged({ a: 'running' }, [])).toBe(true)
  })
})

describe('agents page helpers (#161, #171, #174)', () => {
  it('keeps the log search box in step with the URL after Back or a palette link', () => {
    // Typing: the URL has not moved yet.
    expect(syncSearchText({ local: 'phish', prevUrl: '', url: '', written: null })).toBe('phish')
    // Our own debounced write comes back through the URL: keep what is being typed.
    expect(syncSearchText({ local: 'phishi', prevUrl: '', url: 'phish', written: 'phish' })).toBe('phishi')
    // Back: the URL goes to an older value from outside.
    expect(syncSearchText({ local: 'phish', prevUrl: 'phish', url: '', written: 'phish' })).toBe('')
    // A palette link sets a new query.
    expect(syncSearchText({ local: 'phish', prevUrl: 'phish', url: 'kql', written: 'phish' })).toBe('kql')
  })

  it('rounds the budget share down, so 99.5% is never shown as 100%', () => {
    expect(budgetPercent(995, 1000)).toBe(99)
    expect(budgetPercent(1000, 1000)).toBe(100)
    expect(budgetPercent(5000, 1000)).toBe(100)
    expect(budgetPercent(10, 0)).toBe(0)
  })

  it('says "used up" only when the server would refuse', () => {
    const base = { inputTokens: 995, dailyInputCap: 1000, costMicros: 0, spendCapMicros: null, unpriced: 0, unmeasured: 0 }
    expect(refusalState(base)).toBeNull()
    expect(refusalState({ ...base, inputTokens: 1000 })).toBe('tokens')
    expect(refusalState({ ...base, unmeasured: 1 })).toBe('unmeasured')
    expect(refusalState({ ...base, spendCapMicros: 100, unpriced: 1 })).toBe('unpriced')
    expect(refusalState({ ...base, spendCapMicros: 100, costMicros: 100 })).toBe('spend')
  })

  it('says a capped list is capped', () => {
    expect(cappedNote(100, false, 'runs')).toBeNull()
    expect(cappedNote(100, true, 'runs')).toBe('Showing the latest 100 runs. Older ones exist.')
    expect(cappedNote(100, true, 'held notes', 250)).toBe('Showing the latest 100 of 250 held notes.')
  })
})

describe('conversation message helpers (#169, #171)', () => {
  const stored = (id: string, role: 'user' | 'assistant', at: string) => ({ id, role, content: id, agentKey: null, metadata: {}, createdAt: at })
  const live = (id: string, role: 'user' | 'assistant') => ({ id, role, parts: [{ type: 'text', content: id }] }) as UIMessage

  it('finds the reply a saved event belongs to, and merges the stored id without changing the client id', () => {
    const msgs = [...toUiMessages([stored('m1', 'user', '2026-11-01T00:00:00Z')]), live('client-a', 'assistant')]
    expect(savedTargetId(msgs)).toBe('client-a')
    expect(savedTargetId([...msgs, live('q2', 'user')])).toBeNull()
    const meta = withSaved({} as Meta, { messageId: 'db-1', runId: 'r1', tools: [{ tool: 'search_intel', error: null }], error: null }, 'intel')
    expect(meta).toEqual({ agentKey: 'intel', persistedId: 'db-1', crosswire: { tools: [{ tool: 'search_intel', error: null }], error: null, runId: 'r1' } })
    expect(withSaved({ agentKey: 'lead' }, undefined, 'intel')).toEqual({ agentKey: 'lead' })
  })

  it('puts older messages first and never repeats one already shown', () => {
    const current = toUiMessages([stored('m3', 'user', '2026-11-03T00:00:00Z'), stored('m4', 'assistant', '2026-11-04T00:00:00Z')])
    const older = toUiMessages([stored('m2', 'assistant', '2026-11-02T00:00:00Z'), stored('m3', 'user', '2026-11-03T00:00:00Z')])
    expect(prependOlder(older, current).map((m) => m.id)).toEqual(['m2', 'm3', 'm4'])
    expect(oldestStoredAt(current)).toBe('2026-11-03T00:00:00.000Z')
    expect(oldestStoredAt([live('x', 'user')])).toBeNull()
  })

  it('adds a reply that finished while the analyst was away, once', () => {
    const current = toUiMessages([stored('m1', 'user', '2026-11-01T00:00:00Z')])
    const fresh = toUiMessages([stored('m1', 'user', '2026-11-01T00:00:00Z'), stored('m2', 'assistant', '2026-11-01T00:01:00Z')])
    expect(appendNewer(current, fresh).map((m) => m.id)).toEqual(['m1', 'm2'])
    expect(appendNewer(appendNewer(current, fresh), fresh).map((m) => m.id)).toEqual(['m1', 'm2'])
  })
})

describe('paged lists (#170, #171)', () => {
  it('pages runs with hasMore and a before cursor, and reads status only for this organisation', async () => {
    const orgId = await makeOrg('RunPages')
    const other = await makeOrg('RunPagesOther')
    const ids: string[] = []
    for (let i = 0; i < 5; i++) {
      const run = await startRun({ orgId, agentKey: 'intel' })
      await getDb().update(agentRuns).set({ startedAt: new Date(Date.now() - (10 - i) * 60_000) }).where(eq(agentRuns.id, run!.id))
      ids.push(run!.id)
    }
    const first = await listRunsPage(orgId, { limit: 3 })
    expect(first.runs.map((r) => r.id)).toEqual([ids[4], ids[3], ids[2]])
    expect(first.hasMore).toBe(true)
    const older = await listRunsPage(orgId, { limit: 3, before: new Date(first.runs.at(-1)!.startedAt) })
    expect(older.runs.map((r) => r.id)).toEqual([ids[1], ids[0]])
    expect(older.hasMore).toBe(false)

    await finishRun(orgId, ids[0]!, 'completed')
    await requestRunCancel(orgId, ids[1]!)
    const statuses = await runStatuses(orgId, [ids[0]!, ids[1]!])
    expect(Object.fromEntries(statuses.map((s) => [s.id, [s.status, s.cancelRequested]]))).toEqual({ [ids[0]!]: ['completed', false], [ids[1]!]: ['running', true] })
    expect(await runStatuses(other, [ids[0]!])).toEqual([])
    expect(await runStatuses(orgId, [])).toEqual([])
  })

  it('pages the review queue and counts every held note', async () => {
    const orgId = await makeOrg('QueuePages')
    const author = await makeUser()
    const ids: string[] = []
    for (let i = 0; i < 4; i++) {
      const row = await appendMemory({ orgId, agentKey: 'intel', kind: 'fact', body: `held note ${i}`, sourceType: 'thread', authorId: author })
      await getDb().update(agentMemoryEntries).set({ createdAt: new Date(Date.now() - (10 - i) * 60_000) }).where(eq(agentMemoryEntries.id, row.id))
      ids.push(row.id)
    }
    const first = await listReviewQueuePage(orgId, { limit: 3 })
    expect(first.rows.map((r) => r.id)).toEqual([ids[3], ids[2], ids[1]])
    expect(first.hasMore).toBe(true)
    const older = await listReviewQueuePage(orgId, { limit: 3, before: first.rows.at(-1)!.createdAt })
    expect(older.rows.map((r) => r.id)).toEqual([ids[0]])
    expect(older.hasMore).toBe(false)
    expect(await countReviewQueue(orgId)).toBe(4)
  })
})
