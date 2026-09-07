// Proxy pool with sticky-per-domain routing, round-robin fallback, and failure cooldown.
// Sourced from a user-supplied comma-separated list or line-delimited file — TRAWL never
// fetches or trusts any third-party proxy list.

import { readFileSync } from "node:fs"

const COOLDOWN_MS = 5 * 60 * 1000 // 5 minutes — matches the plan's "time-boxed cooldown"

// LOCAL CHANGE — voluntary sticky handoff, on top of the failure-driven cooldown above.
//
// Sticky-per-domain (see next()) pins one proxy to a domain and keeps it there until that
// proxy *fails*. That is right for challenge/cookie continuity but wrong over long horizons:
// a residential IP that never changes while hitting the same WAF-protected site for weeks is
// itself an anomaly. Real residential addresses churn — mobile carriers reassign on every
// data toggle, home broadband on lease renewal — so permanence is a signal, not camouflage.
//
// QUANTUM is the classic round-robin *time slice*, applied per (domain, proxy) pairing: hold
// the pairing for this long, then hand the domain off to another proxy even though nothing
// went wrong. Time-based rather than request-count based on purpose — the thing that looks
// unnatural is calendar staticness, and a lightly-scraped source could sit on one IP for
// weeks while never reaching any plausible request-count threshold.
//
// REST then keeps that domain off that specific proxy for a while after handoff, so the
// handoff is a real break rather than an immediate bounce-back. It is scoped to the pairing,
// not the proxy: a rested proxy stays immediately available to every *other* domain.
//
// Both default to disabled. Unset env => QUANTUM Infinity and REST 0 => next() behaves
// exactly as it did before this change, which is what keeps local/unproxied runs unaffected.
function minutesFromEnv(raw: string | undefined, fallbackMs: number): number {
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed * 60 * 1000 : fallbackMs
}

const DOMAIN_QUANTUM_MS = minutesFromEnv(process.env.PROXY_DOMAIN_QUANTUM_MINUTES, Infinity)
const DOMAIN_REST_MS = minutesFromEnv(process.env.PROXY_DOMAIN_REST_MINUTES, 0)

// Normalizes the per-request `proxy` field at the API boundary into a single URL string.
// Prowlarr's Cardigann flow serializes proxy config as an object {url, username, password};
// other callers send a plain URL string. Playwright's `newContext({proxy})` expects
// `server` to be a string — passing the object through untyped crashes with
// `proxy.server: expected string, got object` (issue #12).
//
// Returns undefined for null/undefined/empty/non-string-non-object inputs.
// Credentials (if present in the object form) are URL-encoded and embedded into the URL
// so downstream code keeps treating proxy as a single string.
export function normalizeProxy(input?: unknown) {
  if (input == null) return
  if (typeof input === "string") {
    const trimmed = input.trim()
    return trimmed ? trimmed : undefined
  }
  if (typeof input === "object" && input) {
    const endpoint = input as Record<string, unknown>
    const server =
      typeof endpoint.url === "string"
        ? endpoint.url
        : typeof endpoint.server === "string"
          ? endpoint.server
          : undefined
    if (!server) return
    const user = typeof endpoint.username === "string" && endpoint.username.length > 0 ? endpoint.username : undefined
    const pass = typeof endpoint.password === "string" && endpoint.password.length > 0 ? endpoint.password : undefined
    if (!user && !pass) return server
    const schemeMatch = server.match(/^([a-z][a-z0-9+\-.]*:\/\/)(.*)$/i)
    if (!schemeMatch) return server
    const creds = `${encodeURIComponent(user ?? "")}:${encodeURIComponent(pass ?? "")}`
    return `${schemeMatch[1]}${creds}@${schemeMatch[2]}`
  }
  return
}

interface ProxyState {
  url: string
  badUntil: number
}

export class ProxyPool {
  private proxies: ProxyState[]
  private cursor = 0
  // Carries assignedAt so next() can tell when a pairing has outlived the quantum.
  private stickyByDomain = new Map<string, { url: string; assignedAt: number }>()
  // `${domain}|${url}` -> timestamp until which that pairing is off-limits after a handoff.
  private restUntil = new Map<string, number>()
  private quantumMs: number
  private restMs: number

  // quantumMs/restMs default to the env-derived values above. They are constructor options
  // rather than direct reads of those consts so tests can exercise handoff and rest without
  // reloading the module — the env is read once at import, which a test cannot vary.
  constructor(urls: string[], opts?: { quantumMs?: number; restMs?: number }) {
    this.proxies = urls.filter(Boolean).map((url) => ({ url, badUntil: 0 }))
    this.quantumMs = opts?.quantumMs ?? DOMAIN_QUANTUM_MS
    this.restMs = opts?.restMs ?? DOMAIN_REST_MS
  }

  // Builds a pool from a comma-separated env var and/or a line-delimited file (one proxy
  // per line, '#' comments allowed). A single URL still works — it's just a 1-element list.
  // Returns undefined if neither source yields any proxies, so callers can treat "no proxy
  // configured" the same way they did with the old single-string PROXY_URL/RESIDENTIAL_PROXY_URL.
  static fromEnv(urlListEnv?: string, fileEnv?: string) {
    const urls: string[] = []
    if (urlListEnv) {
      urls.push(
        ...urlListEnv
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      )
    }
    if (fileEnv) {
      try {
        const lines = readFileSync(fileEnv, "utf-8")
          .split("\n")
          .map((s) => s.trim())
          .filter((s) => s && !s.startsWith("#"))
        urls.push(...lines)
      } catch (err) {
        console.warn(`[proxy] failed to read proxy list file ${fileEnv}:`, err instanceof Error ? err.message : err)
      }
    }
    return urls.length > 0 ? new ProxyPool(urls) : undefined
  }

  get size(): number {
    return this.proxies.length
  }

  private available(): ProxyState[] {
    const now = Date.now()
    return this.proxies.filter((p) => p.badUntil <= now)
  }

  // Sticky-per-domain: reuse the same proxy for repeat requests to a domain (consistency
  // helps avoid re-triggering challenges); falls back to round-robin across available
  // proxies for new domains or once the sticky proxy has been marked bad.
  //
  // A pairing is also released once it outlives DOMAIN_QUANTUM_MS, even while healthy —
  // see that constant for why permanence is its own risk. Released pairings then sit out
  // DOMAIN_REST_MS before they can be picked again for that same domain. With both unset
  // (the default) neither branch can fire and this is the original round-robin exactly.
  next(domain?: string) {
    const available = this.available()
    if (available.length === 0) return
    const now = Date.now()

    if (domain) {
      const sticky = this.stickyByDomain.get(domain)
      if (sticky && available.some((p) => p.url === sticky.url)) {
        if (now - sticky.assignedAt < this.quantumMs) return sticky.url
        // Quantum spent: hand the domain off and keep it off this proxy for a while.
        this.stickyByDomain.delete(domain)
        if (this.restMs > 0) {
          this.restUntil.set(`${domain}|${sticky.url}`, now + this.restMs)
        }
      }
    }

    // Prefer proxies not currently resting for this domain. If every available proxy is
    // resting (small pool, short quantum, long rest), fall back to the full set rather
    // than returning nothing — a suboptimal proxy beats no proxy and a failed fetch.
    const eligible = domain
      ? available.filter((p) => (this.restUntil.get(`${domain}|${p.url}`) ?? 0) <= now)
      : available
    const pickFrom = eligible.length > 0 ? eligible : available

    const proxy = pickFrom[this.cursor % pickFrom.length]
    this.cursor = (this.cursor + 1) % pickFrom.length
    if (domain) this.stickyByDomain.set(domain, { url: proxy.url, assignedAt: now })
    return proxy.url
  }

  random() {
    const available = this.available()
    if (available.length === 0) return
    return available[Math.floor(Math.random() * available.length)].url
  }

  // Puts a proxy in cooldown after a tier reports "blocked"/"ip-blocked" for it — skipped
  // by next()/random() until the cooldown expires. Also drops any sticky-domain mapping
  // pointing at it so the next call for that domain picks a different proxy.
  markBad(url: string): void {
    const entry = this.proxies.find((p) => p.url === url)
    if (entry) entry.badUntil = Date.now() + COOLDOWN_MS
    for (const [domain, sticky] of this.stickyByDomain) {
      if (sticky.url === url) this.stickyByDomain.delete(domain)
    }
  }
}
