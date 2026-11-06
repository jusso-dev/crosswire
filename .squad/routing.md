# Routing

| Request looks like | Route to |
| --- | --- |
| "Is CVE-X / vendor Y relevant to us?", watch hits, feeds, compare sources | Intel |
| KQL, Advanced Hunting, Sentinel incidents, "look for X in our tenant" | Hunter |
| "Contain / isolate / disable / run playbook" | Responder (creates a proposal only) |
| "Remember that…", summarise a hunt, feedback | Scribe |
| Anything broad, multi-step, or unclear | Lead |

## Fan-out

When the analyst picks **Lead (orchestrate squad)**, Lead plans the work and calls the
specialists in sequence (Intel, then Hunter, then Responder if needed), then signs off a
combined answer. Each specialist call is logged as a decision. True parallel fan-out is a
later enhancement.

## Talk to one specialist

Picking a specific agent sends the turn straight to that agent with its charter and tools.
