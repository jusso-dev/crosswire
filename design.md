# Design: Crosswire analyst workspace

Locked design system for the Crosswire app. Read this before changing UI. Token values live in
`apps/web/src/styles/tokens.css`; shared primitives in `apps/web/src/components/`.

## 1. What Crosswire is (and is not)

Users: SOC analysts (investigate, propose), approvers and owners (decide, configure).

Implemented workflows:

1. **Watch** vendors, keywords, CVEs and tags. A worker matches them hourly against pwn.watch and CISA KEV.
2. **Hunt**: a case file opened from a watch hit or by hand. Holds a hypothesis, KQL searches, results and notes.
3. **Search**: an agent or analyst proposes KQL for Defender Advanced Hunting or Sentinel. A person reviews,
   edits and approves before it runs. The server stores the exact query, a row count and a sample of up to 20 rows.
4. **Respond**: proposed actions (isolate device, playbook) are dry-run and decided by an approver who is not the requester.
5. **Compare** one CVE or indicator across intel sources.

Not in Crosswire (do not design for it): alert queues, detection rules, entity graphs, risk scores,
ATT&CK mappings, case assignment, full result sets. Results are a stored sample, not a live grid over
the tenant.

## 2. Reference patterns: what we took

Research covered official public docs for Microsoft Sentinel and Defender XDR, Elastic and Kibana,
Splunk ES, Google SecOps, Cortex XSOAR, Recorded Future, VirusTotal, ThreatConnect, OpenCTI, MISP,
Graphistry, Maltego and Vectra. CrowdStrike, SentinelOne, Wiz and Darktrace docs were login-walled or
rate-limited and were not inspected. Evidence is docs text; no vendor visuals were copied.

| Pattern (sources) | Decision | Where in Crosswire |
| --- | --- | --- |
| Row opens a side inspector with structured fields and raw view (Defender Inspect record, Elastic flyout Overview/Table/JSON, SecOps Event Viewer, ThreatConnect drawer) | **Adopt** | Result row → inspector with Fields and JSON tabs, query + provenance, next/previous row |
| Pivot from a value: show only / filter out / copy (Defender `==`/`!=`, SecOps Show only/Filter out, Kibana filters) | **Adapt** | Field actions filter the stored sample client-side, shown as removable chips. Plus "Add to search" which drafts `\| where` into a new proposal, never runs it |
| Time histogram above results (Defender, SecOps) | **Reject for now** | Samples are 20 rows; a histogram over a sample would mislead. Revisit if full results are stored |
| Saved / shared queries, history (Defender, SecOps) | **Reject** | No backend. Re-proposing from a past query is supported instead |
| Separate state axes, never one merged badge (Sentinel hypothesis vs status, Defender verdict vs remediation, ThreatConnect threat vs confidence, OpenCTI reliability vs confidence, MISP analysis vs threat level) | **Adopt** | Severity (glyph), workflow status (outlined tag), freshness (clock + age), data mode (Demo/Live tag) are four distinct primitives |
| Hunt with tabs for queries, bookmarks, entities (Sentinel Hunts) | **Adapt** | Hunt workspace: searches list, result grid, entities derived from the sample, evidence timeline |
| Evidence keeps its source query and time (Sentinel bookmarks "View source query", XSOAR Mark as Evidence) | **Adopt** | Every result and timeline entry links to the exact query that produced it, who approved it and when |
| Unified activity timeline, filterable by type and actor (Defender Activities, XSOAR War Room, Splunk notes filter) | **Adopt** | Hunt timeline with type filter chips (All, Searches, Results, Notes, Schedules) |
| Human-in-the-loop with identity and reason (Defender Action center Pending/History, XSOAR assignee-only, MISP Publish confirmation) | **Keep and surface** | Already enforced server-side. UI shows who proposed, who approved, and why a button is unavailable |
| Entity page with first/last seen and source (Sentinel/Defender entity pages, SecOps, Recorded Future card) | **Adapt (light)** | Entities panel lists devices, accounts and URLs found in the sample with counts and first/last seen *within the sample*. No profile pages or enrichment we do not have |
| Per-source provenance with labelled dates (VirusTotal "last report date ≠ contact date", OpenCTI date labels, ThreatConnect Owners & Feeds) | **Adopt** | Compare and control panel label every date by meaning (feed updated, KEV added, patch due, fetched) |
| Graph-to-table (Maltego List View, Graphistry inspector, VT Graph CSV) | **Reject** | No relationship data. A graph would be decoration |
| Generated query reviewed before run (SecOps Generate Query, Defender Run disabled until valid) | **Already core** | Agent proposes, human approves. The editor shows edits against the original |
| Previous/next in the detail pane (Defender incident pane) | **Adopt** | `j`/`k` and ↑/↓ move through rows; Esc closes the inspector |
| Multiple query tabs, schema tree, IntelliSense (Defender) | **Reject** | Large scope, small gain for a review-first workflow |

## 3. Design language

**Instrument, not poster.** A calm workspace for long sessions: dense tables, quiet chrome, one accent.

- **Typography**: Inter for UI (14 px body, 13 px tables, 12 px meta). JetBrains Mono only for KQL,
  identifiers, field values and raw records. Space Grotesk only in the wordmark.
- **Surfaces**: `--bg` page, `--surface-1` panels, `--surface-2` headers and hover, `--surface-3` chips,
  `--surface-selected` for selected rows. Hairline borders do the separating; no shadows except overlays.
- **Accent**: one blue, for links, focus, primary action and the selected-row edge. Not for decoration.
- **Themes**: light and dark from the same semantic tokens. The theme follows the OS by default; the
  header toggle cycles System, Light, Dark and remembers the choice.
- **Meaning is never colour alone.**
  - Severity: shape + word. ◆ critical, ▲ high, ● medium, ○ low, dashed square "unknown".
  - Workflow status: outlined uppercase tag (PROPOSED, RUN, FAILED…).
  - Freshness: clock glyph + relative age; stale is written out ("stale · 5 h ago").
  - Data mode: DEMO or LIVE tag on every result. Demo data is labelled at the result, not only in a banner.
  - Unknown is not safe: missing severity shows "Unknown", missing values show "empty" in muted text,
    never a blank or a zero.
- **Motif**: the crossed-wires mark and the line-check wires show feed status. Used for status only.

## 4. Layout

- App shell: left rail grouped by job (Overview, Watch, Investigate, Act, Admin); sticky header with org,
  role, theme toggle and sign-out.
- Pages open with breadcrumbs, a compact title, one plain sentence of purpose and actions on the right.
- **Hunt workspace** (the reference slice): context bar (status, origin, created, data mode) → searches
  list → selected search with query, provenance, result grid → inspector on row select. A right rail
  holds the evidence timeline and entities. URL holds `?q=<search>&row=<n>&f=<filters>&tl=<type>` so
  reload, back and links restore the exact view.
- Narrow widths: the rail stacks under the main column; the inspector becomes a full-height sheet.

## 5. Words

Plain Australian English, verb-first buttons naming the outcome. Explain jargon with `<Term>`.
"Search" for a KQL proposal, "action" for a response proposal, "safe mode" for dry-run.
No em dashes. Times in `APP_TIMEZONE` (default Australia/Sydney); stored UTC.

## 6. Interaction rules

- Every permission-sensitive control is also enforced on the server. The UI explains why a control is
  unavailable ("Approvers can schedule searches") instead of silently hiding it where that helps.
- Focus is visible (2 px), never animated. Inspector traps nothing; Esc closes and returns focus to the row.
- Motion: colour only, 120–180 ms; reduced motion removes it.
- Tables: sticky headers, sortable where the data is local, row numbers, truncation with a "wrap" toggle
  and full value in the inspector.

## 7. Agent and approval controls the UI sits on

Verified in the server and in Vitest on 08-11-2026 (`apps/web/test/squad-sdk-runtime.test.ts`, `apps/web/test/squad-sdk-governance.test.ts`, `apps/web/test/squad-sdk-races.test.ts`, `apps/web/test/squad-sdk-client-boundary.test.ts`, and the rest of the web suite). With `PG_TEST_URL` unset: 25 files, 24 passed and 1 skipped; 234 tests, 229 passed and 5 skipped. The skipped file is `pg-real.test.ts`. That file then passed 5 tests on a disposable Postgres 17 container at `127.0.0.1:55432` (trust auth, database `crosswire_test`, Docker context `orbstack`, not the app database on port 5432). The container was removed after that run. `tsc --noEmit` passed. Playwright was not run: nothing was listening on `127.0.0.1:3000`, and the app was not started from `.env`. The Agents run-replay control was not clicked in a browser. The screen does not enforce these.

- Agents propose. `EXECUTION_TOOL_NAMES` stays empty. A different person approves. Live execution stays off unless dry-run is explicitly false and that executor is on.
- Each new proposal stores a sha256 of the canonical title, action, targets, blast radius and payload (schema version 1). Execution compares that hash before the atomic claim. A missing hash, a changed payload, or an expired window is refused and does not start execution. `APPROVAL_BINDING=legacy` skips the hash check. The default is `enforced`.
- Text sent to the model excludes quarantined memory, tombstones and injection text. Operator safety sentences stay. Chat, import, remember, tool output, feedback and scribe notes are quarantined until a different person promotes them. Injection text cannot be promoted. Squad `classify()` does not stop a generic "ignore previous instructions" note.
- Chat uses Azure OpenAI or an OpenAI-compatible endpoint. A GitHub Copilot seat is not required. `@bradygaster/squad-sdk@1.1.0` validates the cast and classifies memory. It does not run the SOC turn and it does not construct `SquadClient`. Preview `2.0.0-preview.3` and `HarnessAdapter` are not used. Stable 1.1.0 does not export `UsageLedger` or `ContextUtilizationTracker`. Production does not load those files by URL. Observed tokens stay in Postgres. Context refusal is local, at 0.8 of the configured window, the same default the unexported tracker documents. `CostTracker` records a dollar amount only when `BUDGET_USD_PER_MILLION_TOKENS` is set, and each organisation has its own tracker. Production imports of the four supported subpaths do not resolve to `@github/copilot-sdk`, `./client`, `./backend`, `usage-ledger.js`, or `context-utilization.js`. The client-boundary test is not imported from `src/`.
- An unset rate stores `estimated_cost_micros` as null. The configuration diagnostic says unpriced. Crosswire does not store 0 for an unknown price. A spend cap with no rate refuses the call before the model is contacted. A spend cap also refuses when today's observed usage includes an unpriced row. When the rate is set, a call that would pass the cap is refused with the daily spend message. A finished model call with no integer token counts inserts an observed row with null tokens and null micros. The next check refuses, even when no spend cap is set, until the next UTC day. A refusal before the call does not write that row. A direct ledger write of explicit zeroes is a real count: the token columns stay 0, cost is 0 when a rate is set, and cost stays null when it is not. A finished turn that reports 0 input and 0 output and already has assistant text is stored with null tokens and null micros, and the next check refuses, with or without a spend cap. When a run row exists, the turn claims its input estimate under a per-org lock before the model call. Parallel estimates that together exceed the remaining daily budget admit only what still fits. The reservation is replaced when usage is stored. One observed row is kept per run. A later cumulative report updates that row, and `CostTracker` records only the positive delta. A cost or token count that does not fit in a Postgres integer is not inserted as a priced row: the cost becomes null micros, and token counts that do not fit become the unmeasured marker when a run id is known.
- Token, context, output and shared inflight budgets can refuse a model call. `acquireRunSlot` marks `slot_held` on the run after the slot is taken. `releaseOnce(orgId, runId)` claims `slot_released` and decrements once, including from another process. The parent stream wrapper and the chat handler share that closure. A specialist has its own. The handler abort listener, and a request that is already aborted when `run()` returns, call the same release. `withTimeout` adds `Agent timed out after Ns.` only when the abort reason is the timer message `agent timeout`. A client abort is not labelled a timeout. The process that owns the model call polls `cancel_requested_at` every 500 ms. When another caller has set it, this process aborts the live call with reason `cancelled`. That abort is not a timeout. The parent stream and each specialist poll their own row. A specialist shares the turn's abort controller, so cancelling the child also stops the parent stream. A failed poll retries and does not abort a healthy turn. There is no poll when the run row was not opened. The specialist non-streaming `chat()` is raced with the abort signal. If that specialist cannot take a slot, its row is finished as `failed` and no extra slot is taken. The worker, and the start of the next turn, mark a timed-out or cancelled running row interrupted and return the slot only when that row held one and has not already released it. Reconcile does not set inflight from the count of rows still running, and it does not rewrite another org. A row that is both stale and cancelled is interrupted once. `RUN_LEDGER=legacy` has no run row, so that release is in memory only and a crash can leave the slot taken. If the web process and the worker are both down, running rows stay running. `server.mjs` and `start.ts` do not reconcile.
- The decision log stores the first 1000 characters of redacted text. Text of exactly 1000 characters has no marker. Longer text keeps those 1000 characters and appends `… [truncated N chars]`, where N is the number of characters not kept. The marker says "chars" even when N is 1. The Agents decision log table and its tooltip show that summary. They do not show the replay. The full assistant text and tool output stay on `agent_run_outputs`, with secrets redacted and the rest of the payload kept. Sample arrays stay until sample retention empties them, sets `sampleExpired`, and recomputes the content hash. That cleared sample is also absent from the org bundle. An org member can open one run on the Agents page and read the full redacted output for that organisation. Another organisation cannot. A tool error longer than 1000 characters is stored redacted on the run, and the decision summary is the truncation of that redacted text. `RUN_LEDGER=legacy` is an explicit rollback and writes no replay row.
- A unit test can construct `SquadClient` disconnected, with an empty environment and logged-in-user mode off, without calling `connect()` or `createSession()`. That is not live customer-model compatibility. No provider key and no GitHub token were available for a live session, and those methods were not called.
