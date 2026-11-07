using './main.bicep'

param prefix = 'crosswire'
param image = 'ghcr.io/jusso-dev/crosswire:REPLACE_WITH_SHA'
param appUrl = 'https://REPLACE_WITH_FQDN_OR_DOMAIN'
// Pass at deploy time: --parameters postgresAdminPassword=$(openssl rand -base64 30)
param postgresAdminPassword = readEnvironmentVariable('CROSSWIRE_PG_PASSWORD', '')
// Lab only: set true to use the Allow-Azure-services firewall rule instead of private networking.
param postgresPublicAccess = false
param operatorObjectId = ''
param alertEmail = ''
param customDomain = ''
param entraClientId = ''
param entraTenantId = ''
