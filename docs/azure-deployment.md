# Azure Deployment — Design

**Status:** Design doc. Not yet implemented. Requires Azure subscription access from TNS IT.
**Owner:** Engineering (Leigh) + IT
**Depends on:** [SSO design](sso-design.md) (same tenant)

---

## Goal

Get the Spare Key Audit app onto a stable, production-ready URL with:

- A real hostname (e.g., `keyaudit.thenextstreet.com`)
- Persistent storage that survives redeploys
- Secrets managed via Azure Key Vault (not flat `.env` files)
- A staging slot for risk-free changes
- Automated deploys from `main` via GitHub Actions
- Reasonable cost ceiling — this isn't a high-traffic service

Constraints we already settled:

- **Single-tenant Node app** (single `server.js` process, in-process worker, SQLite)
- **Volume**: ~30 audits / month total
- **Tenant boundary**: M365 / Entra is on TNS's existing Azure tenant — deploying inside that tenant avoids cross-tenant token dance

---

## Hosting: Azure App Service (Linux)

Why App Service over the alternatives:

| Option | Why not | Why App Service wins |
|---|---|---|
| Azure Container Apps | More moving parts; needs Dockerfile + ACR; overkill for one Node process | Direct Node deployment, no container required |
| Azure Functions | Cold starts hurt the field-flow latency target (<10s); background worker doesn't fit Functions' model | Persistent worker, no cold starts |
| Azure VM | We'd be managing the OS, patches, reverse proxy ourselves | Managed platform; no OS to maintain |
| Static Web Apps | Doesn't host a long-running Node server | We need a real server |

### Plan tier

Recommend **Basic B1** (~$13/month) for prod, **Free F1** for staging.

- Basic B1 covers: 1 core, 1.75 GB RAM, 10 GB disk, custom domain support, SSL, always-on
- For 30 audits/month, B1 is significantly over-provisioned; that's fine
- F1 staging slot avoids ramping cost while testing changes; restart-on-idle is acceptable for staging
- **Skip Standard / Premium tiers**: we don't need auto-scale, more slots, daily backups (we'll handle backups ourselves), or higher SLA

### Region

**East US** or **East US 2** — closest to CT/MA. Latency to Anthropic API is similar across US regions.

---

## Persistent storage

### Application database + uploads

App Service has two storage options:

| | Pros | Cons | Verdict |
|---|---|---|---|
| **App Service local file system** | Built-in, fast | Wiped on redeploy. Wiped if you swap slots. | ❌ Don't use for anything persistent |
| **Azure Files mount** (SMB share) | Survives redeploys + slot swaps. ~$5/month for ~100GB. | Slightly slower than local disk. | ✅ Use this for `data/` and `uploads/` |

**Mount Azure Files at `/home/data` and `/home/uploads`**. Update `db.js` to point `DATA_DIR` and `UPLOADS_DIR` to those paths via env vars:

```dotenv
DATA_DIR=/home/data
UPLOADS_DIR=/home/uploads
```

Both `db.js` and `server.js` already use `path.join(__dirname, "...")` — switch to honor these env vars when set:

```javascript
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, "uploads");
```

### Future migration path: SharePoint for photos

Per [requirements.md](requirements.md) §6.3 Q17, photos *will* migrate to SharePoint document library on the same tenant. That's a v2 concern. For v1, Azure Files is the right tradeoff — simpler, no Graph dependency, same persistence guarantees.

### Backups

- **Azure Files snapshots** daily, retained 30 days. Manual restore via Azure CLI or portal if needed.
- **SQLite is a single file** — easy to copy out of Azure Files for offline backup if needed.
- Don't enable App Service's "backup" feature — it doesn't include mounted Azure Files content anyway.

---

## Secrets: Azure Key Vault

Move every secret out of `.env` and into Key Vault. App Service references them via `@Microsoft.KeyVault(...)` syntax in env vars.

### Secrets to store

| Key Vault secret name | Purpose |
|---|---|
| `anthropic-api-key` | OCR |
| `onestep-api-key` | Roster refresh |
| `azure-tenant-id` | (could be a plain env var since it's not secret; treat as config) |
| `azure-client-id` | (similar — public-ish) |
| `azure-client-secret` | SSO + Planner |
| `session-secret` | Express session cookie signing |

### App Service config

```
ANTHROPIC_API_KEY = @Microsoft.KeyVault(SecretUri=https://tns-keyaudit-kv.vault.azure.net/secrets/anthropic-api-key/)
ONESTEP_API_KEY   = @Microsoft.KeyVault(SecretUri=...)
AZURE_CLIENT_SECRET = @Microsoft.KeyVault(SecretUri=...)
SESSION_SECRET    = @Microsoft.KeyVault(SecretUri=...)

AZURE_TENANT_ID   = <plain value>
AZURE_CLIENT_ID   = <plain value>
FLEETOPS_GROUP_ID = <plain value>
DATA_DIR          = /home/data
UPLOADS_DIR       = /home/uploads
NODE_ENV          = production
PORT              = 8080
AUTH_ENABLED      = true
```

### Key Vault access for App Service

- Enable **system-assigned managed identity** on the App Service.
- In Key Vault, give that managed identity the **Key Vault Secrets User** role.
- App Service will resolve `@Microsoft.KeyVault(...)` references automatically. No code change needed.

### Secret rotation

- `anthropic-api-key`: rotate annually or on suspicion of leak. Add new version in Key Vault → App Service auto-picks up (or restart to be safe).
- `azure-client-secret`: 24-month expiry from registration; renewal is a calendar item.
- `session-secret`: rotation invalidates all active sessions. Coordinate with deploys.

---

## Slots: staging + prod

App Service supports deployment slots. Set up:

- **prod**: the live URL, mounts the real Azure Files share
- **staging**: separate URL (`keyaudit-staging.azurewebsites.net`), separate Azure Files share or no persistence (treat staging as ephemeral)

### Deploy flow

```
main branch
   │
   └─► GitHub Actions
        │
        ├─► deploy to staging slot
        ├─► run smoke test against staging URL
        └─► (manual approval) ── swap staging ↔ prod
```

After swap, prod is running the new code with prod's mounted storage. Old code is in the staging slot for ~1 hour of warm-rollback availability.

---

## CI/CD: GitHub Actions

### Trigger: push to `main`

```yaml
# .github/workflows/deploy.yml
name: Deploy to Azure
on:
  push:
    branches: [ main ]
  workflow_dispatch:

jobs:
  deploy-staging:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22' }
      - run: npm ci --omit=dev
      - run: node -c server.js && node -c db.js && node -c ocr.js && node -c reconciliation.js
      - uses: azure/login@v2
        with:
          creds: ${{ secrets.AZURE_CREDENTIALS }}
      - uses: azure/webapps-deploy@v3
        with:
          app-name: tns-keyaudit
          slot-name: staging
          package: .

  smoke-test:
    needs: deploy-staging
    runs-on: ubuntu-latest
    steps:
      - run: |
          curl -fSs https://keyaudit-staging.azurewebsites.net/api/locations
          curl -fSs https://keyaudit-staging.azurewebsites.net/inbox | grep -q "TNS SPARE KEY AUDIT"

  promote-to-prod:
    needs: smoke-test
    runs-on: ubuntu-latest
    environment: production   # requires manual approval in GitHub Environments
    steps:
      - uses: azure/login@v2
        with: { creds: ${{ secrets.AZURE_CREDENTIALS }} }
      - run: |
          az webapp deployment slot swap \
            --name tns-keyaudit \
            --resource-group tns-keyaudit-rg \
            --slot staging --target-slot production
```

The `environment: production` line gates the swap step on a manual approval click in the GitHub UI — gives a human one last chance to abort.

### Required GitHub secrets

- `AZURE_CREDENTIALS`: JSON output from `az ad sp create-for-rbac --sdk-auth` for a deploy-only service principal

---

## Custom domain + SSL

- Add `keyaudit.thenextstreet.com` as a custom domain on the prod slot.
- DNS: CNAME `keyaudit` → `tns-keyaudit.azurewebsites.net`. **IT/Admin owns this DNS record.**
- SSL: free **App Service Managed Certificate**, auto-renews. Click-through in the Azure portal.
- Force HTTPS: enabled in App Service config.

---

## Smoke-test checklist (post-deploy)

After every prod deploy, run through this list. Aim for ≤2 min:

- [ ] `https://keyaudit.thenextstreet.com/api/locations` returns the hub list
- [ ] `https://keyaudit.thenextstreet.com/inbox` renders (HTML 200)
- [ ] `https://keyaudit.thenextstreet.com/submit` renders (HTML 200)
- [ ] (Auth-enabled) `https://keyaudit.thenextstreet.com/` redirects to Microsoft login
- [ ] Submit a test photo via `/submit`; confirm it lands in `/inbox` as `pending`
- [ ] After ~30s, the test submission moves to `ready`
- [ ] Open the submission in `/inbox`, finalize with the test chip list; confirm `finalized` state + buckets render
- [ ] Confirm the resulting `[planner-stub]` log lines (or real Planner tasks if Planner integration is live) in App Service log stream
- [ ] Delete the test submission

If anything fails, swap slots back: `az webapp deployment slot swap --slot production --target-slot staging`.

---

## Cost summary (monthly estimate)

| Resource | Tier | Est. cost |
|---|---|---|
| App Service plan | Basic B1 | ~$13 |
| App Service plan | Free F1 (staging) | $0 |
| Azure Files | 100 GB standard | ~$5 |
| Key Vault | <10K operations/mo | ~$0.03 |
| Anthropic API | 30 audits × $0.13 | ~$4 |
| OneStep GPS | (existing — not new) | — |
| Custom domain SSL | Managed cert | $0 |
| Bandwidth | <5 GB/mo | <$1 |
| **Total** | | **~$23/month** |

Roughly $280/year all-in. Well within "low-friction internal tool" territory.

---

## Decisions still needed

| # | Question | Recommendation | Decider |
|---|---|---|---|
| AZ1 | Confirm `keyaudit.thenextstreet.com` subdomain availability | (closes requirements.md Q13) | IT |
| AZ2 | Resource group naming convention | Match TNS's existing convention (whatever IT uses) | IT |
| AZ3 | Region (East US vs East US 2) | **East US 2** — newer, slightly cheaper, same latency | Engineering |
| AZ4 | Should staging have its own Azure Files share, or share the prod share? | **Separate share** for staging — prevents test data polluting prod | Engineering |
| AZ5 | Should we run the worker on a separate WebJob, or in-process? | **In-process for v1**. Move to a WebJob only if we ever scale to multi-instance. (closes requirements.md Q20) | Engineering |
| AZ6 | Backup retention period for Azure Files snapshots | **30 days** | Engineering + IT |
| AZ7 | Log retention | **Application Insights** with 30-day retention; cheap and the dashboards are useful | Engineering |
| AZ8 | Who has Contributor access to the resource group? | Engineering team + IT/Admin emergency access | IT |

---

## What's NOT in this design

- **Multi-region failover** — not warranted at this scale.
- **Auto-scaling** — single instance is fine for 30 audits / month.
- **CDN / Front Door** — direct App Service is plenty.
- **WAF (Web Application Firewall)** — internal-only tenant-restricted SSO covers the threat model.
- **Geo-redundant storage** — Azure Files' default LRS replication is sufficient for an internal tool with daily snapshots.
- **Containerization** — direct Node deploy avoids the Docker layer entirely. Revisit only if scaling needs change.

---

## Rollout sequencing

Once SSO + Planner integrations are done and credentials are in hand:

1. **Provision Azure resources** (manual, in portal or via Bicep/Terraform if IT prefers):
   - Resource group
   - App Service plan (B1)
   - App Service (with staging slot)
   - Storage account + Azure Files share
   - Key Vault + initial secrets
   - Mount Azure Files on both slots
2. **Configure managed identity** + Key Vault access policy
3. **Set up DNS** (IT)
4. **Wire GitHub Actions** + create the deploy service principal
5. **First deploy to staging** + smoke-test
6. **Promote to prod** + smoke-test
7. **Hand off pilot to one hub manager + fleet ops reviewer** for a 2-week trial
