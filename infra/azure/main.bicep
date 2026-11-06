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

@description('Object ID of the operator who seeds Key Vault secrets (gets Key Vault Secrets Officer).')
param operatorObjectId string = ''

@description('Email for alert notifications (#73). Empty = no action group.')
param alertEmail string = ''

@description('Optional custom domain (#70), e.g. crosswire.contoso.com. Bind after DNS is in place; see docs/runbooks/custom-domain.md.')
param customDomain string = ''

var names = {
  identity: '${prefix}-id'
  logs: '${prefix}-logs'
  env: '${prefix}-env'
  web: '${prefix}-web'
  worker: '${prefix}-worker'
  kv: take('${prefix}kv${uniqueString(resourceGroup().id)}', 24)
  pg: '${prefix}-pg-${uniqueString(resourceGroup().id)}'
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
    postgresPublicAccess: postgresPublicAccess
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
