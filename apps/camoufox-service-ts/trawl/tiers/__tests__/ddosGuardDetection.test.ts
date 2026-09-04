import { describe, expect, test } from "vitest"
import {
  detectChallengeType,
  hasDdosGuardChallenge,
  isBlocked,
  isChallengeWall,
  isCloudflarePage,
  needsJs,
} from "../utils/detect"
import { DDOS_GUARD_INTERSTITIAL } from "./fixtures/ddosGuard"

describe("DDoS-Guard detection", () => {
  test("classifies a real interstitial independently from Cloudflare", () => {
    expect(hasDdosGuardChallenge(DDOS_GUARD_INTERSTITIAL)).toBe(true)
    expect(detectChallengeType(DDOS_GUARD_INTERSTITIAL)).toBe("ddos-guard")
    expect(isCloudflarePage(DDOS_GUARD_INTERSTITIAL, {})).toBe(false)
    expect(needsJs(DDOS_GUARD_INTERSTITIAL, {})).toBe(true)
    expect(isBlocked(200, DDOS_GUARD_INTERSTITIAL)).toBe(true)
    expect(isChallengeWall(200, DDOS_GUARD_INTERSTITIAL.length, "ddos-guard")).toBe(true)
  })

  test("does not classify an ordinary page from a DDoS-Guard-fronted server", () => {
    const html = "<html><title>Books</title><body>Search results</body></html>"
    expect(detectChallengeType(html, { Server: "ddos-guard" })).toBe("none")
  })

  test("does not classify a bare provider-domain mention", () => {
    expect(detectChallengeType("<p>Protected by ddos-guard.net</p>")).toBe("none")
  })

  test("lets the authoritative Cloudflare header win", () => {
    const headers = { "CF-Mitigated": "Challenge" }
    expect(detectChallengeType(DDOS_GUARD_INTERSTITIAL, headers)).toBe("cloudflare-interstitial")
    expect(isCloudflarePage(DDOS_GUARD_INTERSTITIAL, headers)).toBe(true)
  })
})
