import { describe, expect, it, vi } from "vitest";

// This deployment's local dev environment does not have the native Rust
// binding built (a pre-existing gap: several other engine test files hit the
// same "Failed to resolve entry for package @mendable/firecrawl-rs" error).
// playwrightMaxReasonableTime does not touch it, so mock it out rather than
// pull in a native build step for one unrelated import in the same file.
vi.mock("@mendable/firecrawl-rs", () => ({ getInnerJson: vi.fn() }));

import { playwrightMaxReasonableTime } from "../index";
import type { Meta } from "../../..";

// LOCAL TEST for a LOCAL CHANGE. This used to be a flat `waitFor + 30000`,
// which raced camoufox-service out of the waterfall on any Cloudflare solve
// slower than ~30s and pivoted to pdf/document -- engines that cannot render
// HTML at all. Observed live on vfdgroup.com: identical requests flipped
// between success and failure purely on which side of the 30s line the
// Turnstile solve landed, because nothing on this deployment can substitute
// for playwright/camoufox on an HTML page.
//
// The budget now tracks meta.abort.scrapeTimeout(), the same number already
// sent to camoufox-service as `timeout` in the POST body, so the waterfall
// clock and the engine's own deadline agree.

const fakeMeta = (scrapeTimeout: number | undefined): Meta =>
  ({
    abort: { scrapeTimeout: () => scrapeTimeout },
  }) as unknown as Meta;

describe("playwrightMaxReasonableTime", () => {
  it("tracks the request's own scrape timeout rather than a flat 30s", () => {
    expect(playwrightMaxReasonableTime(fakeMeta(300000))).toBe(300000);
    expect(playwrightMaxReasonableTime(fakeMeta(120000))).toBe(120000);
  });

  it("falls back to the platform default when no timeout was requested", () => {
    // Mirrors the "Scrape timed out due to maximum length of 5 minutes"
    // default used elsewhere when meta.abort.scrapeTimeout() is undefined.
    expect(playwrightMaxReasonableTime(fakeMeta(undefined))).toBe(300000);
  });

  it("a slow Cloudflare solve now fits inside the waterfall window", () => {
    // The observed live solve times were 18-42s. The old 30000ms constant
    // sat inside that range; the fixed budget must not.
    const observedSolveTimes = [18000, 26000, 32000, 41930];
    const budget = playwrightMaxReasonableTime(fakeMeta(300000));
    for (const solveTime of observedSolveTimes) {
      expect(budget).toBeGreaterThan(solveTime);
    }
  });
});
