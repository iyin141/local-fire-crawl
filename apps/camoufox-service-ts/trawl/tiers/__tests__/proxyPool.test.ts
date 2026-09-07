import { afterEach, describe, expect, test } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ProxyPool } from "../utils/proxyRotator"

describe("ProxyPool", () => {
  test("round-robins across proxies for different domains", () => {
    const pool = new ProxyPool(["http://p1:8080", "http://p2:8080", "http://p3:8080"])
    const picks = [pool.next("a.com"), pool.next("b.com"), pool.next("c.com"), pool.next("d.com")]
    // 3 proxies, 4 picks (one new domain each) — round-robin wraps back to the first proxy
    expect(picks).toEqual(["http://p1:8080", "http://p2:8080", "http://p3:8080", "http://p1:8080"])
  })

  test("is sticky per-domain on repeat calls", () => {
    const pool = new ProxyPool(["http://p1:8080", "http://p2:8080"])
    const first = pool.next("example.com")
    for (let i = 0; i < 5; i++) {
      expect(pool.next("example.com")).toBe(first)
    }
  })

  test("markBad excludes the proxy and clears its sticky mapping", () => {
    const pool = new ProxyPool(["http://p1:8080", "http://p2:8080"])
    const first = pool.next("example.com")
    expect(first).toBeTruthy()

    pool.markBad(first as string)

    // Same domain must get a different proxy now (sticky mapping to the bad one was cleared)
    const after = pool.next("example.com")
    expect(after).not.toBe(first)
    expect(after).toBeTruthy()
  })

  test("returns undefined once every proxy is marked bad", () => {
    const pool = new ProxyPool(["http://p1:8080", "http://p2:8080"])
    pool.markBad("http://p1:8080")
    pool.markBad("http://p2:8080")
    expect(pool.next("example.com")).toBeUndefined()
    expect(pool.random()).toBeUndefined()
  })

  test("random() returns one of the configured proxies", () => {
    const urls = ["http://p1:8080", "http://p2:8080", "http://p3:8080"]
    const pool = new ProxyPool(urls)
    for (let i = 0; i < 20; i++) {
      expect(urls).toContain(pool.random())
    }
  })

  test("returns undefined for an empty pool", () => {
    const pool = new ProxyPool([])
    expect(pool.next()).toBeUndefined()
    expect(pool.random()).toBeUndefined()
    expect(pool.size).toBe(0)
  })

  describe("fromEnv", () => {
    let tmpDir: string | undefined

    afterEach(() => {
      if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
      tmpDir = undefined
    })

    test("parses a single proxy URL", () => {
      const pool = ProxyPool.fromEnv("http://p1:8080")
      expect(pool?.size).toBe(1)
    })

    test("parses a comma-separated list, trimming whitespace and dropping empties", () => {
      const pool = ProxyPool.fromEnv(" http://p1:8080 , http://p2:8080,,http://p3:8080 ")
      expect(pool?.size).toBe(3)
    })

    test("returns undefined when neither source has any proxies", () => {
      expect(ProxyPool.fromEnv()).toBeUndefined()
      expect(ProxyPool.fromEnv("", "")).toBeUndefined()
    })

    test("reads proxies from a line-delimited file, ignoring comments and blank lines", () => {
      tmpDir = mkdtempSync(join(tmpdir(), "trawl-proxy-test-"))
      const file = join(tmpDir, "proxies.txt")
      writeFileSync(file, "http://p1:8080\n# a comment\n\nhttp://p2:8080\n")
      const pool = ProxyPool.fromEnv(undefined, file)
      expect(pool?.size).toBe(2)
    })

    test("merges the env-var list and the file list", () => {
      tmpDir = mkdtempSync(join(tmpdir(), "trawl-proxy-test-"))
      const file = join(tmpDir, "proxies.txt")
      writeFileSync(file, "http://p2:8080\n")
      const pool = ProxyPool.fromEnv("http://p1:8080", file)
      expect(pool?.size).toBe(2)
    })
  })
})

// LOCAL CHANGE — voluntary sticky handoff (quantum + rest).
//
// The failure-driven cooldown already covered "this proxy broke, stop using it." These cover
// the opposite case: a proxy that is working fine but has held one domain long enough that
// the permanence itself is the risk. Defaults are off, so the first test here is really a
// regression guard on every existing deployment that sets neither env var.
describe("ProxyPool voluntary handoff", () => {
  test("with no quantum configured, a healthy pairing is sticky forever (unchanged behavior)", () => {
    const pool = new ProxyPool(["http://p1:8080", "http://p2:8080"])
    const first = pool.next("example.com")
    for (let i = 0; i < 20; i++) {
      expect(pool.next("example.com")).toBe(first)
    }
  })

  test("hands the domain off once the quantum is spent", () => {
    // quantum 0 => every call is already past it, which is the cleanest way to assert the
    // handoff branch fires without sleeping in a test.
    const pool = new ProxyPool(["http://p1:8080", "http://p2:8080"], { quantumMs: 0 })
    const first = pool.next("example.com")
    const second = pool.next("example.com")
    expect(second).not.toBe(first)
  })

  test("a handed-off pairing sits out the rest period on that domain", () => {
    // quantumMs 0 means every call hands off, so each call burns one proxy into rest.
    // Stay within the pool size: with 4 proxies, 4 picks all still have an unrested option.
    // (Going past that hits the deliberate "fall back rather than return nothing" branch,
    // which has its own test below — that is not a rest-period failure.)
    const pool = new ProxyPool(
      ["http://p1:8080", "http://p2:8080", "http://p3:8080", "http://p4:8080"],
      { quantumMs: 0, restMs: 60_000 },
    )
    const picks = [
      pool.next("example.com"),
      pool.next("example.com"),
      pool.next("example.com"),
      pool.next("example.com"),
    ]
    // No repeats while unrested proxies remain — each handoff genuinely moved on.
    expect(new Set(picks).size).toBe(4)
  })

  test("rest is scoped to the pairing, not the proxy — other domains can still use it", () => {
    const pool = new ProxyPool(["http://p1:8080", "http://p2:8080"], {
      quantumMs: 0,
      restMs: 60_000,
    })
    const first = pool.next("a.com") as string
    pool.next("a.com") // forces the handoff, putting (a.com|first) to rest

    // `first` is resting for a.com only. b.com may legitimately be assigned it.
    const seenForB = new Set<string>()
    for (let i = 0; i < 6; i++) seenForB.add(pool.next("b.com") as string)
    expect(seenForB.has(first)).toBe(true)
  })

  test("falls back to a resting proxy rather than returning nothing", () => {
    // Single-proxy pool with rest enabled: after the handoff there is no unrested option
    // left, and returning undefined here would strand the caller with no proxy at all.
    const pool = new ProxyPool(["http://only:8080"], { quantumMs: 0, restMs: 60_000 })
    expect(pool.next("example.com")).toBe("http://only:8080")
    expect(pool.next("example.com")).toBe("http://only:8080")
  })

  test("markBad still clears a sticky mapping under the new shape", () => {
    const pool = new ProxyPool(["http://p1:8080", "http://p2:8080"], { quantumMs: 60_000 })
    const first = pool.next("example.com") as string
    pool.markBad(first)
    expect(pool.next("example.com")).not.toBe(first)
  })
})
