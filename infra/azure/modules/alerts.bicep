// Alert rules (#73): small v1 set. All are log-search alerts on the Log Analytics workspace that
// receives Container Apps console logs (JSON lines from the app logger) and system logs.
param location string
param prefix string
param logsWorkspaceId string
param alertEmail string

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
    name: '${prefix}-hunt-approval-failures'
    description: 'Failed hunts, KQL runs, executions or worker jobs.'
    severity: 2
    query: 'ContainerAppConsoleLogs_CL | extend j = parse_json(Log_s) | where j.level == "error" and (tostring(j.msg) has_any ("run_kql", "execute", "job ", "approval", "hunt"))'
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
    actions: { actionGroups: actions }
  }
}]
