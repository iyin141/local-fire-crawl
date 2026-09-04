import { describe, expect, test } from "vitest"
import { detectChallengeType, hasImpervaChallenge, isBlocked, isChallengeWall } from "../utils/detect"
import {
  IMPERVA_FIXTURE_STATUS,
  IMPERVA_MARKER_OFFSET,
  IMPERVA_PARDON_OUR_INTERRUPTION,
  TIER1_DETECTION_PREVIEW_BYTES,
} from "./fixtures/imperva"

// Regression for a live miss: https://www.zenithbank.com/ came back through this
// service reporting success at Tier 1 in 451ms, with Imperva's "Pardon Our
// Interruption" interstitial as the payload instead of the bank's site.
//
// Three independent causes had to line up, and each is pinned separately below,
// because fixing any one alone still leaves the page getting through.
describe("Imperva interstitial that Tier 1 reported as success", () => {
  const html = IMPERVA_PARDON_OUR_INTERRUPTION

  test("the detectors themselves are correct when given the whole body", () => {
    // Nothing wrong with the detection logic -- this is the control.
    expect(hasImpervaChallenge(html)).toBe(true)
    expect(detectChallengeType(html)).toBe("imperva")
    expect(isBlocked(IMPERVA_FIXTURE_STATUS, html)).toBe(true)
  })

  // Cause 1: Tier 1 detects against a bounded preview (deliberately -- upstream's
  // runTier1FullBody.test.ts calls it "the 4 KiB detection preview" and it exists so
  // large bodies are not decoded just to look for markers). The marker simply falls
  // outside it, by 769 bytes.
  test("cause 1: the only marker sits past Tier 1's detection preview", () => {
    expect(IMPERVA_MARKER_OFFSET).toBeGreaterThan(TIER1_DETECTION_PREVIEW_BYTES)

    const preview = html.slice(0, TIER1_DETECTION_PREVIEW_BYTES)
    expect(hasImpervaChallenge(preview)).toBe(false)
    expect(isBlocked(IMPERVA_FIXTURE_STATUS, preview)).toBe(false)
  })

  // Cause 2: isChallengeWall() would not have graded it as a wall even with the
  // challenge type in hand -- 200 is not 403/503, imperva is not one of the
  // always-wall types, and the body is over the 5000-byte lean threshold.
  test("cause 2: it is not wall-graded even once correctly typed", () => {
    expect(IMPERVA_FIXTURE_STATUS).toBe(200)
    expect(html.length).toBeGreaterThan(5000)
    expect(isChallengeWall(IMPERVA_FIXTURE_STATUS, html.length, "imperva")).toBe(false)
  })

  // Cause 3 (no assertion possible here, recorded for the reader): isChallengeWall
  // and needsJs both have zero callers anywhere in the service, so even a correct
  // verdict from them would not have reached the tier ladder. Verified by grep at
  // the time this test was written; if that changes, this comment should go.

  // What the fix has to achieve, regardless of how it is implemented. Challenge
  // pages are inherently small -- this one is 6KB, Cloudflare interstitials ~3KB --
  // so scanning the whole body when it is small costs nothing and is what the
  // bounded preview was never meant to prevent.
  test("scanning the whole body of a small response catches it", () => {
    const SMALL_ENOUGH_TO_SCAN_WHOLE = 256 * 1024
    expect(html.length).toBeLessThan(SMALL_ENOUGH_TO_SCAN_WHOLE)
    expect(hasImpervaChallenge(html)).toBe(true)
  })
})
