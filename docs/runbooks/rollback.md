# Runbook: deploy rollback (#71)

Linked from `.github/workflows/deploy.yml` (the deploy summary records the previous revision).

## Decide: roll back or fix forward

| Signal | Action |
| --- | --- |
| Smoke test failed, `/readyz` not ready, 5xx alert firing, sign-in broken | **Roll back** now, investigate after |
| Small bug, fix already merged to `main`, no data risk | **Fix forward**: dispatch Deploy on `main` |
| Migration in the bad release was **destructive** | Do **not** roll back the app alone; see [migrations](migrations.md) and [backup and restore](backup-restore.md) |

## Option A: previous Container Apps revision (fastest)

```sh
RG=crosswire-prod; APP=crosswire-web
az containerapp revision list -g $RG -n $APP --query "[].{name:name,active:properties.active,created:properties.createdTime,image:properties.template.containers[0].image}" -o table
# single-revision mode: re-activate the previous revision and restart it
az containerapp revision activate -g $RG -n $APP --revision <previous-revision-name>
az containerapp update -g $RG -n $APP --image <image-of-previous-revision>
# repeat for the worker: crosswire-worker
```

## Option B: redeploy a previous image tag

Images are immutable: `ghcr.io/<owner>/crosswire:sha-<sha>` and release tags `vX.Y.Z`.

- **Workflow:** Actions → Deploy → Run workflow → `image_tag = v1.2.3` (the last good release).
  This skips the build, runs the migration job (no-op for an older schema), updates web and worker,
  and runs the smoke test.
- **CLI:** `az containerapp update -g $RG -n crosswire-web --image ghcr.io/<owner>/crosswire:v1.2.3`
  (and the worker).

## After rolling back

1. `bash scripts/smoke.sh https://<host>` (or Actions → Smoke) must pass.
2. Note the bad image tag in the incident and in `CHANGELOG.md` (Unreleased → "Reverted").
3. Fix forward on `main`, then deploy again.
