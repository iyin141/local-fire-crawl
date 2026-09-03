// Wires environment config -> trawl's OrchestratorDeps, mirroring what trawl's own
// apps/api/src/{config,deps}.ts do for its standalone FlareSolverr-shaped server -- we
// don't run that server (see docker-compose.yaml's comment on camoufox-service), only
// its packages/browser + packages/tiers, driving them from this service's own /scrape
// route instead. Two differences from trawl's own wiring, both deliberate:
//   - REDIS_URL defaults to Firecrawl's existing `redis` service, not a second instance.
//   - setDefaultEgressProxy/setDefaultFetchProxy point every tier at the SSRF-guard
//     proxy this service already runs, which trawl's own deploy model doesn't need.
import { BrowserPool, SessionCache, setDefaultEgressProxy } from "./trawl/browser"
import type { AcquireOptions, OrchestratorDeps } from "./trawl/tiers"
import { ProxyPool } from "./trawl/tiers"
import type { SessionData } from "./trawl/types"
import { setDefaultFetchProxy } from "./trawl/ssrfDispatcher"

const REDIS_URL = process.env.REDIS_URL ?? "redis://redis:6379"
const POOL_SIZE = Number(process.env.BROWSER_POOL_SIZE ?? "3")
const ACQUIRE_TIMEOUT_MS = Number(process.env.BROWSER_ACQUIRE_TIMEOUT_MS ?? "15000")
const SESSION_TTL = Number(process.env.SESSION_TTL_SECONDS ?? "3600")
const RECYCLE_AFTER_TEMPORARY_CONTEXTS = Number(process.env.BROWSER_RECYCLE_AFTER_CONTEXTS ?? "8")
const CONTENT_PROCESSES = Number(process.env.BROWSER_CONTENT_PROCESSES ?? "2")
const HEADFUL_POOL_SIZE = Number(process.env.BROWSER_HEADFUL_POOL_SIZE ?? "0")
const STALL_TIMEOUT_MS = Number(process.env.BROWSER_STALL_TIMEOUT_MS ?? "180000")
const CLOSE_TIMEOUT_MS = Number(process.env.BROWSER_CLOSE_TIMEOUT_MS ?? "10000")
const LAUNCH_TIMEOUT_MS = Number(process.env.BROWSER_LAUNCH_TIMEOUT_MS ?? "90000")

// PROXY_URL / RESIDENTIAL_PROXY_URL: comma-separated list of proxy URLs (a single URL
// still works, it's just a 1-element list). *_LIST_FILE is an alternative source (one
// proxy per line) for lists too large for an env var. Same names trawl's own config.ts
// uses, so any existing ops docs/expectations for them carry over unchanged. Both are
// optional -- unset means Tier 3/4's proxy escalation simply never has a pool proxy to
// reach for and falls through, same as today.
const proxyPool = ProxyPool.fromEnv(process.env.PROXY_URL, process.env.PROXY_LIST_FILE)
const residentialProxyPool = ProxyPool.fromEnv(
  process.env.RESIDENTIAL_PROXY_URL,
  process.env.RESIDENTIAL_PROXY_LIST_FILE,
)

const state: {
  pool?: BrowserPool
  headfulPool?: BrowserPool
  sessionCache?: SessionCache
}= {}

const handleOwners = new WeakMap<object, BrowserPool>()

// Called once from api.ts's start(), after startSSRFProxy() resolves a port -- everything
// below (the pool, tier1's plain fetch) defaults through that proxy unless a request
// supplies its own datacenter/residential proxy.
export function wireSsrfProxy(ssrfProxyUrl: string): void {
  setDefaultEgressProxy(ssrfProxyUrl)
  setDefaultFetchProxy(ssrfProxyUrl)
}

const initSessionCache = async (): Promise<void> => {
  try {
    const sessionCache = new SessionCache({ redisUrl: REDIS_URL, ttlSeconds: SESSION_TTL })
    await sessionCache.connect()
    state.sessionCache = sessionCache
    console.log("[trawl-deps] session cache connected (Tier 2 fast-path enabled)")
  } catch (err) {
    state.sessionCache = undefined
    console.warn("[trawl-deps] session cache unavailable -- Tier 2 disabled:", err instanceof Error ? err.message : err)
  }
}

export const initTrawlPool = async (): Promise<void> => {
  const pool = new BrowserPool({
    poolSize: POOL_SIZE,
    acquireTimeoutMs: ACQUIRE_TIMEOUT_MS,
    recycleAfterTemporaryContexts: RECYCLE_AFTER_TEMPORARY_CONTEXTS,
    contentProcesses: CONTENT_PROCESSES,
    stallAfterMs: STALL_TIMEOUT_MS,
    closeTimeoutMs: CLOSE_TIMEOUT_MS,
    launchTimeoutMs: LAUNCH_TIMEOUT_MS,
  })

  state.headfulPool = undefined
  if (HEADFUL_POOL_SIZE > 0) {
    state.headfulPool = new BrowserPool({
      poolSize: HEADFUL_POOL_SIZE,
      acquireTimeoutMs: ACQUIRE_TIMEOUT_MS,
      recycleAfterTemporaryContexts: RECYCLE_AFTER_TEMPORARY_CONTEXTS,
      contentProcesses: CONTENT_PROCESSES,
      virtualDisplay: true,
      label: "pool:headful",
      stallAfterMs: STALL_TIMEOUT_MS,
      closeTimeoutMs: CLOSE_TIMEOUT_MS,
      launchTimeoutMs: LAUNCH_TIMEOUT_MS,
    })
  }
  state.pool = pool

  try {
    await Promise.all([initSessionCache(), pool.init()])
    pool.startHealthCheck()
    if (state.headfulPool) {
      await state.headfulPool.init()
      state.headfulPool.startHealthCheck()
      console.log(`[trawl-deps] headful pool warm (${HEADFUL_POOL_SIZE} browser${HEADFUL_POOL_SIZE === 1 ? "" : "s"})`)
    }
  } catch (error) {
    await Promise.all([pool.shutdown(), state.headfulPool?.shutdown()])
    throw error
  }

  console.log(`[trawl-deps] ready -- all ${POOL_SIZE} browser${POOL_SIZE === 1 ? "" : "s"} warm`)
}

export const shutdownTrawlPool = async (): Promise<void> => {
  await Promise.all([state.pool?.shutdown(), state.headfulPool?.shutdown()])
}

export const getTrawlDeps = (): OrchestratorDeps => {
  if (!state.pool) throw new Error("trawl browser pool not ready")
  const p = state.pool
  return {
    acquireBrowser: async (domain: string, budgetMs?: number, options?: AcquireOptions) => {
      if (options?.headful) {
        const headful = state.headfulPool
        if (!headful) throw new Error("DataDome escalation requires BROWSER_HEADFUL_POOL_SIZE greater than 0")
        const handle = await headful.acquire(domain, budgetMs)
        handleOwners.set(handle, headful)
        return handle
      }
      const handle = await p.acquire(domain, budgetMs)
      handleOwners.set(handle, p)
      return handle
    },
    releaseBrowser: (handle) => {
      handleOwners.get(handle)?.release(handle.id, handle.lease)
      handleOwners.delete(handle)
    },
    loadSession: (domain: string) =>
      state.sessionCache ? state.sessionCache.load(domain).catch(() => undefined) : Promise.resolve(undefined),
    saveSession: (domain: string, data: SessionData) =>
      state.sessionCache ? state.sessionCache.save(domain, data).catch(() => {}) : Promise.resolve(),
    invalidateSession: (domain: string) =>
      state.sessionCache ? state.sessionCache.invalidate(domain).catch(() => {}) : Promise.resolve(),
    proxyPool,
    residentialProxyPool,
  }
}
