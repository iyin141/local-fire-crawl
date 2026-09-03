import type { BrowserFingerprint } from "../types"

// The HTTP-level fingerprint sent with every request. Must match the actual browser
// engine (Camoufox = Firefox) or anti-bot services do UA-vs-engine cross-checks and
// flag the mismatch. Per-request the orchestrator picks one of these UAs at random
// (see `FINGERPRINT_POOL` in pool.ts).
export const FINGERPRINT = {
  // Firefox 152 (matches the pinned Camoufox 152.0.4 browser shipped in the image).
  // Three UAs — one per "OS" — so HTTP headers + browser fingerprint look consistent.
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:152.0) Gecko/20100101 Firefox/152.0",
  viewport: { width: 1920, height: 1080 },
  locale: "en-US",
  timezone: "America/New_York",
  hardwareConcurrency: 8,
  deviceMemory: 8,
} as const

// Picked from by the pool per browser-instance so HTTP headers + browser
// fingerprint (OS, navigator.platform) stay consistent.
export const FINGERPRINT_POOL: ReadonlyArray<BrowserFingerprint> = [
  {
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:152.0) Gecko/20100101 Firefox/152.0",
    platform: "Win32",
    locale: "en-US",
    timezone: "America/New_York",
  },
  {
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:152.0) Gecko/20100101 Firefox/152.0",
    platform: "MacIntel",
    locale: "en-US",
    timezone: "America/Los_Angeles",
  },
  {
    userAgent: "Mozilla/5.0 (X11; Linux x86_64; rv:152.0) Gecko/20100101 Firefox/152.0",
    platform: "Linux x86_64",
    locale: "en-US",
    timezone: "Europe/London",
  },
  {
    userAgent: "Mozilla/5.0 (X11; Linux armv8; rv:152.0) Gecko/20100101 Firefox/152.0",
    platform: "Linux armv8",
    locale: "en-US",
    timezone: "Asia/Tokyo",
  },
]
