using './main.bicep'

param prefix = 'crosswire'
param image = 'ghcr.io/jusso-dev/crosswire:sha-REPLACE_WITH_40_HEX_SHA'
param appUrl = 'https://REPLACE_WITH_FQDN_OR_DOMAIN'
// Both passwords are required on every run: no default, so a missing variable stops the deployment
// before anything changes (#137). They are applied only when the matching rotate flag is true.
// Export them from a password manager, never generate a new one for a routine redeploy.
param postgresAdminPassword = readEnvironmentVariable('CROSSWIRE_PG_PASSWORD')
param postgresAppPassword = readEnvironmentVariable('CROSSWIRE_PG_APP_PASSWORD')
// First deployment and deliberate rotations only. See docs/runbooks/azure-deploy.md.
param rotatePostgresPassword = false
param rotateAppDatabasePassword = false
// Lab only: set true to use the Allow-Azure-services firewall rule instead of private networking.
param postgresPublicAccess = false
// Production: VNet + private Postgres. New deployments only (see the runbook); not with postgresPublicAccess.
param privateNetworking = false
param operatorObjectId = ''
// Required: alerts must reach someone (#153). Labs may set allowAlertsWithoutEmail = true instead.
param alertEmail = 'REPLACE_WITH_OPS_EMAIL'
param customDomain = ''
param entraClientId = ''
param entraTenantId = ''
// Approval and session policy (#133). Kept here so a redeploy never drops them.
param kqlApprovalPolicy = 'member'
// Production resilience (#154). See docs/runbooks/backup-restore.md for the chosen levels.
param postgresBackupRetentionDays = 14
param enableDeleteLocks = true
