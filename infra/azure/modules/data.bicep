// PostgreSQL Flexible Server + Key Vault (RBAC). The app identity gets Key Vault Secrets User only.
param location string
param kvName string
param pgName string
param postgresAdminLogin string
@secure()
param postgresAdminPassword string
param postgresPublicAccess bool
@description('Private networking: subnet delegated to Microsoft.DBforPostgreSQL/flexibleServers. Empty = public-access mode (the default). Fixed at creation.')
param pgDelegatedSubnetId string = ''
@description('Private networking: private DNS zone (linked to the VNet) for the server record.')
param pgPrivateDnsZoneId string = ''
param appIdentityPrincipalId string
param operatorObjectId string

var secretsUserRole = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6')
var secretsOfficerRole = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7')

// VNet integration (private access) has no public endpoint and no firewall rules. main.bicep refuses
// postgresPublicAccess together with private networking, so the firewall rule below never applies here.
var pgPrivate = !empty(pgDelegatedSubnetId)
var pgNetwork = pgPrivate
  ? { delegatedSubnetResourceId: pgDelegatedSubnetId, privateDnsZoneArmResourceId: pgPrivateDnsZoneId, publicNetworkAccess: 'Disabled' }
  : { publicNetworkAccess: postgresPublicAccess ? 'Enabled' : 'Disabled' }

resource kv 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: kvName
  location: location
  properties: {
    tenantId: subscription().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 30
    enablePurgeProtection: true
    publicNetworkAccess: 'Enabled'
  }
}

resource appSecretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(kv.id, appIdentityPrincipalId, 'secrets-user')
  scope: kv
  properties: { roleDefinitionId: secretsUserRole, principalId: appIdentityPrincipalId, principalType: 'ServicePrincipal' }
}

resource operatorOfficer 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(operatorObjectId)) {
  name: guid(kv.id, operatorObjectId, 'secrets-officer')
  scope: kv
  properties: { roleDefinitionId: secretsOfficerRole, principalId: operatorObjectId }
}

resource pg 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: pgName
  location: location
  sku: { name: 'Standard_B1ms', tier: 'Burstable' }
  properties: {
    version: '17'
    administratorLogin: postgresAdminLogin
    administratorLoginPassword: postgresAdminPassword
    storage: { storageSizeGB: 32, autoGrow: 'Enabled' }
    backup: { backupRetentionDays: 7, geoRedundantBackup: 'Disabled' }
    highAvailability: { mode: 'Disabled' }
    network: pgNetwork
  }
}

resource pgDb 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: pg
  name: 'crosswire'
}

// Lab shortcut only: allows Azure-hosted services (including ACA) to connect. See runbook risk notes.
resource pgAllowAzure 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2024-08-01' = if (postgresPublicAccess && !pgPrivate) {
  parent: pg
  name: 'AllowAzureServices'
  properties: { startIpAddress: '0.0.0.0', endIpAddress: '0.0.0.0' }
}

resource dbUrl 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: kv
  name: 'database-url'
  properties: {
    value: 'postgres://${postgresAdminLogin}:${uriComponent(postgresAdminPassword)}@${pg.properties.fullyQualifiedDomainName}:5432/crosswire?sslmode=require'
  }
}

output keyVaultUri string = kv.properties.vaultUri
output postgresHost string = pg.properties.fullyQualifiedDomainName
