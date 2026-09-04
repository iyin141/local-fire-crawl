import { describe, expect, test } from "vitest"
import { hasImpervaChallenge, isContentlessWall } from "../utils/detect"
import { IMPERVA_PARDON_OUR_INTERRUPTION } from "./fixtures/imperva"

// Tiers 3 and 4 declare a solved challenge "*-persistent" purely on a WAF marker being
// present. Incapsula sets visid_incap_/incap_ses_/nlbi_ and loads _Incapsula_Resource
// on pages it is serving perfectly well, so that test cannot tell a wall from a working
// protected page -- and after a solve, the working page is the expected outcome.
//
// Observed live: zenithbank.com's homepage came back from Tier 3 at 395,845 bytes with
// title "Zenith Bank - In your best interest", immediately after "[imperva] sensor
// cookie obtained", and was discarded as imperva-persistent. The challenge had been
// solved; the result was thrown away.
describe("isContentlessWall separates a wall from a served page behind the same WAF", () => {
  test("the interstitial is a wall", () => {
    expect(isContentlessWall(IMPERVA_PARDON_OUR_INTERRUPTION)).toBe(true)
  })

  test("a real page carrying the same Imperva markers is not", () => {
    // Both conditions the tiers key on hold: the markers are present and it is behind
    // Imperva. Only the amount of readable content distinguishes it.
    const realPageWithWafCookies = `<html><head><title>Zenith Bank - In your best interest</title>
      <script src="/_Incapsula_Resource?SWJIYLWA=abc"></script></head><body>
      <script>document.cookie="visid_incap_12345=abc"</script>
      <main>${"Internet banking and corporate services for customers across Africa. ".repeat(80)}</main>
      </body></html>`

    expect(hasImpervaChallenge(realPageWithWafCookies)).toBe(true)
    expect(isContentlessWall(realPageWithWafCookies)).toBe(false)
  })

  test("byte length alone cannot make this call", () => {
    // Why isChallengeWall's imperva: 5000 threshold could not simply be reused: the
    // interstitial is already above it.
    expect(IMPERVA_PARDON_OUR_INTERRUPTION.length).toBeGreaterThan(5000)
    expect(isContentlessWall(IMPERVA_PARDON_OUR_INTERRUPTION)).toBe(true)
  })

  test("script and markup weight do not count as content", () => {
    // A wall padded with obfuscated JS is still a wall.
    const padded = `<html><body><script>${"var x=1;".repeat(3000)}</script>
      <div>Pardon Our Interruption</div></body></html>`
    expect(padded.length).toBeGreaterThan(20000)
    expect(isContentlessWall(padded)).toBe(true)
  })
})
