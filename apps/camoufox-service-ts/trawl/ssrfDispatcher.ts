// Gives tiers/1.ts (a plain fetch(), no browser involved) the same SSRF protection the
// browser-backed tiers get from pool.ts's DEFAULT_EGRESS_PROXY -- both ultimately route
// through the one local SSRF-guard proxy started in api.ts (startSSRFProxy), so there is
// a single place that validates a connection's resolved IP, not two parallel
// implementations that could quietly drift apart.
import * as undici from "undici"

let defaultProxyUrl: string | undefined
const dispatcherCache = new Map<string, undici.Dispatcher>()

export function setDefaultFetchProxy(proxyUrl: string): void {
  defaultProxyUrl = proxyUrl
}

// An explicit proxy (Tier 1's own datacenter/residential override, when the orchestrator
// passes one) always wins outright -- same "explicit beats default" rule pool.ts's
// newFreshContext applies, and for the same reason: chaining our SSRF proxy in front of
// a caller-supplied proxy isn't something most proxy providers support.
//
// `insecure` mirrors the browser tiers' skipTlsVerification. It only ever relaxes
// certificate checking; the proxy still validates the resolved IP of every connection,
// so this cannot be used to reach an internal address.
export function getFetchDispatcher(
  explicitProxyUrl?: string,
  insecure?: boolean,
): undici.Dispatcher | undefined {
  const target = explicitProxyUrl ?? defaultProxyUrl
  if (!target && !insecure) return undefined
  const cacheKey = `${target ?? ""}|${insecure ? "insecure" : "secure"}`
  let dispatcher = dispatcherCache.get(cacheKey)
  if (!dispatcher) {
    const tls = insecure ? { rejectUnauthorized: false } : undefined
    dispatcher = target
      ? new undici.ProxyAgent({ uri: target, ...(tls ? { requestTls: tls } : {}) })
      : new undici.Agent({ connect: tls })
    dispatcherCache.set(cacheKey, dispatcher)
  }
  return dispatcher
}
