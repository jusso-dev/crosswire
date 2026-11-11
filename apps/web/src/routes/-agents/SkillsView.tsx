import type { fetchSkills } from '../../fns/agents'
import { agentLabel } from '../../components/runs'

type Skills = Awaited<ReturnType<typeof fetchSkills>>

/** Reviewed runbooks the agents work under. Read only. */
export function SkillsView({ skills }: { skills: Skills }) {
  return (
    <section aria-labelledby="skills-title">
      <h2 id="skills-title" className="cw-h2-compact">
        Reviewed skills
      </h2>
      <p className="cw-muted cw-measure">Each specialist works under one reviewed skill. A skill lists the only tools that agent may use and the evidence it must cite. Lead has none of its own: it plans and asks the specialists.</p>
      <div className="cw-skillgrid">
        {skills.map((s) => (
          <article key={s.name} className="cw-card cw-skill" aria-labelledby={`skill-${s.name}`}>
            <header>
              <h3 id={`skill-${s.name}`} className="mono">
                {s.name}
              </h3>
              <span className="cw-badge">v{s.version}</span>
            </header>
            <p>{s.description}</p>
            <dl className="cw-provenance">
              <dt>Agent</dt>
              <dd>{agentLabel(s.agent)}</dd>
              <dt>Allowed tools</dt>
              <dd>
                <ul className="cw-chips" aria-label={`Tools ${s.name} may use`}>
                  {s.tools.map((t) => (
                    <li key={t} className="cw-chip mono">
                      {t}
                    </li>
                  ))}
                </ul>
              </dd>
            </dl>
            <details>
              <summary>When each tool is used, and the evidence rule</summary>
              <ul className="cw-plainlist">
                {s.steps.map((step) => (
                  <li key={step.name}>
                    <span className="mono">{step.name}</span>: {step.when ?? 'no condition recorded'}
                  </li>
                ))}
              </ul>
              <pre>{s.content}</pre>
            </details>
          </article>
        ))}
      </div>
    </section>
  )
}
