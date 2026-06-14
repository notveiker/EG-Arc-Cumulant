# Deploy the frontend on Vercel

The Next.js app lives in `frontend/`. Vercel auto-detects Next.js — the only real
work is the **Root Directory** and the **env vars**.

## 1. Import the project
- Vercel → Add New → Project → import this repo.
- **Root Directory: `frontend`** (important — the app isn't at the repo root).
- Framework preset: **Next.js** (auto). Build command / output: defaults.

## 2. Environment variables (Project → Settings → Environment Variables)
All are build-time `NEXT_PUBLIC_*` (inlined at build — redeploy after any change):

| Key | Value |
| --- | --- |
| `NEXT_PUBLIC_BACKEND_URL` | Public URL of your backend (see backend path below) |
| `NEXT_PUBLIC_CHAIN` | `arc` |
| `NEXT_PUBLIC_WC_PROJECT_ID` | Your WalletConnect/Reown id (real id if you want mobile QR) |
| `NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID` | `d21c2904-dd3b-45c4-b145-7c4a185890f8` |
| `NEXT_PUBLIC_DYNAMIC_FLOW_ENABLED` | `true` |

> `NEXT_PUBLIC_BACKEND_URL` must be a public URL the browser can reach. Vercel is
> public, so it can't call `localhost`. Set it to either your Akash lease URL **or**
> your tunnel URL (if the backend runs on localhost — see below).

## 3. Dynamic dashboard: whitelist the Vercel domain  ⚠️ required
Dynamic embedded wallets need the app's origin allow-listed, or login fails with a
CORS error. After Vercel gives you a domain (e.g. `cumulant.vercel.app`):
- Dynamic dashboard → add it (and `http://localhost:13200` for local dev) to the
  allowed origins / CORS. (I can do this for you in the dashboard once you have the
  domain.)

## 4. Backend URL — two options
- **Backend on localhost (your stated plan):** run the backend locally and expose it
  with a tunnel so both Vercel and Dynamic's Flow webhook can reach it:
  ```bash
  # terminal 1 — backend
  cd backend && npm run build && npm start          # :13201
  # terminal 2 — public tunnel
  npx cloudflared tunnel --url http://localhost:13201
  #   (or: ngrok http 13201)
  ```
  Use the printed `https://…` URL as `NEXT_PUBLIC_BACKEND_URL` (Vercel) and as the
  Flow webhook target `https://…/api/flow/webhook`. Tunnel must stay running during
  the demo.
- **Backend on Akash (public, stable):** see `infra/akash/DEPLOY.md`. Use the lease
  URL as `NEXT_PUBLIC_BACKEND_URL`.

## 5. Also set on the backend (wherever it runs)
- `FRONTEND_URL` = your Vercel origin (CORS allowlist), e.g.
  `https://cumulant.vercel.app` (comma-separate multiple).
- `DYNAMIC_WEBHOOK_SECRET` = from the Flow webhook (created against the public
  backend URL).
