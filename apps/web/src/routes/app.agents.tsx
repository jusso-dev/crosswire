import { Link, createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { fetchActivity, fetchAgentDesk, fetchReviewQueue, fetchRunDetail, fetchRuns, fetchSkills } from '../fns/agents'
import { AGENT_KEYS, AGENT_LABELS, isAgentKey, type AgentKey } from '../shared/agents'
import { plainMessage } from '../shared/messages'
import { EmptyState, Notice, PageHead, SkeletonPage } from '../components/ui'
import { pageTitle } from '../components/errors'
import { ACTION_WORDS, DecisionLog } from './-agents/DecisionLog'
import { RunsView } from './-agents/RunsView'
import { ReviewQueue } from './-agents/ReviewQueue'
import { SkillsView } from './-agents/SkillsView'
import { Memory } from './-agents/Memory'
import { BudgetMeter } from './-agents/BudgetMeter'
import { Directives } from './-agents/Directives'

/**
 * Agents page. Memory is the default view: one agent, its notes, usage and directives.
 * Review is the held-memory inbox. Runs is the run timeline with replay and Stop. Log is the
 * decision log. Skills lists the reviewed runbooks. Promote, replace, compact, Stop and directive
 * approval are enforced on the server; the screen explains why a control is unavailable.
 * Each view lives in `routes/-agents/` (#176). This file keeps the loader and the layout.
 */
export const Route = createFileRoute('/app/agents')({
  validateSearch: z.object({
    agent: z.string().optional(),
    actor: z.string().optional(),
    q: z.string().optional(),
    before: z.string().optional(),
    run: z.uuid().optional(),
    view: z.enum(['log', 'runs', 'review', 'skills']).optional(),
    rstatus: z.enum(['running', 'completed', 'failed', 'interrupted']).optional(),
    ragent: z.enum(AGENT_KEYS).optional(),
  }),
  loaderDeps: ({ search }) => ({ q: search.q, actor: search.actor, before: search.before, run: search.run, view: search.view, rstatus: search.rstatus, ragent: search.ragent }),
  // Each view loads only what it shows (#170). Usage and directives belong to the Memory view.
  // Log search and paging run on the server over the whole log.
  loader: async ({ deps }) => {
    const base = {
      rows: [] as Awaited<ReturnType<typeof fetchActivity>>['rows'],
      hasMore: false,
      actors: [] as Awaited<ReturnType<typeof fetchActivity>>['actors'],
      desk: null as Awaited<ReturnType<typeof fetchAgentDesk>> | null,
      runs: null as Awaited<ReturnType<typeof fetchRuns>> | null,
      run: null as Awaited<ReturnType<typeof fetchRunDetail>> | null,
      queue: null as Awaited<ReturnType<typeof fetchReviewQueue>> | null,
      skills: null as Awaited<ReturnType<typeof fetchSkills>> | null,
    }
    if (deps.view === 'runs') {
      const [runs, run] = await Promise.all([fetchRuns({ data: { status: deps.rstatus, agentKey: deps.ragent } }), deps.run ? fetchRunDetail({ data: { runId: deps.run } }) : Promise.resolve(null)])
      return { ...base, runs, run }
    }
    if (deps.view === 'review') return { ...base, queue: await fetchReviewQueue() }
    if (deps.view === 'skills') return { ...base, skills: await fetchSkills() }
    if (deps.view !== 'log') return { ...base, desk: await fetchAgentDesk() }
    const q = deps.q?.trim().toLowerCase()
    const actions = q ? Object.entries(ACTION_WORDS).filter(([, label]) => label.toLowerCase().includes(q)).map(([key]) => key) : undefined
    const activity = await fetchActivity({ data: { q: deps.q || undefined, actor: deps.actor || undefined, before: deps.before || undefined, actions } })
    return { ...base, rows: activity.rows, hasMore: activity.hasMore, actors: activity.actors }
  },
  pendingComponent: () => <SkeletonPage rows={4} />,
  errorComponent: ({ error }) => (
    <Notice tone="error" title="Agent activity did not load">
      {plainMessage(error)} Refresh the page to try again.
    </Notice>
  ),
  head: () => ({ meta: [{ title: pageTitle('Agents') }] }),
  component: Agents,
})

const VIEWS = [
  { key: undefined, label: 'Memory' },
  { key: 'review', label: 'Review' },
  { key: 'runs', label: 'Runs' },
  { key: 'log', label: 'Log' },
  { key: 'skills', label: 'Skills' },
] as const

const INTRO: Record<string, string> = {
  memory: 'What each agent remembers, today\'s usage, and the directives every agent follows.',
  review: 'Notes held out of agent prompts until a second person promotes them.',
  runs: 'Every agent run: who ran, which model, how long, how many tokens, and each step.',
  log: 'Every agent step for this organisation. Secrets are removed before logging.',
  skills: 'Reviewed runbooks the agents work under. Changing one needs a code review.',
}

function Agents() {
  const data = Route.useLoaderData()
  const { session } = Route.useRouteContext()
  const sp = Route.useSearch()
  const navigate = Route.useNavigate()
  const set = (patch: Partial<typeof sp>) => navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true })
  const agent: AgentKey | null = isAgentKey(sp.agent) ? sp.agent : null
  const view = sp.view ?? 'memory'

  return (
    <>
      <PageHead
        title="Agents"
        intro={INTRO[view]}
        actions={
          <Link to="/app/chat" className="cw-btn">
            Ask an agent
          </Link>
        }
      />
      <nav className="cw-tabs" aria-label="Agent views">
        {VIEWS.map((v) => {
          const count = v.key === 'review' ? session.memoryToReview : v.key === 'runs' ? session.runningRuns : 0
          return (
            <Link key={v.label} to="/app/agents" search={{ view: v.key, agent: sp.agent }} activeOptions={{ includeSearch: true, explicitUndefined: true }} replace>
              {v.label}
              {count > 0 && (
                <span className="cw-badge" data-tone={v.key === 'runs' ? 'info' : 'warn'}>
                  {count}
                  <span className="cw-sr-only">{v.key === 'runs' ? ' running' : ' to review'}</span>
                </span>
              )}
            </Link>
          )
        })}
      </nav>

      {view === 'memory' && data.desk && (
        <>
          <BudgetMeter budget={data.desk.budget} isOwner={data.desk.isOwner} />
          <section aria-labelledby="team-title">
            <h2 id="team-title" className="cw-h2-compact">
              Team
            </h2>
            <ul className="cw-agentlist">
              {AGENT_KEYS.map((k) => (
                <li key={k}>
                  <button type="button" className="cw-agentbtn" aria-pressed={agent === k} onClick={() => set({ agent: agent === k ? undefined : k })}>
                    <strong>{AGENT_LABELS[k].name}</strong>
                    <span className="cw-muted">{AGENT_LABELS[k].role}</span>
                    <span className="cw-agentbtn-cta">{agent === k ? 'Hide notes' : 'Show notes'}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
          {agent ? <Memory key={agent} agent={agent} /> : <EmptyState title="Pick an agent to see its notes" body="Each agent keeps short notes it reads before every reply. Pick one above to read, add or replace them." />}
          <Directives directives={data.desk.directives} />
        </>
      )}
      {view === 'review' && data.queue && <ReviewQueue queue={data.queue} />}
      {view === 'runs' && data.runs && <RunsView key={`${sp.rstatus ?? ''}|${sp.ragent ?? ''}`} runs={data.runs.runs} hasMore={data.runs.hasMore} rateSet={data.runs.pricing} detail={data.run} />}
      {view === 'skills' && data.skills && <SkillsView skills={data.skills} />}
      {view === 'log' && <DecisionLog rows={data.rows} hasMore={data.hasMore} actors={data.actors} />}
    </>
  )
}
