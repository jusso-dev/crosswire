// Crosswire on Azure (#59, #60): Container Apps (web + worker), PostgreSQL Flexible Server,
// Key Vault with RBAC, Log Analytics, user-assigned managed identity. See docs/adr/0003 and
// docs/runbooks/azure-deploy.md. Apply manually: az deployment group create ... (or what-if first).
targetScope = 'resourceGroup'

@description('Short name prefix for all resources (lowercase, 3-12 chars).')
@minLength(3)
@maxLength(12)
param prefix string = 'crosswire'

param location string = resourceGroup().location

@description('Container image, for example ghcr.io/jusso-dev/crosswire:<sha>.')
param image string

@description('Public URL of the app (custom domain or the ACA FQDN once known).')
param appUrl string

@description('Postgres admin login. The password lives only in Key Vault.')
param postgresAdminLogin string = 'crosswireadmin'

@secure()
@description('Postgres admin password. Passed once at deploy time, stored in Key Vault as database-url.')
param postgresAdminPassword string

@description('Lab shortcut (opt-in): public Postgres access with the "Allow Azure services" rule. That admits any Azure-hosted client that has the credentials. Default false; see the runbook for private networking.')
param postgresPublicAccess bool = false

@description('Production (opt-in): VNet for the Container Apps environment and Postgres VNet integration (private DNS, no public endpoint). Default false. Set it only on a new deployment: an existing environment or server cannot switch. Cannot be combined with postgresPublicAccess. See the runbook.')
param privateNetworking bool = false

@description('Private networking: VNet address space, /23 or larger. Avoid 172.30.0.0/16, 172.31.0.0/16, 100.100.0.0/16 and ranges used by peered networks.')
param vnetAddressPrefix string = '10.40.0.0/22'

@description('Object ID of the operator who seeds Key Vault secrets (gets Key Vault Secrets Officer).')
param operatorObjectId string = ''

@description('Email for alert notifications (#73). Empty = no action group.')
param alertEmail string = ''

@description('Optional custom domain (#70), e.g. crosswire.contoso.com. Bind after DNS is in place; see docs/runbooks/custom-domain.md.')
param customDomain string = ''

@description('Entra SSO app (client) id and tenant id (not secrets). Set here so redeploys keep them.')
param entraClientId string = ''
param entraTenantId string = ''

@description('IANA time zone for displayed times and the daily digest day.')
param appTimeZone string = 'Australia/Sydney'

@description('Chat: endpoint of an existing Azure OpenAI resource, e.g. https://contoso-ai.openai.azure.com. Empty = chat off. See docs/chat-model.md.')
param azureOpenAiEndpoint string = ''
@description('Chat: model deployment name in that resource.')
param azureOpenAiDeployment string = ''
@description('Chat: name of that Azure OpenAI resource, when it is in this resource group. Bicep then grants the app identity "Cognitive Services OpenAI User" on it. Leave empty to assign the role yourself.')
param azureOpenAiResourceName string = ''

var names = {
  identity: '${prefix}-id'
  logs: '${prefix}-logs'
  env: '${prefix}-env'
  web: '${prefix}-web'
  worker: '${prefix}-worker'
  kv: take('${prefix}kv${uniqueString(resourceGroup().id)}', 24)
  pg: '${prefix}-pg-${uniqueString(resourceGroup().id)}'
  vnet: '${prefix}-vnet'
}

// Fail closed: a public Postgres endpoint with an "Allow Azure services" rule defeats private networking.
var pgPublic = privateNetworking && postgresPublicAccess
  ? fail('postgresPublicAccess and privateNetworking cannot both be true. Private networking has no public Postgres endpoint; set postgresPublicAccess=false.')
  : postgresPublicAccess

module network 'modules/network.bicep' = if (privateNetworking) {
  name: 'network'
  params: {
    location: location
    vnetName: names.vnet
    pgDnsZoneName: '${names.pg}.private.postgres.database.azure.com'
    addressPrefix: vnetAddressPrefix
  }
}

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: names.identity
  location: location
}

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: names.logs
  location: location
  properties: { sku: { name: 'PerGB2018' }, retentionInDays: 30 }
}

// Application Insights (#73), workspace-based.
resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: '${prefix}-ai'
  location: location
  kind: 'web'
  properties: { Application_Type: 'web', WorkspaceResourceId: logs.id }
}

module data 'modules/data.bicep' = {
  name: 'data'
  params: {
    location: location
    kvName: names.kv
    pgName: names.pg
    postgresAdminLogin: postgresAdminLogin
    postgresAdminPassword: postgresAdminPassword
    postgresPublicAccess: pgPublic
    pgDelegatedSubnetId: privateNetworking ? network!.outputs.pgSubnetId : ''
    pgPrivateDnsZoneId: privateNetworking ? network!.outputs.pgDnsZoneId : ''
    appIdentityPrincipalId: identity.properties.principalId
    operatorObjectId: operatorObjectId
  }
}

module apps 'modules/apps.bicep' = {
  name: 'apps'
  params: {
    location: location
    envName: names.env
    webName: names.web
    workerName: names.worker
    image: image
    appUrl: appUrl
    identityId: identity.id
    logsCustomerId: logs.properties.customerId
    logsSharedKey: logs.listKeys().primarySharedKey
    keyVaultUri: data.outputs.keyVaultUri
    appInsightsConnectionString: appInsights.properties.ConnectionString
    corsAllowedOrigins: empty(customDomain) ? '' : 'https://${customDomain}'
    entraClientId: entraClientId
    entraTenantId: entraTenantId
    appTimeZone: appTimeZone
    azureOpenAiEndpoint: azureOpenAiEndpoint
    azureOpenAiDeployment: azureOpenAiDeployment
    identityClientId: identity.properties.clientId
    infrastructureSubnetId: privateNetworking ? network!.outputs.acaSubnetId : ''
  }
}

// Keyless chat (ADR 0004): the app identity may call the Azure OpenAI resource, nothing more.
resource openAi 'Microsoft.CognitiveServices/accounts@2024-10-01' existing = if (!empty(azureOpenAiResourceName)) {
  name: azureOpenAiResourceName
}
resource openAiUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(azureOpenAiResourceName)) {
  name: guid(resourceGroup().id, azureOpenAiResourceName, identity.id, 'openai-user')
  scope: openAi
  properties: {
    // Cognitive Services OpenAI User
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd')
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

module alerts 'modules/alerts.bicep' = {
  name: 'alerts'
  params: {
    location: location
    prefix: prefix
    logsWorkspaceId: logs.id
    alertEmail: alertEmail
  }
}

output webFqdn string = apps.outputs.webFqdn
output keyVaultName string = names.kv
output postgresHost string = data.outputs.postgresHost
output identityClientId string = identity.properties.clientId
output appInsightsName string = appInsights.name
