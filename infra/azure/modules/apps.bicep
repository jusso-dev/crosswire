// Container Apps environment + web (ingress, probes) + worker (no ingress).
// Secrets are Key Vault references resolved by the user-assigned identity.
param location string
param envName string
param webName string
param workerName string
param image string
param appUrl string
param identityId string
param logsCustomerId string
@secure()
param logsSharedKey string
param keyVaultUri string
@description('Application Insights connection string (not a secret: it identifies the resource).')
param appInsightsConnectionString string = ''
@description('Comma-separated extra CORS / trusted origins (custom domains).')
param corsAllowedOrigins string = ''
@description('IANA time zone for displayed times and the daily digest day.')
param appTimeZone string = 'Australia/Sydney'
@description('Chat model endpoint: Azure OpenAI resource endpoint (empty = chat off). See docs/chat-model.md.')
param azureOpenAiEndpoint string = ''
@description('Chat model deployment name in that resource.')
param azureOpenAiDeployment string = ''
@description('Client ID of the user-assigned managed identity used to sign in to Azure OpenAI (keyless).')
param identityClientId string
@description('Entra SSO app (client) id. Not a secret.')
param entraClientId string = ''
@description('Entra tenant id for SSO. Not a secret.')
param entraTenantId string = ''
@description('Who may approve and run a read-only KQL search (KQL_APPROVAL_POLICY). Kept in Bicep so a redeploy never drops it (#133).')
@allowed(['member', 'approver', 'second-person'])
param kqlApprovalPolicy string = 'member'
@description('RESPONSE_ALLOW_SELF_APPROVAL. Default false: the requester can never approve their own response action.')
param responseAllowSelfApproval bool = false
@description('Absolute session cap in hours since sign-in (1 to 720).')
param sessionMaxAgeHours int = 12
@description('Idle session timeout in minutes (5 to 1440).')
param sessionIdleMinutes int = 60
@description('Retention in days (0 keeps that data forever). See docs/configuration.md.')
param retentionChatDays int = 365
param retentionDecisionsDays int = 365
param retentionSamplesDays int = 180
param retentionAuditDays int = 730
@description('Per-client requests per minute for /api/chat.')
param rateLimitChatPerMin int = 20
@allowed(['database', 'memory'])
param rateLimitStorage string = 'database'
@description('Comma-separated proxy IPs or CIDR ranges whose X-Forwarded-For entries are trusted. Empty suits Container Apps ingress.')
param trustedProxies string = ''
@description('Hunting demo mode (labs only). Off in production.')
param huntingDemoMode bool = false
@description('RESPONSE_LOGICAPP_ORG_ID: the one organisation the response Logic App acts for (#190). Empty = Logic App proposals are refused.')
param responseLogicAppOrgId string = ''
@description('Allow loading [DEMO] fixtures in production (labs only).')
param allowDemoFixtures bool = false
@description('Port of the worker health server (GET /healthz). Probes use it.')
param workerHealthPort int = 3001
@description('Private networking: subnet for the environment infrastructure (delegated to Microsoft.App/environments). Empty = no VNet (the default). Fixed at creation: an environment cannot gain or lose a VNet later.')
param infrastructureSubnetId string = ''

var vnetIntegrated = !empty(infrastructureSubnetId)
// A delegated /27+ subnet needs a workload profiles environment (a Consumption-only one needs an
// undelegated /23). The built-in Consumption profile keeps per-second billing. internal: false keeps
// ingress public. Without a subnet the environment properties stay exactly as before.
var envNetworking = vnetIntegrated
  ? {
      vnetConfiguration: { infrastructureSubnetId: infrastructureSubnetId, internal: false }
      workloadProfiles: [{ name: 'Consumption', workloadProfileType: 'Consumption' }]
    }
  : {}
var appProfile = vnetIntegrated ? { workloadProfileName: 'Consumption' } : {}

// Key Vault secret name -> container secret name -> env var. Names match .env.example.
// Web and worker connect as the least-privilege app role (database-url-app, #135). Only the
// migration job gets the owner URL (database-url), plus the app URL so it can manage that role.
var sharedSecrets = [
  { name: 'better-auth-secret', env: 'BETTER_AUTH_SECRET' }
  { name: 'app-encryption-key', env: 'APP_ENCRYPTION_KEY' }
  { name: 'entra-client-secret', env: 'ENTRA_CLIENT_SECRET' }
]
var appSecretList = concat([{ name: 'database-url-app', env: 'DATABASE_URL' }], sharedSecrets)
var migrateSecretList = concat([{ name: 'database-url', env: 'DATABASE_URL' }, { name: 'database-url-app', env: 'APP_DATABASE_URL' }], sharedSecrets)
var appSecrets = [for s in appSecretList: { name: s.name, keyVaultUrl: '${keyVaultUri}secrets/${s.name}', identity: identityId }]
var appSecretEnv = [for s in appSecretList: { name: s.env, secretRef: s.name }]
var migrateSecrets = [for s in migrateSecretList: { name: s.name, keyVaultUrl: '${keyVaultUri}secrets/${s.name}', identity: identityId }]
var migrateSecretEnv = [for s in migrateSecretList: { name: s.env, secretRef: s.name }]
var plainEnv = [
  { name: 'NODE_ENV', value: 'production' }
  { name: 'APP_URL', value: appUrl }
  { name: 'LOG_LEVEL', value: 'info' }
  { name: 'APP_TIMEZONE', value: appTimeZone }
  // Keyless Azure OpenAI: DefaultAzureCredential uses this user-assigned identity. No API key secret.
  { name: 'MODEL_PROVIDER', value: empty(azureOpenAiEndpoint) ? 'off' : 'azure' }
  { name: 'AZURE_OPENAI_ENDPOINT', value: azureOpenAiEndpoint }
  { name: 'AZURE_OPENAI_DEPLOYMENT', value: azureOpenAiDeployment }
  { name: 'AZURE_CLIENT_ID', value: identityClientId }
  // Production sign-in is Entra SSO; local email/password sign-up stays off.
  { name: 'AUTH_EMAIL_PASSWORD', value: 'false' }
  { name: 'HUNTING_DEMO_MODE', value: string(huntingDemoMode) }
  { name: 'ALLOW_DEMO_FIXTURES', value: string(allowDemoFixtures) }
  { name: 'RESPONSE_EXECUTOR_SENTINEL', value: 'off' }
  { name: 'RESPONSE_EXECUTOR_LOGICAPP', value: 'off' }
  { name: 'RESPONSE_EXECUTOR_GRAPH', value: 'off' }
  { name: 'RESPONSE_LOGICAPP_ORG_ID', value: responseLogicAppOrgId }
  // Fail-closed global dry-run (#83). Live execution requires changing this to 'false' via a change ticket.
  { name: 'RESPONSE_DRY_RUN', value: 'true' }
  { name: 'MIGRATIONS_DIR', value: '/app/drizzle' }
  { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsightsConnectionString }
  { name: 'CORS_ALLOWED_ORIGINS', value: corsAllowedOrigins }
  { name: 'ENTRA_CLIENT_ID', value: entraClientId }
  { name: 'ENTRA_TENANT_ID', value: entraTenantId }
  // Security, session, retention and rate-limit settings (#133). Set here, not in the portal, so an
  // infrastructure redeploy keeps them.
  { name: 'KQL_APPROVAL_POLICY', value: kqlApprovalPolicy }
  { name: 'RESPONSE_ALLOW_SELF_APPROVAL', value: string(responseAllowSelfApproval) }
  { name: 'SESSION_MAX_AGE_HOURS', value: string(sessionMaxAgeHours) }
  { name: 'SESSION_IDLE_MINUTES', value: string(sessionIdleMinutes) }
  { name: 'RETENTION_CHAT_DAYS', value: string(retentionChatDays) }
  { name: 'RETENTION_DECISIONS_DAYS', value: string(retentionDecisionsDays) }
  { name: 'RETENTION_SAMPLES_DAYS', value: string(retentionSamplesDays) }
  { name: 'RETENTION_AUDIT_DAYS', value: string(retentionAuditDays) }
  { name: 'RATE_LIMIT_CHAT_PER_MIN', value: string(rateLimitChatPerMin) }
  { name: 'RATE_LIMIT_STORAGE', value: rateLimitStorage }
  { name: 'TRUSTED_PROXIES', value: trustedProxies }
  { name: 'WORKER_HEALTH_PORT', value: string(workerHealthPort) }
]

resource env 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: envName
  location: location
  properties: {
    appLogsConfiguration: { destination: 'log-analytics', logAnalyticsConfiguration: { customerId: logsCustomerId, sharedKey: logsSharedKey } }
    ...envNetworking
  }
}

resource web 'Microsoft.App/containerApps@2024-03-01' = {
  name: webName
  location: location
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${identityId}': {} } }
  properties: {
    managedEnvironmentId: env.id
    ...appProfile
    configuration: {
      ingress: { external: true, targetPort: 3000, transport: 'auto', allowInsecure: false }
      secrets: appSecrets
    }
    template: {
      containers: [
        {
          name: 'web'
          image: image
          resources: { cpu: json('0.5'), memory: '1Gi' }
          env: concat(plainEnv, appSecretEnv)
          probes: [
            { type: 'Liveness', httpGet: { path: '/healthz', port: 3000 }, periodSeconds: 30, failureThreshold: 3 }
            { type: 'Readiness', httpGet: { path: '/readyz', port: 3000 }, periodSeconds: 10, failureThreshold: 3 }
            { type: 'Startup', httpGet: { path: '/healthz', port: 3000 }, periodSeconds: 5, failureThreshold: 24 }
          ]
        }
      ]
      scale: { minReplicas: 1, maxReplicas: 3 }
    }
  }
}

resource worker 'Microsoft.App/containerApps@2024-03-01' = {
  name: workerName
  location: location
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${identityId}': {} } }
  properties: {
    managedEnvironmentId: env.id
    ...appProfile
    configuration: { secrets: appSecrets }
    template: {
      containers: [
        {
          name: 'worker'
          image: image
          command: ['node_modules/.bin/tsx', 'src/server/cli/worker.ts']
          resources: { cpu: json('0.25'), memory: '0.5Gi' }
          env: concat(plainEnv, appSecretEnv)
          // Worker health server (#142): /healthz is 200 while the last loop finished under 3
          // minutes ago. Startup allows 5 minutes for the first ingest; liveness restarts a stuck loop.
          probes: [
            { type: 'Startup', httpGet: { path: '/healthz', port: workerHealthPort }, periodSeconds: 10, failureThreshold: 30 }
            { type: 'Liveness', httpGet: { path: '/healthz', port: workerHealthPort }, periodSeconds: 30, failureThreshold: 3 }
            { type: 'Readiness', httpGet: { path: '/healthz', port: workerHealthPort }, periodSeconds: 30, failureThreshold: 3 }
          ]
        }
      ]
      // Exactly one worker: jobs are idempotent but there is no need to run them twice.
      scale: { minReplicas: 1, maxReplicas: 1 }
    }
  }
}

// One-shot migration job (#69): run after each image update, before shifting traffic.
// `az containerapp job start -n <prefix>-migrate -g <rg> --image <image>`; the deploy workflow does this.
resource migrateJob 'Microsoft.App/jobs@2024-03-01' = {
  name: '${webName}-migrate'
  location: location
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${identityId}': {} } }
  properties: {
    environmentId: env.id
    ...appProfile
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: 600
      replicaRetryLimit: 0
      manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 }
      secrets: migrateSecrets
    }
    template: {
      containers: [
        {
          name: 'migrate'
          image: image
          // Migrations as the owner, then create or update the least-privilege app role (#135).
          command: ['sh', '-c', 'node_modules/.bin/tsx src/server/cli/migrate.ts && node scripts/app-db-role.mjs']
          resources: { cpu: json('0.25'), memory: '0.5Gi' }
          env: concat(plainEnv, migrateSecretEnv)
        }
      ]
    }
  }
}

output webFqdn string = web.properties.configuration.ingress.fqdn
output workerName string = worker.name
output webName string = web.name
output envId string = env.id
