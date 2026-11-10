// Alert rules (#73, #142, #153). Log-search alerts on the Log Analytics workspace that receives
// Container Apps console logs (JSON lines from the app logger) and system logs, plus Postgres
// metric alerts. main.bicep refuses an empty alertEmail unless allowAlertsWithoutEmail is set.
param location string
param prefix string
param logsWorkspaceId string
param alertEmail string
param workerAppName string
param migrateJobName string
param postgresId string
@description('Skip KQL validation at deploy time. Needed on a new workspace: the ContainerApp*_CL tables only exist after the first logs arrive. Set false on later deployments to catch a broken query.')
param skipQueryValidation bool = true

resource actionGroup 'Microsoft.Insights/actionGroups@2023-01-01' = if (!empty(alertEmail)) {
  name: '${prefix}-ops'
  location: 'global'
  properties: {
    groupShortName: take('${prefix}ops', 12)
    enabled: true
    emailReceivers: [{ name: 'ops', emailAddress: alertEmail, useCommonAlertSchema: true }]
  }
}

var actions = empty(alertEmail) ? [] : [actionGroup.id]

// Error-level log lines whose `msg` is a known failure event (#153), not a free-text word match.
// Keep this list in step with logger.error calls in apps/web/src.
var failureEvents = '"hunt run_kql failed", "scheduled hunt failed", "response execute failed", "notify failed", "digest email failed", "retention purge stopped part way", "failed to finish agent run", "request failed"'

var rules = [
  {
    name: '${prefix}-http-5xx'
    description: 'HTTP 5xx responses from the web app (5+ in 5 minutes).'
    severity: 2
    query: 'ContainerAppConsoleLogs_CL | where ContainerAppName_s endswith "-web" | extend j = parse_json(Log_s) | where j.msg == "request" and toint(j.status) >= 500'
    threshold: 5
  }
  {
    name: '${prefix}-probe-failures'
    description: 'Liveness/readiness probe failures reported by Container Apps.'
    severity: 1
    query: 'ContainerAppSystemLogs_CL | where Reason_s in ("ProbeFailed", "ContainerTerminated", "ReplicaUnhealthy") or Log_s has "probe failed"'
    threshold: 3
  }
  {
    name: '${prefix}-job-failures'
    description: 'Failed hunts, KQL runs, executions, notifications or worker jobs (error-level events).'
    severity: 2
    query: 'ContainerAppConsoleLogs_CL | extend j = parse_json(Log_s) | extend m = tostring(j.msg) | where tostring(j.level) == "error" and (m in (${failureEvents}) or (m startswith "job " and m endswith " failed"))'
    threshold: 1
  }
  {
    name: '${prefix}-worker-down'
    description: 'Worker restarted, crashed or failed its health probe (#142). Watches, digests and scheduled hunts stop while it is down.'
    severity: 1
    query: 'ContainerAppSystemLogs_CL | where ContainerAppName_s == "${workerAppName}" and Reason_s in ("ProbeFailed", "ContainerTerminated", "ContainerCrashing", "BackOff", "ReplicaUnhealthy")'
    threshold: 1
  }
  {
    name: '${prefix}-migration-failed'
    description: 'The migration job logged an error (#153).'
    severity: 1
    query: 'ContainerAppConsoleLogs_CL | where ContainerJobName_s == "${migrateJobName}" | extend j = parse_json(Log_s) | where tostring(j.level) == "error"'
    threshold: 1
  }
]

resource alertRules 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = [for r in rules: {
  name: r.name
  location: location
  properties: {
    displayName: r.name
    description: r.description
    severity: r.severity
    enabled: true
    scopes: [logsWorkspaceId]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT5M'
    criteria: {
      allOf: [
        {
          query: r.query
          timeAggregation: 'Count'
          operator: 'GreaterThanOrEqual'
          threshold: r.threshold
          failingPeriods: { numberOfEvaluationPeriods: 1, minFailingPeriodsToAlert: 1 }
        }
      ]
    }
    autoMitigate: true
    skipQueryValidation: skipQueryValidation
    actions: { actionGroups: actions }
  }
}]

// Postgres capacity (#153): storage nearly full, or connections near the tier limit.
var pgMetrics = [
  { name: '${prefix}-pg-storage', description: 'Postgres storage above 80%.', metric: 'storage_percent', threshold: 80 }
  { name: '${prefix}-pg-connections', description: 'Postgres active connections above 40 (Burstable B1ms allows about 50).', metric: 'active_connections', threshold: 40 }
]

resource pgAlerts 'Microsoft.Insights/metricAlerts@2018-03-01' = [for m in pgMetrics: {
  name: m.name
  location: 'global'
  properties: {
    description: m.description
    severity: 2
    enabled: true
    scopes: [postgresId]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: m.metric
          metricName: m.metric
          operator: 'GreaterThan'
          threshold: m.threshold
          timeAggregation: 'Average'
          criterionType: 'StaticThresholdCriterion'
        }
      ]
    }
    autoMitigate: true
    actions: [for a in actions: { actionGroupId: a }]
  }
}]
