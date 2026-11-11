import { createFileRoute } from '@tanstack/react-router'
import { fetchConnector } from '../fns/hunts'
import { fetchAuthAudit, fetchDigestEmail, fetchEntraMappings, fetchMembers } from '../fns/settings'
import { fetchChannels, fetchResponseConnector } from '../fns/notify'
import { fetchSetupState } from '../fns/setup'
import { fmtTimeExact, humanise } from '../components/format'
import { PageHead, TableWrap, SkeletonPage } from '../components/ui'
import { pageTitle, RouteError } from '../components/errors'
import { Section } from './-settings/shared'
import { Members } from './-settings/members'
import { EntraMappings } from './-settings/entra-mappings'
import { ConnectorForm, ResponseConnectorForm } from './-settings/connectors'
import { Channels } from './-settings/channels'
import { DigestEmail } from './-settings/digest-email'
import { SetupSteps } from './-settings/setup-steps'

/**
 * Settings: one page, sectioned, with in-page navigation. Every save is enforced server-side
 * (owners only); non-owners see read-only summaries that say who can change them.
 */
export const Route = createFileRoute('/app/settings')({
  loader: async () => {
    const [members, entra, connector, audit, response, channels, digestEmail, setup] = await Promise.all([
      fetchMembers(),
      fetchEntraMappings(),
      fetchConnector(),
      fetchAuthAudit(),
      fetchResponseConnector(),
      fetchChannels(),
      fetchDigestEmail(),
      fetchSetupState(),
    ])
    return { members, entra, connector, audit, response, channels, digestEmail, setup }
  },
  pendingComponent: () => <SkeletonPage label="Loading settings" />,
  errorComponent: ({ error }) => <RouteError error={error} title="Settings did not load" />,
  head: () => ({ meta: [{ title: pageTitle('Settings') }] }),
  component: Settings,
})

const SECTIONS = [
  ['people', 'People and roles'],
  ['entra-groups', 'Entra groups'],
  ['hunting', 'Defender and Sentinel'],
  ['response', 'Response connection'],
  ['alerts', 'Teams and Slack alerts'],
  ['digest-email', 'Digest email'],
  ['setup', 'Setup steps'],
  ['audit', 'Audit log'],
] as const

function Settings() {
  const { members, entra, connector, audit, response, channels, digestEmail, setup } = Route.useLoaderData()
  // Only owners receive digest email, so only they see that section.
  const sections = SECTIONS.filter(([id]) => id !== 'digest-email' || digestEmail.allowed)
  return (
    <>
      <PageHead title="Settings" intro="Who can do what, how Crosswire connects to Microsoft, and where alerts go. Owners change these; everyone can read them." />
      <div className="cw-settings">
        <nav aria-label="Settings sections" className="cw-toc">
          <ul>
            {sections.map(([id, label]) => (
              <li key={id}>
                <a href={`#${id}`}>{label}</a>
              </li>
            ))}
          </ul>
        </nav>
        <div>
          <Section id="people" title="People and roles" intro="Analysts investigate and ask for actions. Approvers decide on actions. Owners also manage people and settings. New people join as analysts.">
            <Members data={members} />
          </Section>
          <Section id="entra-groups" title="Entra groups" intro="Give people a Crosswire role from their Entra groups or app roles, applied at each Microsoft sign-in.">
            <EntraMappings data={entra} />
          </Section>
          <Section id="hunting" title="Defender and Sentinel" intro="A read-only connection so approved searches run on your real data. Until it is set, hunts return labelled demo data.">
            <ConnectorForm data={connector} health={setup.connector} now={setup.now} />
          </Section>
          <Section id="response" title="Response connection (optional)" intro="Only needed if your organisation lets approved actions run for real. Safe mode stays on until an admin changes it.">
            <ResponseConnectorForm data={response} />
          </Section>
          <Section id="alerts" title="Teams and Slack alerts" intro="Post a short message when something needs a decision or a repeat search finds results.">
            <Channels data={channels} />
          </Section>
          {digestEmail.allowed && (
            <Section id="digest-email" title="Digest email" intro="Where your daily watch digest is emailed. Use a confirmed contact address if your sign-in email has no mailbox.">
              <DigestEmail data={digestEmail} />
            </Section>
          )}
          <Section id="setup" title="Setup steps" intro="The Get started checklist on the control panel.">
            <SetupSteps data={setup} />
          </Section>
          <Section id="audit" title="Audit log" intro="Sign-ins, role changes and response decisions, newest first.">
            {!audit.allowed ? (
              <p className="cw-muted">Only owners can view the audit log.</p>
            ) : audit.events.length === 0 ? (
              <p className="cw-empty">No events yet.</p>
            ) : (
              <TableWrap label="Audit log">
                <table className="cw-table">
                  <thead>
                    <tr>
                      <th scope="col">When</th>
                      <th scope="col">Category</th>
                      <th scope="col">Action</th>
                      <th scope="col">Result</th>
                      <th scope="col">Actor</th>
                      <th scope="col">IP address</th>
                    </tr>
                  </thead>
                  <tbody>
                    {audit.events.map((e) => (
                      <tr key={e.id}>
                        <td className="num">{fmtTimeExact(e.createdAt)}</td>
                        <td>{humanise(e.category)}</td>
                        <td className="mono">{e.action}</td>
                        <td>
                          <span className="cw-badge" data-tone={e.result === 'success' ? 'ok' : e.result === 'failure' ? 'danger' : undefined}>
                            {humanise(e.result)}
                          </span>
                        </td>
                        <td>
                          {e.actorType} <span className="mono">{e.actorId ?? ''}</span>
                        </td>
                        <td className="mono">{e.ipAddress ?? <span className="cw-muted">not recorded</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            )}
          </Section>
        </div>
      </div>
    </>
  )
}
