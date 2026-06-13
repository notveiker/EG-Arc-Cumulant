# Akash Polymarket relay

A tiny, **allowlisted** HTTP relay that forwards only Polymarket requests. Deploy it
on a **non-US Akash provider** so Cumulant's backend can reach Polymarket's
geo-blocked Gamma + CLOB APIs. Because it's reached over the provider's normal
HTTP(S) ingress (`:80` / `:443`), it works through restrictive networks (work wifi)
that block VPN/Tor/odd proxy ports.

- `relay.mjs` — the relay (allowlisted to Polymarket hosts, optional shared token, `/whoami` egress check).
- `deploy.yaml` — Akash SDL with `relay.mjs` inlined as base64 (no Docker build / registry needed; runs on stock `node:20-alpine`).

## Deploy

1. **Deploy the SDL** via the [Akash Console](https://console.akash.network) ("Build your template" → paste `deploy.yaml`) or the `akash`/`provider-services` CLI. When choosing a bid, **pick a provider that is NOT in the US** (EU/Asia/etc.).
2. Wait for the lease, then copy the **lease URI / ingress hostname** (e.g. `xxxxx.provider.example.com`).
3. **Verify the egress country is non-US** — this is the whole point:
   ```bash
   curl https://<lease-host>/whoami
   # -> {"ip":"...","country":"DE","org":"..."}   # country MUST NOT be "US"
   ```
   If it says `US`, close the deployment and re-deploy choosing a different (non-US) provider.
4. **Health check:** `curl https://<lease-host>/health` → `ok`.

## Wire it into Cumulant

Add to the repo-root `.env` (gitignored) — the `RELAY_TOKEN` is set in `deploy.yaml`:

```
POLYMARKET_RELAY_URL=https://<lease-host>/?token=<RELAY_TOKEN>&url={url}
```

Restart the backend. It logs `[proxy] Polymarket requests routed via RELAY` and the
basket / tranche / PPN feeds repopulate with live Polymarket data. (Use the
`https://` ingress on :443 so it passes work-wifi firewalls.)

## Notes

- **Security:** the relay only forwards to `gamma-api.polymarket.com` / `clob.polymarket.com` (+ `polymarket.com`) and is token-gated — it is not a general open proxy. Rotate `RELAY_TOKEN` in `deploy.yaml` if you redeploy.
- **Flat-rate / unlimited:** unlike a metered scraping API, this handles the backend's full polling volume for the (cheap, flat) Akash lease cost — the right long-term setup for heavy Polymarket use.
