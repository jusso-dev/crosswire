# MSSP features backlog (Later, issue #67)

Status: **later, not v1.** Split items into issues only when someone starts the work.

## Features

- [ ] Hierarchical orgs: a parent MSSP org with child customer orgs.
- [ ] Cross-customer dashboard: hunts, watch hits and pending approvals across child orgs.
- [ ] Analyst pooling: MSSP analysts with scoped roles in many customer orgs.
- [ ] Per-customer connectors (already per org) with customer-owned consent.
- [ ] Cross-customer watchlists pushed from the parent org.
- [ ] White-label branding per MSSP.
- [ ] Per-customer approval policies (who approves response for each customer).

## Data-model implications

- `orgs.parent_org_id` (nullable) plus a closure table for queries across a hierarchy.
- Membership roles scoped per org stay as they are; add "inherited" roles from the parent.
- Every query that spans orgs must take an explicit list of org ids the caller is allowed to see,
  never "all children" implicitly.

## Isolation risks

- **Querying the wrong tenant** is the critical risk: hunting connectors are per org and the token
  broker keys by org id. Any cross-customer view must never run KQL; it may only read stored
  summaries.
- Approvals: an MSSP approver must not approve for a customer that has not delegated that right.
- Agent memory must stay per customer org; no cross-customer memory sharing by default.
