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

// Key Vault secret name -> container secret name -> env var. Names match .env.example.
var kvSecrets = [
  { name: 'database-url', env: 'DATABASE_URL' }
  { name: 'better-auth-secret', env: 'BETTER_AUTH_SECRET' }
  { name: 'app-encryption-key', env: 'APP_ENCRYPTION_KEY' }
  { name: 'entra-client-secret', env: 'ENTRA_CLIENT_SECRET' }
]
var secrets = [for s in kvSecrets: { name: s.name, keyVaultUrl: '${keyVaultUri}secrets/${s.name}', identity: identityId }]
var secretEnv = [for s in kvSecrets: { name: s.env, secretRef: s.name }]
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
  { name: 'HUNTING_DEMO_MODE', value: 'false' }
  { name: 'RESPONSE_EXECUTOR_SENTINEL', value: 'off' }
  { name: 'RESPONSE_EXECUTOR_LOGICAPP', value: 'off' }
  { name: 'RESPONSE_EXECUTOR_GRAPH', value: 'off' }
  // Fail-closed global dry-run (#83). Live execution requires changing this to 'false' via a change ticket.
  { name: 'RESPONSE_DRY_RUN', value: 'true' }
  { name: 'MIGRATIONS_DIR', value: '/app/drizzle' }
  { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsightsConnectionString }
  { name: 'CORS_ALLOWED_ORIGINS', value: corsAllowedOrigins }
  { name: 'ENTRA_CLIENT_ID', value: entraClientId }
  { name: 'ENTRA_TENANT_ID', value: entraTenantId }
]

resource env 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: envName
  location: location
  properties: {
    appLogsConfiguration: { destination: 'log-analytics', logAnalyticsConfiguration: { customerId: logsCustomerId, sharedKey: logsSharedKey } }
  }
}

resource web 'Microsoft.App/containerApps@2024-03-01' = {
  name: webName
  location: location
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${identityId}': {} } }
  properties: {
    managedEnvironmentId: env.id
    configuration: {
      ingress: { external: true, targetPort: 3000, transport: 'auto', allowInsecure: false }
      secrets: secrets
    }
    template: {
      containers: [
        {
          name: 'web'
          image: image
          resources: { cpu: json('0.5'), memory: '1Gi' }
          env: concat(plainEnv, secretEnv)
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
    configuration: { secrets: secrets }
    template: {
      containers: [
        {
          name: 'worker'
          image: image
          command: ['node_modules/.bin/tsx', 'src/server/cli/worker.ts']
          resources: { cpu: json('0.25'), memory: '0.5Gi' }
          env: concat(plainEnv, secretEnv)
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
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: 600
      replicaRetryLimit: 0
      manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 }
      secrets: secrets
    }
    template: {
      containers: [
        {
          name: 'migrate'
          image: image
          command: ['node_modules/.bin/tsx', 'src/server/cli/migrate.ts']
          resources: { cpu: json('0.25'), memory: '0.5Gi' }
          env: concat(plainEnv, secretEnv)
        }
      ]
    }
  }
}

output webFqdn string = web.properties.configuration.ingress.fqdn
output webName string = web.name
output envId string = env.id
