# Routing

Generated view of `ROUTING_RULES` in `apps/web/src/server/agents/policy.ts`. The server does not parse this file. The analyst's agent selection chooses who answers. `defineRouting` validates this map; it does not steer a live turn by itself.

| Request looks like | Route to | Pattern checked by defineRouting |
| --- | --- | --- |
| CVE, watch hits, feeds, and source comparison go to Intel. | intel | `cve|watch|vendor|intel` |
| KQL, Advanced Hunting, and Sentinel incidents go to Hunter. | hunter | `kql|hunting|sentinel` |
| Containment asks Responder for a proposal only. | responder | `contain|isolate|disable|playbook` |
| Notes, summaries, and feedback go to Scribe. | scribe | `remember|summarise|feedback` |
| Anything broad, multi-step, or unclear | Lead | default agent |

## Fan-out

When the analyst picks **Lead (orchestrate squad)**, Lead plans the work and calls the specialists, then signs off a combined answer. Independent questions go out together with `delegate_parallel` (up to 4 distinct specialists, run concurrently; one failure does not drop the others). Dependent steps use `delegate` in sequence. Each specialist call is a child run.

## Talk to one specialist

Picking a specific agent sends the turn straight to that agent with its charter and tools.
