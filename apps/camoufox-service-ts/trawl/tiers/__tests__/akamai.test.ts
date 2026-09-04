import { describe, expect, test } from "vitest"
import type { Page } from "playwright-core"
import { waitForAkamaiResolution } from "../utils/akamaiWait"
import { detectChallengeType, hasAkamaiChallenge, isChallengeWall } from "../utils/detect"

const akamaiInterstitial = `
  <html>
    <body>
      <div id="sec-if-cpt-container" class="behavioral-content">
        <button id="progress-button">Press and hold</button>
      </div>
      <footer>Powered and protected by Akamai</footer>
    </body>
  </html>
`

describe("Akamai challenge detection", () => {
  test("detects the behavioral interstitial", () => {
    expect(hasAkamaiChallenge(akamaiInterstitial)).toBe(true)
    expect(detectChallengeType(akamaiInterstitial)).toBe("akamai")
  })

  test("does not flag a full page with passive Akamai telemetry", () => {
    const html = `<html><body>${"real content ".repeat(400)}<script src="https://akamai.com/sec-cpt.js"></script></body></html>`
    expect(hasAkamaiChallenge(html)).toBe(false)
    expect(detectChallengeType(html)).toBe("none")
  })

  test("treats a 200 Akamai interstitial as a proxy challenge wall", () => {
    expect(isChallengeWall(200, Buffer.byteLength(akamaiInterstitial), "akamai")).toBe(true)
  })

  test("honors an exhausted request deadline without generating input", async () => {
    let mouseMoves = 0
    const page = {
      content: async () => akamaiInterstitial,
      url: () => "https://example.com/challenge",
      viewportSize: () => ({ width: 1280, height: 800 }),
      mouse: {
        move: async () => {
          mouseMoves++
        },
      },
    } as Page

    expect(await waitForAkamaiResolution(page, 0)).toBe("timeout")
    expect(mouseMoves).toBe(0)
  })
})
