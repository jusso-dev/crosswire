import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { eq } from 'drizzle-orm'
import { getDb } from '../src/server/db/client'
import { huntCases, kqlProposals, watchEntries, watchHits } from '../src/server/db/schema'
import { HuntingClient, setHuntingClient } from '../src/server/hunting/client'
import { approveAndRunKql, createHunt, proposeKql } from '../src/server/hunting/hunts'
import { huntReportMarkdown, mdText } from '../src/server/hunting/report'
import { team } from './helpers'

/** Render Markdown the way a reader would (GFM, as in GitHub, ticket systems and the app's own renderer). */
const html = (md: string) => renderToStaticMarkup(createElement(Markdown, { remarkPlugins: [remarkGfm] }, md))

const HOSTILE = [
  '[x](http://example.test)',
  '![x](http://example.test)',
  '<img src=x onerror=alert(1)>',
  '<a href="http://example.test">x</a>',
  'see http://example.test now',
  'www.example.test',
  'mail evil@example.test',
  '``code`` and `tick',
  'a | b | c',
  '**bold** _em_ ~~gone~~',
  '[ref]: http://example.test',
  '- list item',
  '1. numbered',
  '# heading',
  '> quote',
  'token=abcdefghijkl [REDACTED](http://example.test)',
  'Bearer abcdefghijklmnop',
]

describe('mdText escapes tenant and feed values (#132)', () => {
  it.each(HOSTILE)('%s renders as plain text, with no link, image or HTML', (value) => {
    const prose = html(`Value: ${mdText(value)}`)
    const cell = html(`| a | b |\n| --- | --- |\n| ${mdText(value)} | end |`)
    const start = html(mdText(value))
    for (const out of [prose, cell, start]) {
      expect(out).not.toMatch(/<a\b|<img\b|<strong|<em|<del|<h1|<blockquote|<ul|<ol/)
    }
    // A value in a table cell stays in one cell: the row still has exactly two cells.
    expect(cell.match(/<td>/g)).toHaveLength(2)
    expect(cell).toContain('<td>end</td>')
  })

  it('keeps the text readable', () => {
    expect(html(mdText('[x](http://example.test)'))).toContain('[x](')
    expect(html(mdText('a | b'))).toContain('a | b')
    expect(html(mdText('<img src=x>'))).toContain('&lt;img src=x&gt;')
    // Secrets are redacted first, and the marker reads as written.
    expect(mdText('Authorization: Bearer abcdefghijklmnop')).toBe('Authorization: Bearer [REDACTED]')
  })
})

describe('hunt report with hostile tenant and feed data (#131, #132)', () => {
  it('cannot produce a link, image or HTML element from a hit, a result row or a note; KQL stays exact in a fence', async () => {
    setHuntingClient(new HuntingClient())
    const t = await team()
    const db = getDb()
    const [entry] = await db.insert(watchEntries).values({ orgId: t.orgId, type: 'vendor', value: 'acme', normalized: 'acme' }).returning()
    const [hit] = await db
      .insert(watchHits)
      .values({ orgId: t.orgId, entryId: entry!.id, source: 'feed [x](http://example.test)', sourceId: '1', title: 'Hit ![x](http://example.test) <img src=x>', url: 'javascript:alert(1)' })
      .returning()
    const hunt = await createHunt(t.orgId, t.analyst, { title: 'Report [x](http://example.test)', hypothesis: '<img src=x> and www.example.test', watchHitId: hit!.id })
    const kql = 'DeviceInfo | where DeviceName has "```" | take 5'
    const p = await proposeKql(t.orgId, { type: 'user', id: t.analyst }, { huntId: hunt.id, target: 'defender', kql, rationale: 'Check: [click](http://example.test)' })
    await approveAndRunKql(t.orgId, t.approver, p.id)
    // Plant hostile values in the stored sample, as tenant logs could.
    await db
      .update(kqlProposals)
      .set({
        resultSummary: {
          mode: 'demo',
          rowCount: 1,
          columns: ['DeviceName', 'Cmd|Line'],
          sample: [{ DeviceName: '[x](http://example.test)', 'Cmd|Line': '![x](http://example.test) `a|b` <b>x</b>' }],
        },
      })
      .where(eq(kqlProposals.id, p.id))

    const md = (await huntReportMarkdown(t.orgId, hunt.id, t.analyst))!.markdown
    const out = html(md)
    expect(out).not.toMatch(/<a\b/)
    expect(out).not.toMatch(/<img\b/)
    expect(out).not.toContain('<b>x</b>')
    // A non-http feed URL is plain text, never a link target (#131).
    expect(md).not.toContain('<javascript:')
    expect(out).not.toContain('href="javascript:')
    // The KQL is exact, inside a fence longer than any backtick run it contains.
    expect(md).toContain(`\`\`\`\`kql\n${kql}\n\`\`\`\``)
    // The sample table keeps its two columns per row.
    const table = out.slice(out.indexOf('<table>', out.indexOf('Sample (first')))
    expect(table.slice(0, table.indexOf('</tr>', table.indexOf('<tbody>'))).match(/<td>/g)).toHaveLength(2)
    // Approver is named; a missing account is "a former member", never an id.
    expect(md).toMatch(/\*\*Approved by:\*\* User \d+/)
  })

  it('an http origin link stays a link', async () => {
    const t = await team()
    const db = getDb()
    const [entry] = await db.insert(watchEntries).values({ orgId: t.orgId, type: 'vendor', value: 'acme', normalized: 'acme' }).returning()
    const [hit] = await db.insert(watchHits).values({ orgId: t.orgId, entryId: entry!.id, source: 'feed', sourceId: '2', title: 'Plain hit', url: 'https://example.test/advisory?id=1' }).returning()
    const hunt = await createHunt(t.orgId, t.analyst, { title: 'Linked', watchHitId: hit!.id })
    const md = (await huntReportMarkdown(t.orgId, hunt.id, t.analyst))!.markdown
    expect(md).toContain('<https://example.test/advisory?id=1>')
    expect(html(md)).toContain('href="https://example.test/advisory?id=1"')
    await db.delete(huntCases).where(eq(huntCases.id, hunt.id))
  })
})
