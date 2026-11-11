# Runbook: deploy rollback (#71)

Linked from `.github/workflows/deploy.yml`. The deploy summary records the previous web and worker
images and revision.

## Automatic rollback

If the new revisions do not become ready, or the smoke test fails, the deploy job sets web and worker
back to the images they ran before and fails (red). It does not reverse migrations: they are
additive by policy (see [migrations](migrations.md)), so the previous image runs on the newer
schema. Check the result with Option C below, then fix forward.

## Decide: roll back or fix forward

| Signal | Action |
| --- | --- |
| Smoke test failed, `/readyz` not ready, 5xx alert firing, sign-in broken | **Roll back** now, investigate after |
| Small bug, fix already merged to `main`, no data risk | **Fix forward**: dispatch Deploy on `main` |
| Migration in the bad release was **destructive** | Do **not** roll back the app alone; see [migrations](migrations.md) and [backup and restore](backup-restore.md) |

## Find the image to go back to

Every image the deploy workflow builds is pushed as `ghcr.io/jusso-dev/crosswire:sha-<40 hex>`, the
full commit SHA. Release images are also tagged `vX.Y.Z`. Tags can be moved, so the workflow
resolves the tag to a digest once and deploys that digest. The digest is what is immutable.

- The last good image is in the summary of the last good Deploy run ("Previous web revision ...,
  image ..."), or in the revision list:

  ```sh
  RG=crosswire-prod; APP=crosswire-web
  az containerapp revision list -g $RG -n $APP --query "[].{name:name,active:properties.active,created:properties.createdTime,image:properties.template.containers[0].image}" -o table
  ```

- The image reference looks like `ghcr.io/jusso-dev/crosswire@sha256:<digest>`. To find its
  `sha-` tag, use the commit of the last good Deploy run: `sha-<that commit's full SHA>`.

## Option A: redeploy a previous image with the workflow (preferred)

Actions → Deploy → Run workflow on `main` → `image_tag` = one of:

- `sha-<40 hex>`: any image an earlier deploy pushed, for example `sha-` plus the full SHA of the last
  good commit on `main`.
- `vX.Y.Z`: a release, when one exists.

The workflow checks that the commit is on `main` and that the image's signed provenance names that
commit, skips the build, runs the migration job (no change for an older schema), updates web and
worker, waits for both, and runs the smoke test against that commit's migration tag.

## Option B: Azure CLI (when Actions is unavailable)

```sh
RG=crosswire-prod
IMG=ghcr.io/jusso-dev/crosswire@sha256:<digest of the last good image>
az containerapp update -g $RG -n crosswire-web --image "$IMG"
az containerapp update -g $RG -n crosswire-worker --image "$IMG"
```

## Option C: check after rolling back

1. `bash scripts/smoke.sh https://<host>` (or Actions → Smoke) must pass.
2. `az containerapp show -g $RG -n crosswire-worker --query properties.latestReadyRevisionName` matches
   the latest revision (the worker health probe passes).
3. Note the bad image in the incident and in `CHANGELOG.md` (Unreleased → "Reverted").
4. Fix forward on `main`, then deploy again.

## Rehearsal record

Rehearse Option A in the lab resource group (`crosswire-lab`) and record it here.

| Date | From | To | Result | Time to green |
| --- | --- | --- | --- | --- |
| (not yet rehearsed) | | | | |
