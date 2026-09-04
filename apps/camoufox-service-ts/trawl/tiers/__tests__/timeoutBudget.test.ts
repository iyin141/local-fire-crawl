import { describe, expect, test } from "vitest"
import { scrape } from "../orchestrator"
import type { OrchestratorDeps, OrchestratorRunners } from "../orchestrator"

// LOCAL TEST for a LOCAL CHANGE. The per-tier budget was computed as
// `maxTimeout - (Date.now() - totalStart)` at six call sites and clamped at
// only two of them. Once the earlier tiers had spent the budget the value went
// negative and reached page.goto, which rejects at once with
// "Timeout -1047728ms exceeded".
//
// Seen live on aradel.com and vfdgroup.com, both Cloudflare: Tier 3 clicked
// through the Turnstile challenge and then died on a negative deadline. The
// tier that solves Cloudflare was handed less than no time to finish a solve
// it had already started, and the result surfaced as "All tiers exhausted" --
// indistinguishable from a site we genuinely cannot read.
//
// The budget is burned here in acquireBrowser, which is where it realistically
// goes: checking out a browser under load is slow, and Tier 1 runs before any
// of this. Tier 1 is not injectable, so these skip it with skipHttp.

const handle = {
  id: 1,
  lease: 1,
  context: {},
  browser: {},
  fingerprint: {
    userAgent: "ua",
    platform: "Linux x86_64",
    locale: "en-US",
    timezone: "UTC",
  },
} as never

const deps = (acquireDelayMs = 0): OrchestratorDeps =>
  ({
    acquireBrowser: async () => {
      if (acquireDelayMs > 0) {
        await new Promise(r => setTimeout(r, acquireDelayMs))
      }
      return handle
    },
    releaseBrowser: async () => {},
    loadSession: async () => undefined,
    saveSession: async () => {},
    invalidateSession: async () => {},
  }) as unknown as OrchestratorDeps

/** Tier runners that record the budget they were handed, then fail. */
const recordingRunners = (seen: number[]) =>
  ({
    tier3: async (_url: string, _h: unknown, timeout: number) => {
      seen.push(timeout)
      return { status: "error" as const, reason: "stub" }
    },
    tier4: async (_url: string, _h: unknown, timeout: number) => {
      seen.push(timeout)
      return { status: "error" as const, reason: "stub" }
    },
  }) as unknown as OrchestratorRunners

describe("per-tier timeout budget", () => {
  test("an exhausted budget reports exhaustion instead of running a doomed tier", async () => {
    const seen: number[] = []
    const err = await scrape(
      { url: "https://example.com", maxTimeout: 20, skipHttp: true },
      deps(60), // acquiring the browser outlives the whole budget
      recordingRunners(seen),
    ).then(
      () => undefined,
      (e: Error) => e,
    )

    // Before the fix this reached page.goto with a negative timeout and failed
    // as though the site were unreadable. Say what actually happened instead.
    expect(err?.message).toMatch(/exhausted/i)
    expect(seen).toHaveLength(0)
  })

  test("no tier is ever handed a negative budget", async () => {
    const seen: number[] = []
    await scrape(
      { url: "https://example.com", maxTimeout: 20, skipHttp: true },
      deps(60),
      recordingRunners(seen),
    ).catch(() => undefined)

    for (const budget of seen) {
      expect(budget).toBeGreaterThanOrEqual(0)
    }
  })

  test("a healthy budget still reaches the tiers", async () => {
    const seen: number[] = []
    await scrape(
      { url: "https://example.com", maxTimeout: 60_000, skipHttp: true },
      deps(),
      recordingRunners(seen),
    ).catch(() => undefined)

    expect(seen.length).toBeGreaterThan(0)
    for (const budget of seen) {
      expect(budget).toBeGreaterThan(0)
    }
  })
})
