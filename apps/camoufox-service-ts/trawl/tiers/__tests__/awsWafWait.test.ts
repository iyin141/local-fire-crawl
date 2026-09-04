import { describe, expect, test } from "vitest"
import type { Page } from "playwright-core"
import { waitForAwsWafResolution } from "../utils/awsWafWait"

const wall = `<script>window.gokuProps={}</script><script src="https://x.token.awswaf.com/x/challenge.js"></script>`
const captcha = `<script>window.gokuProps={}</script><script src="https://x.token.awswaf.com/x/captcha.js"></script>`

function pageFixture(options: {
  html: () => string
  cookies: () => Array<{ name: string; domain: string; value: string }>
}) {
  let gotos = 0
  const page = {
    url: () => "https://shop.example.test/item",
    content: async () => options.html(),
    context: () => ({ cookies: async () => options.cookies() }),
    waitForLoadState: async () => {},
    goto: async () => {
      gotos++
      return null
    },
  } as unknown as Page
  return { page, gotos: () => gotos }
}

describe("AWS WAF waiter", () => {
  test("waits for a new domain-matching token and stable wall disappearance", async () => {
    let reads = 0
    const fixture = pageFixture({
      html: () => (++reads < 3 ? wall : "<html>real content</html>"),
      cookies: () => (reads >= 2 ? [{ name: "aws-waf-token", domain: ".example.test", value: "new-token" }] : []),
    })
    expect(
      await waitForAwsWafResolution(fixture.page, 100, "https://shop.example.test/item", {
        pollMs: 1,
        stablePolls: 2,
      }),
    ).toBe("ok")
  })

  test("renavigates the original URL when a token exists but the wall persists", async () => {
    let cleared = false
    let cookieReads = 0
    const fixture = pageFixture({
      html: () => (cleared ? "<html>real content</html>" : wall),
      cookies: () =>
        ++cookieReads > 1 ? [{ name: "aws-waf-token", domain: "shop.example.test", value: "new-token" }] : [],
    })
    const originalGoto = fixture.page.goto.bind(fixture.page)
    fixture.page.goto = (async (...args: Parameters<Page["goto"]>) => {
      cleared = true
      return originalGoto(...args)
    }) as Page["goto"]
    expect(
      await waitForAwsWafResolution(fixture.page, 100, "https://shop.example.test/item", {
        pollMs: 1,
        stablePolls: 1,
        redirectGraceMs: 0,
      }),
    ).toBe("ok")
    expect(fixture.gotos()).toBe(1)
  })

  test("reports a persistent challenge after token acquisition as blocked", async () => {
    let cookieReads = 0
    const fixture = pageFixture({
      html: () => wall,
      cookies: () => (++cookieReads > 1 ? [{ name: "aws-waf-token", domain: "example.test", value: "new-token" }] : []),
    })
    expect(
      await waitForAwsWafResolution(fixture.page, 15, "https://example.test/", {
        pollMs: 1,
        redirectGraceMs: 0,
      }),
    ).toBe("ip-blocked")
  })

  test("surfaces interactive CAPTCHA without attempting an audio solver", async () => {
    const fixture = pageFixture({ html: () => captcha, cookies: () => [] })
    expect(await waitForAwsWafResolution(fixture.page, 50, "https://example.test/", { pollMs: 1 })).toBe(
      "captcha-required",
    )
  })
})
