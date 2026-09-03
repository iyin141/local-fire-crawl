import type { SessionData } from "../types"
// Bun's built-in RedisClient (trawl's own runtime) has no Node equivalent, so this uses
// ioredis instead -- same public shape this class exposes (connect/save/load/invalidate)
// is unchanged, only the client underneath. Shares Firecrawl's existing `redis` container
// (REDIS_URL) rather than standing up a second Redis; see api.ts for the session:* key
// namespace check against Firecrawl's own key prefixes before this was wired in.
import Redis from "ioredis"

export class SessionCache {
  private redis: Redis
  private ttl: number

  constructor({ redisUrl, ttlSeconds }: { redisUrl: string; ttlSeconds: number }) {
    // lazyConnect: connect() below controls exactly when the connection attempt
    // happens (and its timeout), matching the Bun RedisClient version's behavior --
    // ioredis's default is to connect immediately in the constructor instead.
    this.redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 })
    this.ttl = ttlSeconds
  }

  async connect(timeoutMs = 1_000): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        this.redis.connect(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Redis connection timed out after ${timeoutMs}ms`)), timeoutMs)
        }),
      ])
    } catch (error) {
      this.redis.disconnect()
      throw error
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private key(domain: string): string {
    return `session:${domain}`
  }

  async save(domain: string, data: SessionData): Promise<void> {
    await this.redis.set(this.key(domain), JSON.stringify(data), "EX", this.ttl)
  }

  async load(domain: string) {
    const raw = await this.redis.get(this.key(domain))
    if (!raw) return
    try {
      return JSON.parse(raw) as SessionData
    } catch {
      return
    }
  }

  async invalidate(domain: string): Promise<void> {
    await this.redis.del(this.key(domain))
  }
}
