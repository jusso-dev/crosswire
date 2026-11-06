import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/app/chat/')({
  component: () => (
    <section className="cw-transcript">
      <h1>Chat</h1>
      <p className="cw-muted">
        Start a new thread and pick an agent: Lead, Hunter, Intel, Responder or Scribe. Without a model API key the agents answer in clearly labelled stub mode.
      </p>
    </section>
  ),
})
