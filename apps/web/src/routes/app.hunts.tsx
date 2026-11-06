import { Link, Outlet, createFileRoute, useMatchRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { z } from 'zod'
import { createHuntFn, fetchHunts } from '../fns/hunts'
import { fmtTime, statusTone } from '../components/format'

export const Route = createFileRoute('/app/hunts')({
  validateSearch: z.object({ fromHit: z.string().optional(), title: z.string().optional() }),
  loader: () => fetchHunts(),
  component: Hunts,
})

function Hunts() {
  const hunts = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = useNavigate()
  const matchRoute = useMatchRoute()
  const [title, setTitle] = useState(search.title ?? '')
  const [hypothesis, setHypothesis] = useState('')
  if (matchRoute({ to: '/app/hunts/$huntId', fuzzy: true })) return <Outlet />
  return (
    <>
      <h1>Hunts</h1>
      <form
        className="cw-form"
        onSubmit={async (e) => {
          e.preventDefault()
          const h = await createHuntFn({ data: { title, hypothesis, watchHitId: search.fromHit } })
          await navigate({ to: '/app/hunts/$huntId', params: { huntId: h.id } })
        }}
      >
        <label>
          Title
          <input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} />
        </label>
        <label>
          Hypothesis
          <textarea value={hypothesis} onChange={(e) => setHypothesis(e.target.value)} rows={3} />
        </label>
        <div>
          <button className="cw-btn" type="submit">
            Start hunt
          </button>
        </div>
      </form>
      <h2>Cases</h2>
      {hunts.length === 0 ? (
        <p className="cw-empty">No hunt cases yet.</p>
      ) : (
        <table className="cw-table">
          <thead>
            <tr>
              <th>Title</th>
              <th>Status</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {hunts.map((h) => (
              <tr key={h.id}>
                <td>
                  <Link to="/app/hunts/$huntId" params={{ huntId: h.id }}>
                    {h.title}
                  </Link>
                </td>
                <td>
                  <span className="cw-badge" data-tone={statusTone(h.status)}>
                    {h.status}
                  </span>
                </td>
                <td>{fmtTime(h.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  )
}
