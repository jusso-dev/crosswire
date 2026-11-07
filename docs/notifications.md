# Notifications: Teams and Slack (v2, #91)

Owners add webhook channels under **Settings → Notifications**. Each channel subscribes to events:

| Event | When | Content |
| --- | --- | --- |
| `watch_hit` | A matcher run finds new hits for the org (one batched message per run) | Count, up to 5 titles, link to Watches |
| `approval_pending` | A response proposal (or rollback) is created | Title, action type, target counts, blast radius, link to the proposal |
| `execution` | A live execution finishes (succeeded, partial or failed) | Title, calls succeeded / total, link |
| `scheduled_hunt` | A scheduled hunt returns rows and the count changed | Row count (and previous), interval, link to the hunt |

## Setup

- **Microsoft Teams:** in the channel, *Workflows* → "Post to a channel when a webhook request is
  received". Copy the URL (`https://….logic.azure.com/…` or `…api.powerplatform.com/…`). Legacy
  Office 365 connector URLs (`*.webhook.office.com`) also work while Microsoft still accepts them.
  Messages are Adaptive Cards.
- **Slack:** create an app with *Incoming Webhooks* and copy the `https://hooks.slack.com/services/…` URL.
- Paste the URL, pick events, **Add channel**, then **Send test**.

## Safety

- Webhook URLs are bearer secrets: stored AES-GCM encrypted (`APP_ENCRYPTION_KEY`), never shown
  again, never logged or written to audit data. Only the host is displayed.
- Host allowlist per kind, checked on save **and** on every send: Slack `hooks.slack.com`; Teams
  `*.logic.azure.com`, `*.api.powerplatform.com`, `*.webhook.office.com`. https only, default port,
  no embedded credentials, redirects refused, 5 s timeout.
- Messages carry titles, counts and deep links only: never KQL results, payloads or secrets; all
  text is redacted, truncated and markup-escaped, so a feed or agent-written title cannot inject
  Slack mentions (`<!channel>`) or links into a trusted channel.
- Delivery failures never fail the action that triggered them. They update the channel's
  "last delivery" status and write a `notification_failed` audit event.
- At most 10 channels per org. `NOTIFICATIONS_ENABLED=false` disables all sending.
