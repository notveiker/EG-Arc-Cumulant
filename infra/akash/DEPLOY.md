# Deploy the Cumulant backend on Akash (with Flow webhook)

This wires the Dynamic **Flow** webhook into the deploy: the webhook must point at
the backend's **public** URL, which only exists once it's deployed.

## What you do vs. what I (Claude) can do

- **You:** run the Akash lease (it escrows AKT — a crypto payment I don't execute),
  build/push the Docker image (needs your registry login), and enter secrets in the
  Console.
- **I can:** create the Flow webhook in the Dynamic dashboard against your live URL,
  hand you the signing secret, and flip the frontend env.

## 0. Prereqs
- A container registry (Docker Hub / GHCR) you can push to.
- Akash Console (https://console.akash.network) with a funded wallet (you're in).
- The repo's `backend/Dockerfile`, `.dockerignore`, and
  `infra/akash/cumulant-backend.yaml` (all committed).

## 1. Build & push the image (repo root)
```bash
# from the repo root (the build context needs contracts/deployments/)
docker build -f backend/Dockerfile -t docker.io/<you>/cumulant-backend:latest .
docker login
docker push docker.io/<you>/cumulant-backend:latest
```
> The root `.env` (with the deployer key) is excluded by `.dockerignore` — it is
> never baked into the image. Secrets are injected as env at deploy time.

## 2. First deploy (no webhook secret yet)
1. In the Console: **Deploy → Build your template → Upload SDL** →
   `infra/akash/cumulant-backend.yaml`.
2. Set `image:` to the image you pushed.
3. In the **env editor**, fill the secrets (kept out of git):
   - `DEPLOYER_PRIVATE_KEY` — resolver/deployer key (prefer a dedicated low-balance key).
   - `RESOLVER_API_SECRET` — any strong random string.
   - `FRONTEND_URL` — your deployed frontend origin (for CORS).
   - `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` — **required for a prod-like / multi-instance
     deploy.** The distribution and note position stores fall back to single-instance,
     file-backed state when these are unset, so without Supabase a multi-replica (or
     restart-prone) Akash deployment will lose or split that off-chain ledger. On-chain reads
     and Polymarket proxying work without it; the position-recording rails do not survive
     scale-out. (Set `SUPABASE_ANON_KEY` too if your build uses it.)
   - Leave `DYNAMIC_WEBHOOK_SECRET=REPLACE_AFTER_WEBHOOK` for now.
4. **Create deployment → fund escrow → accept a bid → wait for the lease.**
5. Copy the lease **URI** (e.g. `https://abc123.provider.akash.network`).
6. Sanity check:
   ```bash
   curl https://<lease-host>/api/health         # -> ok / status JSON
   curl https://<lease-host>/api/flow/status    # -> {"webhookConfigured": false}
   ```

## 3. Create the Flow webhook (I do this for you)
Tell me the lease URL and I will, in the Dynamic dashboard
(**Developers → Webhooks → Create webhook**):
- URL = `https://<lease-host>/api/flow/webhook`
- Events = the **Checkout** group (Flow settlement lifecycle)
- Save, then copy the **signing secret**.

## 4. Add the secret + redeploy
1. In the Console, set `DYNAMIC_WEBHOOK_SECRET` to that signing secret and **Update
   deployment** (rolling redeploy).
2. Verify it's live:
   ```bash
   curl https://<lease-host>/api/flow/status    # -> {"webhookConfigured": true}
   ```

## 5. Point the frontend at the deployed backend
In `frontend/.env.local` (and your frontend host's env):
```
NEXT_PUBLIC_BACKEND_URL=https://<lease-host>
NEXT_PUBLIC_DYNAMIC_FLOW_ENABLED=true   # already set
```
Rebuild the frontend (`NEXT_PUBLIC_*` is inlined at build time).

## Notes
- **Custom domain (cleaner):** put a stable domain in front of the lease, then the
  webhook URL is known up front — create the webhook before deploying and bake the
  secret into step 2, skipping the redeploy.
- **Security:** the backend signs only the resolver role. Use a dedicated resolver
  key with minimal funds on the deployed instance; rotate after the event.
- **Polymarket geo-block:** if the Akash provider is in a blocked region, set
  `POLYMARKET_PROXY_URL` to your relay (you already have the relay pattern).
