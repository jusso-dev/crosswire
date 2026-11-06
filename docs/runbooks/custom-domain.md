# Runbook: custom domain and TLS on Azure Container Apps (#70)

Default host: `<prefix>-web.<env-id>.<region>.azurecontainerapps.io` (HTTPS only; `allowInsecure:
false` in Bicep, so HTTP is redirected to HTTPS). For first use, give it a real hostname with an
**Azure-managed certificate**. No Cloudflare or other edge is required.

## Steps

```sh
RG=crosswire-prod; APP=crosswire-web; ENV=crosswire-env; HOST=crosswire.contoso.com
# 1. Get the verification id and the app FQDN
az containerapp show -g $RG -n $APP --query "{fqdn:properties.configuration.ingress.fqdn, verification:properties.customDomainVerificationId}"
```

2. DNS at your provider:
   - `CNAME crosswire.contoso.com → <app fqdn>`
   - `TXT asuid.crosswire.contoso.com → <customDomainVerificationId>`
3. Bind with a managed certificate:
   ```sh
   az containerapp hostname add  -g $RG -n $APP --hostname $HOST
   az containerapp hostname bind -g $RG -n $APP --hostname $HOST --environment $ENV --validation-method CNAME
   ```
4. Update configuration (redeploy Bicep with `customDomain=$HOST appUrl=https://$HOST`, or set env):
   - `APP_URL=https://crosswire.contoso.com` (Better Auth base URL; always trusted)
   - `CORS_ALLOWED_ORIGINS` gets `https://$HOST` automatically from the Bicep `customDomain` param;
     it also feeds Better Auth `trustedOrigins`.
5. Entra: on the **SSO app registration** add redirect URI
   `https://crosswire.contoso.com/api/auth/callback/microsoft` (keep the old one until cut-over is done).
6. Verify: `bash scripts/smoke.sh https://crosswire.contoso.com` (checks HSTS on HTTPS) and sign in with Entra.

## Checklist

- [ ] DNS CNAME + `asuid` TXT created
- [ ] Hostname bound with managed certificate
- [ ] `APP_URL` and `CORS_ALLOWED_ORIGINS` updated, revision restarted
- [ ] Entra redirect URI added
- [ ] Smoke passes on the custom host; HSTS present
