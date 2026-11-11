// PostgreSQL Flexible Server + Key Vault (RBAC). The app identity gets Key Vault Secrets User only.
param location string
param kvName string
param pgName string
param postgresAdminLogin string
@secure()
@minLength(16)
param postgresAdminPassword string
@description('Set the admin password on the server and write database-url. True on the first deployment and to rotate; false on a routine redeploy, so the live password never changes by accident (#137).')
param rotatePostgresPassword bool = false
@description('Least-privilege app role (#135) used by web and worker. The migration job creates it.')
param postgresAppLogin string = 'crosswire_app'
@secure()
@minLength(16)
param postgresAppPassword string
@description('Write database-url-app from postgresAppPassword. True on the first deployment, when adding the app role to an existing deployment, and to rotate.')
param rotateAppDatabasePassword bool = false
@description('Backup retention in days (7 to 35).')
@minValue(7)
@maxValue(35)
param backupRetentionDays int = 7
@description('Geo-redundant backup. Can only be set when the server is created.')
@allowed(['Disabled', 'Enabled'])
param geoRedundantBackup string = 'Disabled'
@description('High availability. Not available on the Burstable tier.')
@allowed(['Disabled', 'SameZone', 'ZoneRedundant'])
param highAvailabilityMode string = 'Disabled'
param postgresSkuName string = 'Standard_B1ms'
@allowed(['Burstable', 'GeneralPurpose', 'MemoryOptimized'])
param postgresSkuTier string = 'Burstable'
@description('CanNotDelete locks on the Postgres server and Key Vault. Recommended for production. Creating locks needs Owner or User Access Administrator.')
param enableDeleteLocks bool = false
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
  sku: { name: postgresSkuName, tier: postgresSkuTier }
  properties: {
    version: '17'
    administratorLogin: postgresAdminLogin
    // null leaves the property out of the request, so the server keeps its current password.
    administratorLoginPassword: rotatePostgresPassword ? postgresAdminPassword : null
    storage: { storageSizeGB: 32, autoGrow: 'Enabled' }
    backup: { backupRetentionDays: backupRetentionDays, geoRedundantBackup: geoRedundantBackup }
    highAvailability: { mode: highAvailabilityMode }
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

// sslmode=verify-full (#134): the driver checks the server certificate and host name. Azure
// Database for PostgreSQL chains to DigiCert Global Root G2 / Microsoft RSA Root CA 2017, both in
// Node's bundled CA store, so no CA file is needed. Written only when the password is (re)set.
// Owner URL: the migration job only.
resource dbUrl 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = if (rotatePostgresPassword) {
  parent: kv
  name: 'database-url'
  properties: {
    value: 'postgres://${postgresAdminLogin}:${uriComponent(postgresAdminPassword)}@${pg.properties.fullyQualifiedDomainName}:5432/crosswire?sslmode=verify-full'
  }
}

// App role URL (#135): web and worker. The migration job sets the role's password from it.
resource dbUrlApp 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = if (rotateAppDatabasePassword) {
  parent: kv
  name: 'database-url-app'
  properties: {
    value: 'postgres://${postgresAppLogin}:${uriComponent(postgresAppPassword)}@${pg.properties.fullyQualifiedDomainName}:5432/crosswire?sslmode=verify-full'
  }
}

resource pgLock 'Microsoft.Authorization/locks@2020-05-01' = if (enableDeleteLocks) {
  name: 'crosswire-no-delete'
  scope: pg
  properties: { level: 'CanNotDelete', notes: 'Holds the audit trail and approval history. Remove the lock deliberately before deleting.' }
}

resource kvLock 'Microsoft.Authorization/locks@2020-05-01' = if (enableDeleteLocks) {
  name: 'crosswire-no-delete'
  scope: kv
  properties: { level: 'CanNotDelete', notes: 'Holds the database URLs and the app encryption key.' }
}

output keyVaultUri string = kv.properties.vaultUri
output postgresHost string = pg.properties.fullyQualifiedDomainName
output postgresId string = pg.id
