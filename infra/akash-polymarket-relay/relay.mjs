/**
 * Allowlisted Polymarket relay — deploy on a NON-US host (e.g. an Akash provider
 * in the EU/Asia) to route Cumulant's Polymarket requests around the geo-block.
 *
 * It is NOT an open proxy: it only forwards to Polymarket hosts and (optionally)
 * requires a shared token. Reach it over the host's normal HTTP(S) ingress
 * (:80 / :443), so it passes restrictive networks (work wifi) that block
 * VPN/Tor/odd ports.
 *
 * Endpoints:
 *   GET /health                 -> "ok"
 *   GET /whoami                 -> { ip, country, org }   (verify the egress is non-US!)
 *   GET /?token=T&url=<ENCODED> -> proxies the (allowlisted) target, returns its body
 *
 * Env:
 *   PORT         (default 80)
 *   RELAY_TOKEN  (optional shared secret; if set, callers must pass ?token=...)
 */
import http from "node:http";

const PORT = Number(process.env.PORT || 80);
const TOKEN = process.env.RELAY_TOKEN || "";
const ALLOW = new Set([
  "gamma-api.polymarket.com",
  "clob.polymarket.com",
  "polymarket.com",
  "strapi-matic.poly.market",
]);

const send = (res, code, body, type = "text/plain") => {
  res.writeHead(code, { "content-type": type, "access-control-allow-origin": "*" });
  res.end(body);
};

http
  .createServer(async (req, res) => {
    try {
      const u = new URL(req.url, "http://localhost");

      if (u.pathname === "/health") return send(res, 200, "ok");

      if (u.pathname === "/whoami") {
        const info = await fetch("https://ipinfo.io/json", {
          signal: AbortSignal.timeout(10000),
        })
          .then((r) => r.json())
          .catch(() => ({}));
        return send(
          res,
          200,
          JSON.stringify({ ip: info.ip, country: info.country, region: info.region, org: info.org }),
          "application/json",
        );
      }

      if (TOKEN && u.searchParams.get("token") !== TOKEN) return send(res, 403, "forbidden");

      const target = u.searchParams.get("url");
      if (!target) return send(res, 400, "missing url param");
      let t;
      try {
        t = new URL(target);
      } catch {
        return send(res, 400, "bad url");
      }
      if (!ALLOW.has(t.hostname)) return send(res, 403, `host not allowed: ${t.hostname}`);

      const upstream = await fetch(target, {
        headers: { "user-agent": "Mozilla/5.0", accept: "application/json" },
        signal: AbortSignal.timeout(25000),
      });
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.writeHead(upstream.status, {
        "content-type": upstream.headers.get("content-type") || "application/json",
        "access-control-allow-origin": "*",
      });
      res.end(buf);
    } catch (e) {
      send(res, 502, `relay error: ${e?.message || e}`);
    }
  })
  .listen(PORT, () => console.log(`[relay] polymarket relay listening on :${PORT}`));
