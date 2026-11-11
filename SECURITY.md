# Security policy

Crosswire handles tenant credentials, runs queries against customer Microsoft tenants and can
trigger response actions. We take reports seriously.

## Reporting a vulnerability

**Please do not open a public issue with exploit details.**

Report privately through GitHub: **Security → Report a vulnerability** on
[jusso-dev/crosswire](https://github.com/jusso-dev/crosswire/security/advisories/new)
(private security advisory). If that is not possible, email **justin@yumait.com.au** with
"Crosswire security" in the subject.

Include affected version/commit, reproduction steps, and impact. We will acknowledge and work with
you on a fix and coordinated disclosure. This is an open-source kit maintained on a best-effort
basis; there is no support SLA.

## In scope

- Authentication or session bypass, CSRF, open redirects
- Tenant isolation failures (reading or writing another org's data)
- Approval bypass: executing a response proposal without an authorised approval, self-approval
  when it is disabled, agents reaching executors
- Hunting safety bypass: running KQL without approval, calling non-allowlisted Microsoft endpoints
- Secret exposure: connector secrets, tokens or keys in responses, logs, audit rows or agent memory
- Injection in server functions, SSRF via TI fetching or executors

## Out of scope

- Denial of service, load testing or scraping against pwn.watch, CISA, Microsoft or any upstream
- Findings that require a compromised host or already-privileged database access
- Missing hardening headers without a demonstrated impact
- Vulnerabilities in third-party dependencies without a Crosswire-specific exploit (report upstream)

## Supported versions

Only the latest `main` is supported.

## How we watch for known vulnerabilities

- Dependabot alerts and security updates are on for the repository.
- CI fails an image build on a CRITICAL vulnerability with a fix available.
- A weekly scan (`.github/workflows/image-scan.yml`) checks the newest published image on `main`
  for HIGH and CRITICAL vulnerabilities, fixed or not, and reports them to code scanning.
