/**
 * Demo-mode fixtures for contributors without a tenant. Clearly labelled as demo data in every
 * result (`mode: 'demo'`) and in the UI. Deterministic so tests can assert on them.
 */
const DEVICES = ['demo-wks-001', 'demo-wks-002', 'demo-srv-db01', 'demo-wks-003', 'demo-srv-web01']

export function demoAdvancedHunting(kql: string) {
  const rows = Array.from({ length: 1500 }, (_, i) => ({
    Timestamp: new Date(Date.UTC(2026, 0, 1, 0, i % 60)).toISOString(),
    DeviceName: DEVICES[i % DEVICES.length],
    ActionType: i % 7 === 0 ? 'ProcessCreated' : 'NetworkConnection',
    InitiatingProcessFileName: i % 3 === 0 ? 'powershell.exe' : 'svchost.exe',
    RemoteUrl: i % 5 === 0 ? 'demo.example.invalid' : '',
    DemoQueryLength: kql.length,
  }))
  return { columns: Object.keys(rows[0]!), rows }
}

export function demoSentinelQuery(kql: string) {
  const rows = Array.from({ length: 250 }, (_, i) => ({
    TimeGenerated: new Date(Date.UTC(2026, 0, 2, i % 24)).toISOString(),
    Computer: DEVICES[i % DEVICES.length],
    EventID: [4624, 4625, 4688][i % 3],
    Account: `DEMO\\user${i % 4}`,
    DemoQueryLength: kql.length,
  }))
  return { columns: Object.keys(rows[0]!), rows }
}

export function demoSentinelIncidents() {
  return [
    { id: 'demo-incident-1', number: 101, title: '[demo] Suspicious PowerShell on demo-wks-001', severity: 'Medium', status: 'New', createdTimeUtc: '2026-01-02T03:04:05Z' },
    { id: 'demo-incident-2', number: 102, title: '[demo] Multiple failed sign-ins for DEMO\\user2', severity: 'Low', status: 'Active', createdTimeUtc: '2026-01-02T05:06:07Z' },
  ]
}
