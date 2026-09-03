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
export function getFetchDispatcher(explicitProxyUrl?: string): undici.Dispatcher | undefined {
  const target = explicitProxyUrl ?? defaultProxyUrl
  if (!target) return undefined
  let dispatcher = dispatcherCache.get(target)
  if (!dispatcher) {
    dispatcher = new undici.ProxyAgent(target)
    dispatcherCache.set(target, dispatcher)
  }
  return dispatcher
}
