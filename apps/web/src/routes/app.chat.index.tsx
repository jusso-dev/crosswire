import { createFileRoute, getRouteApi, useNavigate, useRouter } from '@tanstack/react-router'
import { Notice } from '../components/ui'
import { useState } from 'react'
import { z } from 'zod'
import { plainMessage } from '../shared/messages'
import { newThread } from '../fns/chat'
import { AGENT_KEYS, AGENT_LABELS, type AgentKey } from '../shared/agents'

/** Empty state: pick who to talk to, which starts a conversation with that agent selected. */
export const Route = createFileRoute('/app/chat/')({
  // Triage hand-off: ?agent=intel&q=... opens a conversation with that question ready to send.
  validateSearch: z.object({ agent: z.string().optional(), q: z.string().max(2000).optional() }),
  component: ChatHome,
})

const AGENT_HELP: Record<AgentKey, string> = {
  lead: 'Not sure who to ask? Lead plans the work and hands it to the right specialist.',
  hunter: 'Writes searches for Defender and Sentinel. You approve before anything runs.',
  intel: 'Explains a threat or CVE and checks whether it touches your watch list.',
  responder: 'Drafts a response, like isolating a laptop, for an approver to decide.',
  scribe: 'Writes up what happened and remembers lessons for next time.',
}

function ChatHome() {
  const navigate = useNavigate()
  const router = useRouter()
  const [busy, setBusy] = useState<AgentKey | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { runtime } = getRouteApi('/app/chat').useLoaderData()
  const search = Route.useSearch()
  const start = async (k: AgentKey, question?: string) => {
    setBusy(k)
    setError(null)
    try {
      const t = await newThread({ data: { agentKey: k } })
      await router.invalidate()
      await navigate({ to: '/app/chat/$threadId', params: { threadId: t.id }, search: question ? { q: question } : undefined })
    } catch (err) {
      setError(plainMessage(err))
    } finally {
      setBusy(null)
    }
  }
  const handoff = search.q ? (AGENT_KEYS.find((k) => k === search.agent) ?? 'intel') : null
  return (
    <section className="cw-chat-home" aria-labelledby="chat-home-title">
      <h1 id="chat-home-title">Ask your security team</h1>
      <p className="cw-muted">Pick who to talk to. Agents read your intel, hunts and memory and can propose searches or actions. A person approves before anything runs.</p>
      {error && (
        <Notice tone="error" title="The conversation did not start">
          {error} Try again.
        </Notice>
      )}
      {handoff && search.q && (
        <div className="cw-confirm" data-tone="accent">
          <p className="cw-confirm-title">Ask {AGENT_LABELS[handoff].name} about this?</p>
          <p className="cw-wrap-any">{search.q}</p>
          <div className="cw-row">
            <button type="button" className="cw-btn" disabled={busy !== null || !runtime.configured} onClick={() => start(handoff, search.q)}>
              {busy === handoff ? 'Starting…' : `Start with ${AGENT_LABELS[handoff].name}`}
            </button>
            <span className="cw-muted">You can edit the question before it sends.</span>
          </div>
        </div>
      )}
      <ul className="cw-agentlist">
        {AGENT_KEYS.map((k) => (
          <li key={k}>
            <button
              type="button"
              className="cw-agentbtn"
              disabled={busy !== null || !runtime.configured}
              onClick={() => start(k)}
            >
              <strong>{AGENT_LABELS[k].name}</strong>
              <span className="cw-muted">{AGENT_HELP[k]}</span>
              <span className="cw-agentbtn-cta">{busy === k ? 'Starting…' : `Chat with ${AGENT_LABELS[k].name}`}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
