import { describe, expect, test } from "vitest"
import {
  SHELL_MAX_VISIBLE_TEXT,
  WHOLE_BODY_SCAN_LIMIT,
  bodyForDetection,
  classifyContent,
  looksLikeUnrenderedShell,
  warrantsBrowserRetry,
} from "../classify"
import {
  IMPERVA_FIXTURE_STATUS,
  IMPERVA_MARKER_OFFSET,
  IMPERVA_PARDON_OUR_INTERRUPTION,
  TIER1_DETECTION_PREVIEW_BYTES,
} from "../../trawl/tiers/__tests__/fixtures/imperva"

describe("window policy", () => {
  test("a small body is scanned whole, so a marker past Tier 1's preview is still seen", () => {
    // The whole point: this is the case Tier 1 misses.
    expect(IMPERVA_MARKER_OFFSET).toBeGreaterThan(TIER1_DETECTION_PREVIEW_BYTES)
    expect(IMPERVA_PARDON_OUR_INTERRUPTION.length).toBeLessThan(WHOLE_BODY_SCAN_LIMIT)
    expect(bodyForDetection(IMPERVA_PARDON_OUR_INTERRUPTION)).toBe(IMPERVA_PARDON_OUR_INTERRUPTION)
  })

  test("a very large body is still bounded, so huge pages are not scanned end to end", () => {
    const huge = `${"x".repeat(WHOLE_BODY_SCAN_LIMIT + 5000)}`
    expect(bodyForDetection(huge).length).toBe(WHOLE_BODY_SCAN_LIMIT)
  })
})

describe("the zenithbank Imperva interstitial", () => {
  test("is classified as a challenge, not as content", () => {
    const verdict = classifyContent(IMPERVA_PARDON_OUR_INTERRUPTION, {}, IMPERVA_FIXTURE_STATUS)
    expect(verdict.kind).toBe("challenge")
    expect(verdict).toMatchObject({ waf: "imperva" })
  })

  test("warrants one retry through the browser tiers", () => {
    const verdict = classifyContent(IMPERVA_PARDON_OUR_INTERRUPTION, {}, IMPERVA_FIXTURE_STATUS)
    expect(warrantsBrowserRetry(verdict)).toBe(true)
  })

  test("is a challenge even though it is a 200 above the lean-body threshold", () => {
    // Both of the conditions that defeated isChallengeWall() still hold; the verdict
    // does not depend on either.
    expect(IMPERVA_FIXTURE_STATUS).toBe(200)
    expect(IMPERVA_PARDON_OUR_INTERRUPTION.length).toBeGreaterThan(5000)
    expect(classifyContent(IMPERVA_PARDON_OUR_INTERRUPTION, {}, 200).kind).toBe("challenge")
  })
})

describe("unrendered shell vs a genuinely small page", () => {
  // Both captured live on 2026-09-03. The real page is LARGER than the shell, which
  // is exactly why this cannot be a size check.
  const SPA_SHELL = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
    <title>Chellarams Plc</title><script type="module" crossorigin src="/assets/index.js"></script>
    </head><body><div id="root"></div></body></html>`
  const SMALL_REAL_PAGE = `<!doctype html><html><head><title>Example Domain</title></head><body>
    <div><h1>Example Domain</h1><p>This domain is for use in illustrative examples in documents.
    You may use this domain in literature without prior coordination or asking for permission.</p>
    <p><a href="https://www.iana.org/domains/example">More information...</a></p></div></body></html>`

  test("the shell is caught", () => {
    expect(looksLikeUnrenderedShell(SPA_SHELL)).toBe(true)
    expect(classifyContent(SPA_SHELL).kind).toBe("unrendered_shell")
  })

  test("the small real page is not, despite having no more bytes to spare", () => {
    expect(looksLikeUnrenderedShell(SMALL_REAL_PAGE)).toBe(false)
    expect(classifyContent(SMALL_REAL_PAGE).kind).toBe("ok")
  })

  test("a page with no scripts is never a shell, however short", () => {
    // Nothing pending means a short page is simply short.
    expect(looksLikeUnrenderedShell("<html><body><p>hi</p></body></html>")).toBe(false)
  })

  test("script-heavy real content is not a shell", () => {
    const scripts = `<script src="a.js"></script>`.repeat(30)
    const html = `<html><body>${scripts}<article>${"real words ".repeat(80)}</article></body></html>`
    expect(html.length).toBeGreaterThan(SHELL_MAX_VISIBLE_TEXT)
    expect(looksLikeUnrenderedShell(html)).toBe(false)
  })
})

describe("challenge is judged before shell", () => {
  test("an interstitial is reported as a challenge, not as a shell", () => {
    // Interstitials are thin too. Calling this a shell would send it down a retry
    // path that cannot help, and would lose the WAF's identity.
    const verdict = classifyContent(IMPERVA_PARDON_OUR_INTERRUPTION, {}, IMPERVA_FIXTURE_STATUS)
    expect(verdict.kind).toBe("challenge")
  })
})
