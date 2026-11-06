// Application Insights bootstrap (#73). Preloaded with `node --import ./telemetry.mjs server.mjs`
// so OpenTelemetry hooks register before ESM app modules load (required for ESM instrumentation).
// No-op unless APPLICATIONINSIGHTS_CONNECTION_STRING is set.
// Captures inbound/outbound HTTP (requests, Microsoft Graph, TI feeds). Postgres calls use
// postgres.js, which has no OpenTelemetry instrumentation, so DB time shows inside request spans
// rather than as separate dependencies. Headers and bodies are not exported.
if (process.env.APPLICATIONINSIGHTS_CONNECTION_STRING) {
  await import('@azure/monitor-opentelemetry/loader')
  const { useAzureMonitor: enableAzureMonitor } = await import('@azure/monitor-opentelemetry')
  enableAzureMonitor({
    azureMonitorExporterOptions: { connectionString: process.env.APPLICATIONINSIGHTS_CONNECTION_STRING },
    instrumentationOptions: { http: { enabled: true } },
    enableLiveMetrics: false,
  })
}
