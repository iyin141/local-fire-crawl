import { describe, expect, test } from "vitest"
import type { Page } from "playwright-core"
import { waitForDdosGuardResolution } from "../utils/ddosGuardWait"
import { DDOS_GUARD_INTERSTITIAL } from "./fixtures/ddosGuard"

const REAL_PAGE = "<html><body>real content</body></html>"

function pageMock(options: {
  html?: string
  cookies?: Array<{ name: string; domain: string }>
  onGoto?: () => void
  content?: () => Promise<string>
}) {
  let html = options.html ?? DDOS_GUARD_INTERSTITIAL
  const page = {
    url: () => "https://example.test/",
    content: options.content ?? (async () => html),
    context: () => ({ cookies: async () => options.cookies ?? [] }),
    goto: async () => {
      options.onGoto?.()
      if (options.onGoto === undefined) html = REAL_PAGE
      return null
    },
    waitForLoadState: async () => {},
  }
  return { page: page as unknown as Page, setHtml: (value: string) => (html = value) }
}

const FAST_WAIT = { pollMs: 2, renavigationGraceMs: 0, renavigationIntervalMs: 0 }

describe("DDoS-Guard waiter", () => {
  test("returns ok when the interstitial clears itself", async () => {
    let reads = 0
    const { page } = pageMock({
      content: async () => (++reads === 1 ? DDOS_GUARD_INTERSTITIAL : REAL_PAGE),
    })
    expect(await waitForDdosGuardResolution(page, 100, undefined, FAST_WAIT)).toBe("ok")
  })

  test("uses a clearance cookie to re-navigate and verifies the resulting document", async () => {
    const { page } = pageMock({ cookies: [{ name: "__ddg2_abc", domain: ".example.test" }] })
    expect(await waitForDdosGuardResolution(page, 100, "https://example.test/", FAST_WAIT)).toBe("ok")
  })

  test("returns ip-blocked after a bounded number of persistent re-navigations", async () => {
    const { page } = pageMock({
      cookies: [{ name: "__ddg5_abc", domain: "example.test" }],
      onGoto: () => {},
    })
    expect(await waitForDdosGuardResolution(page, 200, "https://example.test/", FAST_WAIT)).toBe("ip-blocked")
  })

  test("times out when no clearance appears", async () => {
    expect(await waitForDdosGuardResolution(pageMock({}).page, 20, undefined, FAST_WAIT)).toBe("timeout")
  })

  test("never treats empty or stuck content as solved and stays within budget", async () => {
    for (const content of [async () => "", () => new Promise<string>(() => {})]) {
      const start = Date.now()
      const result = await waitForDdosGuardResolution(pageMock({ content }).page, 25, undefined, FAST_WAIT)
      expect(result).toBe("timeout")
      expect(Date.now() - start).toBeLessThan(75)
    }
  })

  test("immediately rejects an exhausted budget", async () => {
    const start = Date.now()
    expect(await waitForDdosGuardResolution(pageMock({}).page, 0)).toBe("timeout")
    expect(Date.now() - start).toBeLessThan(20)
  })
})
