// Private networking (opt-in, main.bicep `privateNetworking`): one VNet with two delegated subnets
// and the private DNS zone that PostgreSQL VNet integration needs. See docs/runbooks/azure-deploy.md.
param location string
param vnetName string
@description('Private DNS zone for PostgreSQL. Must end with .postgres.database.azure.com and must not be <server>.postgres.database.azure.com.')
param pgDnsZoneName string
@description('VNet address space, /23 or larger. Must not overlap peered networks or the ranges Container Apps reserves (172.30.0.0/16, 172.31.0.0/16, 100.100.0.0/16, 169.254.0.0/16, 192.0.2.0/24).')
param addressPrefix string

// Subnets are inline so a redeploy never removes them. Sizes cannot change once in use.
// Container Apps (workload profiles env): /27 minimum, delegated to Microsoft.App/environments; /24 leaves room to scale.
// PostgreSQL: /28 minimum, delegated to Microsoft.DBforPostgreSQL/flexibleServers.
var acaSubnetName = 'snet-aca'
var pgSubnetName = 'snet-postgres'

resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: vnetName
  location: location
  properties: {
    addressSpace: { addressPrefixes: [addressPrefix] }
    subnets: [
      {
        name: acaSubnetName
        properties: {
          addressPrefix: cidrSubnet(addressPrefix, 24, 0)
          delegations: [{ name: 'aca', properties: { serviceName: 'Microsoft.App/environments' } }]
        }
      }
      {
        name: pgSubnetName
        properties: {
          addressPrefix: cidrSubnet(addressPrefix, 28, 16)
          delegations: [{ name: 'postgres', properties: { serviceName: 'Microsoft.DBforPostgreSQL/flexibleServers' } }]
          // Postgres adds this endpoint itself (WAL upload to Storage); declaring it stops a redeploy removing it.
          serviceEndpoints: [{ service: 'Microsoft.Storage' }]
        }
      }
    ]
  }
}

resource pgDnsZone 'Microsoft.Network/privateDnsZones@2024-06-01' = {
  name: pgDnsZoneName
  location: 'global'
}

// The Container Apps subnet resolves the server name to its private address through this link.
resource pgDnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = {
  parent: pgDnsZone
  name: '${vnetName}-link'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: { id: vnet.id }
  }
}

output acaSubnetId string = resourceId('Microsoft.Network/virtualNetworks/subnets', vnet.name, acaSubnetName)
output pgSubnetId string = resourceId('Microsoft.Network/virtualNetworks/subnets', vnet.name, pgSubnetName)
// Consumers of module outputs wait for the whole module, so Postgres is created after the DNS link.
output pgDnsZoneId string = pgDnsZone.id
