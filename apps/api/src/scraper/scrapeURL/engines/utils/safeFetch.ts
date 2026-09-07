import type { Socket } from "net";
import { config } from "../../../../config";
import type { TLSSocket } from "tls";
import * as undici from "undici";
import { interceptors } from "undici";
import { CookieJar } from "tough-cookie";
import { cookie } from "http-cookie-agent/undici";
import IPAddr from "ipaddr.js";
export class InsecureConnectionError extends Error {
  constructor() {
    super("Connection violated security rules.");
  }
}

export function isIPPrivate(address: string): boolean {
  if (!IPAddr.isValid(address)) return false;

  const addr = IPAddr.parse(address);
  return addr.range() !== "unicast";
}

// LOCAL CHANGE — PROXY_SERVER accepts a comma-separated list, not just one proxy.
//
// This dispatcher backs every direct-download engine in this container: fetch, pdf,
// document and image (all of them route through getSecureDispatcher, see downloadFile.ts).
// That includes /v2/map's own sitemap fetch, which made a single proxy a real bottleneck:
// during a 159-source rescan every sitemap fetch went through one residential exit, which
// throttled and produced "Sitemap fetch aborted", collapsing sources to a shallow homepage
// fallback (marketforcesafrica 22,002 -> 26 links). Spreading that across a pool fixes the
// concentration, not just the reliability of any one proxy.
//
// A single value still parses as a 1-element list, so existing deployments are unaffected,
// and an unset PROXY_SERVER still yields a plain no-proxy Agent exactly as before. The
// format matches RESIDENTIAL_PROXY_URL's existing convention so both vars are configured
// the same way. Per-entry credentials belong in the URL (http://user:pass@host:port);
// PROXY_USERNAME/PROXY_PASSWORD still apply to every entry as a shared fallback.
export function parseProxyServers(raw?: string): string[] {
  return (raw ?? "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
}

function createBaseAgent(skipTlsVerification: boolean, proxyServer?: string) {
  const baseAgent = proxyServer
    ? new undici.ProxyAgent({
        uri: proxyServer.includes("://") ? proxyServer : "http://" + proxyServer,
        token: config.PROXY_USERNAME
          ? `Basic ${Buffer.from(config.PROXY_USERNAME + ":" + (config.PROXY_PASSWORD ?? "")).toString("base64")}`
          : undefined,
        requestTls: {
          rejectUnauthorized: !skipTlsVerification, // Only bypass SSL verification if explicitly requested
        },
      })
    : new undici.Agent({
        connect: {
          rejectUnauthorized: !skipTlsVerification, // Only bypass SSL verification if explicitly requested
        },
      });

  // Add redirect interceptor for handling redirects
  return baseAgent.compose(interceptors.redirect({ maxRedirections: 5000 }));
}

function attachSecurityCheck(agent: undici.Dispatcher) {
  agent.on("connect", (_, targets) => {
    const client: undici.Client = targets.slice(-1)[0] as undici.Client;
    const socketSymbol = Object.getOwnPropertySymbols(client).find(
      x => x.description === "socket",
    )!;
    const socket: Socket | TLSSocket = (client as any)[socketSymbol];

    if (
      socket.remoteAddress &&
      isIPPrivate(socket.remoteAddress) &&
      config.ALLOW_LOCAL_WEBHOOKS !== true
    ) {
      socket.destroy(new InsecureConnectionError());
    }
  });
}

function makeSecureDispatcher(
  skipTlsVerification: boolean,
  proxyServer?: string,
) {
  const agent = createBaseAgent(skipTlsVerification, proxyServer);
  attachSecurityCheck(agent);
  return agent;
}

// Dispatcher WITHOUT cookie handling (for webhooks - avoids empty cookie header bug)
function makeSecureDispatcherNoCookies(
  skipTlsVerification: boolean,
  proxyServer?: string,
) {
  const agent = createBaseAgent(skipTlsVerification, proxyServer);
  attachSecurityCheck(agent);
  return agent;
}

// One dispatcher per configured proxy, built once at module load exactly as the single
// dispatcher was. With PROXY_SERVER unset the list is [undefined] — a one-element pool
// holding the same plain no-proxy Agent this module has always produced.
const proxyServers = parseProxyServers(config.PROXY_SERVER);
const proxySlots: (string | undefined)[] =
  proxyServers.length > 0 ? proxyServers : [undefined];

const secureDispatchers = proxySlots.map(p => makeSecureDispatcher(false, p));
const secureDispatchersSkipTlsVerification = proxySlots.map(p =>
  makeSecureDispatcher(true, p),
);
const secureDispatchersNoCookies = proxySlots.map(p =>
  makeSecureDispatcherNoCookies(false, p),
);
const secureDispatchersNoCookiesSkipTlsVerification = proxySlots.map(p =>
  makeSecureDispatcherNoCookies(true, p),
);

// Round-robin across the pool. Deliberately not sticky-per-domain the way trawl's own
// ProxyPool is: getSecureDispatcher only receives skipTlsVerification, not the target
// domain, and threading a domain through every call site is a larger change than this
// path needs. These are mostly one-shot fetches (sitemaps, robots.txt, PDFs) where
// cookie continuity across requests does not matter the way it does for a browser tier.
let dispatcherCursor = 0;
function pickRoundRobin<T>(pool: T[]): T {
  const picked = pool[dispatcherCursor % pool.length];
  dispatcherCursor = (dispatcherCursor + 1) % pool.length;
  return picked;
}

export const getSecureDispatcher = (skipTlsVerification: boolean = false) => {
  const dispatcher = pickRoundRobin(
    skipTlsVerification
      ? secureDispatchersSkipTlsVerification
      : secureDispatchers,
  );

  return dispatcher.compose(cookie({ jar: new CookieJar() }));
};

// Use this for webhook delivery to avoid sending empty cookie headers
export const getSecureDispatcherNoCookies = (
  skipTlsVerification: boolean = false,
) =>
  pickRoundRobin(
    skipTlsVerification
      ? secureDispatchersNoCookiesSkipTlsVerification
      : secureDispatchersNoCookies,
  );
