/**
 * Proxy support for the Polymarket APIs.
 *
 * Polymarket's Gamma + CLOB endpoints are geo-blocked: from a blocked region
 * (e.g. the US) Cloudflare drops the connection, so `fetch` fails with a
 * connection error (curl shows HTTP 000). Set `POLYMARKET_PROXY_URL` to route
 * ONLY the Polymarket requests through a proxy / VPN exit in an allowed region;
 * everything else (Arc RPC, yields, etc.) stays direct.
 *
 * Supported proxy URL forms:
 *   http://user:pass@host:port     — HTTP CONNECT proxy (most commercial proxies)
 *   https://user:pass@host:port
 *   socks5://user:pass@host:port   — SOCKS5 (e.g. Mullvad / NordVPN / Proton SOCKS)
 *   socks4://host:port
 *
 * If unset, calls use the platform `fetch` directly — no behavior change.
 */
import {
  ProxyAgent,
  Agent,
  buildConnector,
  fetch as undiciFetch,
  type Dispatcher,
} from "undici";
import { SocksClient, type SocksProxy } from "socks";

let _dispatcher: Dispatcher | null | undefined;

/** Build an undici dispatcher that tunnels through a SOCKS4/5 proxy. */
function buildSocksDispatcher(proxyUrl: string): Dispatcher {
  const u = new URL(proxyUrl);
  const type = (u.protocol.toLowerCase().startsWith("socks4") ? 4 : 5) as 4 | 5;
  const proxy: SocksProxy = {
    host: u.hostname,
    port: Number(u.port) || 1080,
    type,
    userId: u.username ? decodeURIComponent(u.username) : undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
  };
  const tlsConnect = buildConnector({});
  return new Agent({
    connect(opts, callback) {
      const o = opts as { hostname: string; port?: number | string; protocol?: string };
      const isTls = o.protocol === "https:";
      const port = o.port ? Number(o.port) : isTls ? 443 : 80;
      SocksClient.createConnection({
        proxy,
        command: "connect",
        destination: { host: o.hostname, port },
      })
        .then(({ socket }) => {
          if (isTls) {
            // Upgrade the raw SOCKS tunnel to TLS for https targets.
            tlsConnect({ ...(opts as object), httpSocket: socket } as never, callback as never);
          } else {
            (callback as (err: Error | null, sock: unknown) => void)(null, socket);
          }
        })
        .catch((err: Error) => (callback as unknown as (err: Error) => void)(err));
    },
  });
}

/** Memoized dispatcher for Polymarket, or undefined when no proxy is configured. */
export function polymarketDispatcher(): Dispatcher | undefined {
  if (_dispatcher !== undefined) return _dispatcher ?? undefined;
  const url = process.env.POLYMARKET_PROXY_URL?.trim();
  if (!url) {
    _dispatcher = null;
    return undefined;
  }
  try {
    _dispatcher = /^socks/i.test(url) ? buildSocksDispatcher(url) : new ProxyAgent(url);
    console.log(`[proxy] Polymarket requests routed via ${url.replace(/\/\/[^@]*@/, "//****@")}`);
  } catch (e) {
    console.warn("[proxy] Polymarket proxy init failed (using direct fetch):", (e as Error).message);
    _dispatcher = null;
  }
  return _dispatcher ?? undefined;
}

export function proxyConfigured(): boolean {
  return Boolean(process.env.POLYMARKET_RELAY_URL?.trim()) || Boolean(polymarketDispatcher());
}

/**
 * `fetch` for Polymarket — transparently routed through POLYMARKET_PROXY_URL when
 * set, otherwise the platform fetch. Returns a standard web `Response`.
 */
/**
 * Optional RELAY mode for restrictive networks (e.g. work wifi that blocks
 * VPN/Tor). Set POLYMARKET_RELAY_URL to a plain HTTPS endpoint that fetches a
 * target URL from a non-US region and returns its body — reached over normal
 * HTTPS:443 so it passes corporate firewalls. The target URL is URL-encoded into
 * the `{url}` placeholder (or appended if no placeholder). Works with hosted
 * scraping APIs (ScraperAPI / ScrapingAnt / ZenRows — pick country=EU) or a
 * self-hosted relay (e.g. a Vercel function pinned to a EU region). Takes
 * precedence over POLYMARKET_PROXY_URL.
 *
 *   ScraperAPI : https://api.scraperapi.com/?api_key=KEY&country_code=eu&url={url}
 *   ScrapingAnt: https://api.scrapingant.com/v2/general?x-api-key=KEY&proxy_country=DE&browser=false&url={url}
 *   self-host  : https://my-relay.vercel.app/?url={url}
 */
function relayTarget(url: string): string | null {
  const relay = process.env.POLYMARKET_RELAY_URL?.trim();
  if (!relay) return null;
  const enc = encodeURIComponent(url);
  return relay.includes("{url}") ? relay.replace("{url}", enc) : relay + enc;
}

let _relayLogged = false;

export async function proxiedFetch(url: string, init?: RequestInit): Promise<Response> {
  const relayed = relayTarget(url);
  if (relayed) {
    if (!_relayLogged) {
      console.log("[proxy] Polymarket requests routed via RELAY (POLYMARKET_RELAY_URL)");
      _relayLogged = true;
    }
    // The relay fetches the target itself + sets its own headers; we only carry
    // the abort signal (timeout). It returns the target's body verbatim.
    const signal = (init as { signal?: AbortSignal } | undefined)?.signal;
    return fetch(relayed, signal ? { signal } : undefined);
  }
  const dispatcher = polymarketDispatcher();
  if (!dispatcher) return fetch(url, init);
  return undiciFetch(url, {
    ...(init as Record<string, unknown>),
    dispatcher,
  }) as unknown as Response;
}
