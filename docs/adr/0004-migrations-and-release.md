# 0004. Production migrations and releases

- **Status:** Accepted
- **Date:** 2026-11-07

## Context

Issues #69 and #76: schema changes must not depend on hand-run SQL, multi-replica starts must not
race, and production images must be traceable to git tags.

## Decision

- **Migrations** run in a one-shot runner before traffic moves: an Azure Container Apps Job in
  Azure, a `migrate` Compose service elsewhere. The runner holds a Postgres advisory lock and
  Drizzle applies the batch in one transaction. `/readyz` only reports ready when the applied
  migrations match the image. Migrate-on-start is opt-in for single-container dev only.
- **Releases** use semver tags `vX.Y.Z` on `main`. The release workflow builds, generates an SBOM,
  gates on CRITICAL fixable CVEs, pushes `ghcr.io/<owner>/crosswire:vX.Y.Z` and `:sha-<sha>`, and
  creates a GitHub Release from the matching `CHANGELOG.md` section with the SBOM attached.
  Production deploys promote an existing tag (`image_tag`) or build the dispatched commit.

## Consequences

- Deploys have one extra step (the job) but never serve a half-migrated schema.
- Destructive schema changes must follow expand → migrate → contract across releases.
