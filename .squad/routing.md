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
specialists, then signs off a combined answer. Independent questions go out together with
`delegate_parallel` (up to 4 distinct specialists, run concurrently; one failure does not drop
the others). Dependent steps (Intel, then Hunter using Intel's answer) use `delegate` in
sequence. Each specialist call is logged as a decision.

## Talk to one specialist

Picking a specific agent sends the turn straight to that agent with its charter and tools.
