import { and, asc, eq, inArray } from 'drizzle-orm'
import { getDb } from '../db/client'
import { responseProposals, user, watchHits } from '../db/schema'
import { redactString, redactValue, truncate } from '../lib/redact'
import { writeAudit } from '../audit'
import { getHunt } from './hunts'
import { listSchedules } from './schedules'

/** Bounds for a report so a huge hunt cannot produce an unbounded download (#94). */
export const REPORT_MAX_CHARS = 200_000
const SAMPLE_ROWS = 5
const SAMPLE_COLS = 8
/** Scheduled runs that get a sample: only the most recent few, within their own share of the report. */
export const SCHEDULED_SAMPLE_RUNS = 5
export const SCHEDULED_SAMPLE_BUDGET = Math.floor(REPORT_MAX_CHARS * 0.3)

const md = (s: unknown) => redactString(String(s ?? '')).replace(/\r?\n/g, ' ').replace(/\|/g, '\\|')
const fence = (s: string) => {
  const body = redactString(s)
  const longest = Math.max(0, ...(body.match(/`+/g) ?? []).map((r) => r.length))
  const ticks = '`'.repeat(Math.max(3, longest + 1))
  return `${ticks}kql\n${body}\n${ticks}`
}
/** Escape Markdown/HTML in free text so titles from feeds or agents cannot inject links or markup. */
const mdText = (s: unknown) =>
  redactString(String(s ?? ''))
    .replace(/\r?\n/g, ' ')
    .replace(/([\\`*_[\]#!|])/g, '\\$1')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString().replace('.000Z', 'Z') : '')

function sampleTable(columns: string[], rows: Array<Record<string, unknown>>) {
  const cols = columns.slice(0, SAMPLE_COLS)
  if (!cols.length || !rows.length) return ''
  const safe = rows.slice(0, SAMPLE_ROWS).map((r) => redactValue(r) as Record<string, unknown>)
  return [
    `| ${cols.map(md).join(' | ')} |`,
    `| ${cols.map(() => '---').join(' | ')} |`,
    ...safe.map((r) => `| ${cols.map((c) => truncate(md(typeof r[c] === 'object' ? JSON.stringify(r[c]) : r[c]), 80)).join(' | ')} |`),
  ].join('\n')
}

type StoredSummary = { mode?: string; rowCount?: number; truncated?: boolean; columns?: string[]; sample?: Array<Record<string, unknown>>; sampleExpired?: boolean; sampleRetentionDays?: number }

/** Sample lines for one stored result (a query run or a repeat-search run). Empty when there is nothing to show. */
function sampleBlock(r: StoredSummary): string[] {
  if (r.sampleExpired) return [`_Sample removed${r.sampleRetentionDays ? ` after ${r.sampleRetentionDays} days` : ''} (retention); the row count is kept._`, '']
  const t = sampleTable(r.columns ?? [], r.sample ?? [])
  return t ? [`Sample (first ${SAMPLE_ROWS} rows, ${SAMPLE_COLS} columns, redacted):`, '', t, ''] : []
}

/**
 * Markdown hunt report (#94): title, hypothesis, origin, every query that ran (exact KQL, approver,
 * time, row count, columns), a small redacted sample, schedules, and linked response proposals.
 * Org-scoped: callers pass the session org; nothing from another org can appear.
 */
export async function huntReportMarkdown(orgId: string, huntId: string, exportedBy: string): Promise<{ filename: string; markdown: string } | null> {
  const h = await getHunt(orgId, huntId)
  if (!h) return null
  const db = getDb()
  const { hunt, evidence, proposals } = h
  const [origin] = hunt.watchHitId ? await db.select().from(watchHits).where(and(eq(watchHits.orgId, orgId), eq(watchHits.id, hunt.watchHitId))).limit(1) : []
  const responses = await db.select().from(responseProposals).where(and(eq(responseProposals.orgId, orgId), eq(responseProposals.huntId, huntId))).orderBy(asc(responseProposals.createdAt))
  const schedules = await listSchedules(orgId, huntId)

  const userIds = [...new Set([...proposals.map((p) => p.decidedBy), ...schedules.map((s) => s.approvedBy), ...responses.map((r) => r.decidedBy)].filter((x): x is string => Boolean(x)))]
  const people = userIds.length ? await db.select({ id: user.id, name: user.name, email: user.email }).from(user).where(inArray(user.id, userIds)) : []
  const who = (id: string | null | undefined) => {
    if (!id) return ''
    const p = people.find((x) => x.id === id)
    return p ? `${md(p.name)} <${md(p.email)}>` : md(id)
  }

  const out: string[] = []
  out.push(`# Hunt report: ${mdText(hunt.title)}`, '')
  out.push(`- **Status:** ${hunt.status}`, `- **Created:** ${iso(hunt.createdAt)}`, `- **Last updated:** ${iso(hunt.updatedAt)}`, `- **Exported:** ${iso(new Date())}`)
  if (origin) out.push(`- **Origin watch hit:** ${mdText(origin.title)} (${mdText(origin.source)}${origin.url ? `, <${md(origin.url).replace(/[<>\s]/g, '')}>` : ''})`)
  out.push('')
  if (hunt.hypothesis) out.push('## Hypothesis', '', mdText(hunt.hypothesis), '')

  const ran = proposals.filter((p) => p.status === 'run').reverse()
  out.push('## Queries that ran', '')
  if (!ran.length) out.push('_No query has run on this hunt._', '')
  for (const p of ran) {
    const r = (p.resultSummary ?? {}) as StoredSummary
    out.push(`### ${p.target === 'defender' ? 'Defender XDR' : 'Sentinel'} · ${iso(p.ranAt)}`, '')
    out.push(`- **Approved by:** ${who(p.decidedBy)} at ${iso(p.decidedAt)}`, `- **Proposed by:** ${p.proposedByType} ${md(p.proposedById)}${p.kql !== p.originalKql ? ' (edited before running)' : ''}`)
    out.push(`- **Result:** ${r.rowCount ?? 0} rows${r.truncated ? ' (truncated to cap)' : ''}${r.mode === 'demo' ? ' · demo data' : ''}`, `- **Columns:** ${(r.columns ?? []).map(md).join(', ')}`, '')
    out.push(fence(p.kql), '')
    out.push(...sampleBlock(r))
  }

  const other = proposals.filter((p) => p.status !== 'run')
  if (other.length) {
    out.push('## Other proposed queries', '')
    for (const p of other) out.push(`- ${p.status} · ${p.target} · proposed by ${p.proposedByType} ${md(p.proposedById)} · ${iso(p.createdAt)}${p.error ? ` · error: ${md(truncate(p.error, 200))}` : ''}`)
    out.push('')
  }

  if (schedules.length) {
    out.push('## Scheduled runs', '')
    for (const s of schedules) {
      out.push(`- ${s.enabled ? 'enabled' : `disabled (${md(s.disabledReason)})`} · ${s.target} every ${s.intervalMinutes} min · approved by ${who(s.approvedBy)} until ${iso(s.approvalExpiresAt)} · ${s.lastRunAt ? `last ${s.lastStatus} ${iso(s.lastRunAt)}${s.lastRowCount !== null ? ` · ${s.lastRowCount} rows` : ''}` : `not run yet${s.lastRowCount !== null ? ` · baseline ${s.lastRowCount} rows` : ''}`}`)
    }
    const runs = evidence.filter((e) => e.type === 'scheduled_result' || e.type === 'scheduled_failed').slice(-20)
    if (runs.length) {
      out.push('', 'Recent scheduled results:', '')
      // Issue #99: each run's own sample, indented under its bullet, same redaction and bounds. Only
      // the most recent SCHEDULED_SAMPLE_RUNS results get one, within SCHEDULED_SAMPLE_BUDGET
      // characters, so samples cannot crowd out the response proposals and timeline below.
      const withSample = new Set(runs.filter((e) => e.type === 'scheduled_result').slice(-SCHEDULED_SAMPLE_RUNS).map((e) => e.id))
      let budget = SCHEDULED_SAMPLE_BUDGET
      let countsOnly = 0
      for (const e of runs) {
        const pl = e.payload as StoredSummary & { error?: string }
        out.push(`- ${iso(e.createdAt)} · ${e.type === 'scheduled_result' ? `${pl.rowCount ?? 0} rows${pl.mode === 'demo' ? ' · demo data' : ''}` : `failed: ${md(truncate(pl.error ?? '', 200))}`}`)
        if (e.type !== 'scheduled_result') continue
        const block = sampleBlock(pl).map((l) => (l ? `  ${l}` : l))
        if (!block.length) continue
        const size = block.reduce((n, l) => n + l.length + 1, 0)
        if (withSample.has(e.id) && size <= budget) {
          out.push(...block)
          budget -= size
        } else countsOnly++
      }
      if (countsOnly) out.push('', `_Samples are shown for the ${SCHEDULED_SAMPLE_RUNS} most recent runs at most, within a size limit; ${countsOnly} run${countsOnly === 1 ? ' is' : 's are'} listed with row counts only._`)
    }
    out.push('')
  }

  out.push('## Response proposals', '')
  if (!responses.length) out.push('_No response was proposed from this hunt._', '')
  for (const r of responses) {
    const exec = r.execution as { status?: string; mode?: string } | null
    out.push(
      `- **${mdText(r.title)}** · ${r.actionType} · ${r.status}${r.rollbackOfId ? ` · rollback of ${md(r.rollbackOfId)}` : ''}${r.decidedBy ? ` · decided by ${who(r.decidedBy)} at ${iso(r.decidedAt)}` : ''}${exec?.mode === 'live' ? ` · execution ${exec.status}` : ''}`,
      `  - Blast radius: ${mdText(r.blastRadius.summary)}`,
    )
  }
  out.push('')

  out.push('## Evidence timeline', '')
  for (const e of evidence.slice(-200)) {
    const pl = e.payload as { note?: string; rowCount?: number }
    const detail = typeof pl.note === 'string' ? `: ${mdText(truncate(pl.note, 300))}` : typeof pl.rowCount === 'number' ? `: ${pl.rowCount} rows` : ''
    out.push(`- ${iso(e.createdAt)} · ${e.type} · ${e.actorType}${e.actorId ? ` ${md(e.actorId)}` : ''}${detail}`)
  }
  out.push('', '---', '_Generated by Crosswire. Samples are bounded and redacted; full results stay in Defender/Sentinel._', '')

  // Truncate on whole lines and close any open code fence, so the tail never swallows the rest.
  let markdown = ''
  let openFence: string | null = null
  let truncated = false
  for (const line of out) {
    if (markdown.length + line.length + 1 > REPORT_MAX_CHARS) {
      truncated = true
      break
    }
    markdown += `${line}\n`
    const m = /^(`{3,})/.exec(line)
    if (m) openFence = openFence && m[1]!.length >= openFence.length ? null : (openFence ?? m[1]!)
  }
  if (truncated) markdown += `${openFence ? `${openFence}\n` : ''}\n_[report truncated at ${REPORT_MAX_CHARS} characters]_\n`
  await writeAudit({ category: 'hunt', action: 'hunt_report_exported', actorType: 'user', actorId: exportedBy, orgId, targetType: 'hunt', targetId: huntId, data: { chars: markdown.length } })
  const slug = hunt.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'hunt'
  return { filename: `crosswire-hunt-${slug}-${huntId.slice(0, 8)}.md`, markdown }
}
