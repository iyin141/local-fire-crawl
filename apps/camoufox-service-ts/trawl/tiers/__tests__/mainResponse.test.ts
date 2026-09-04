import { describe, expect, test } from "vitest"
import { MainDocumentResponseTracker } from "../utils/mainResponse"
import { captureResponse } from "../utils/response"

const mainFrame = {}
const iframe = {}
const page = { mainFrame: () => mainFrame }

function response(
  url: string,
  status: number,
  headers: Record<string, string>,
  body: string,
  options: { navigation?: boolean; frame?: object; allHeaders?: Record<string, string> } = {},
) {
  return {
    url: () => url,
    status: () => status,
    headers: () => headers,
    allHeaders: async () => options.allHeaders ?? headers,
    body: async () => Buffer.from(body),
    request: () => ({
      isNavigationRequest: () => options.navigation ?? true,
      frame: () => options.frame ?? mainFrame,
    }),
  }
}

describe("MainDocumentResponseTracker", () => {
  test("keeps the final response across cross-origin redirects with coherent metadata", async () => {
    const tracker = new MainDocumentResponseTracker(page as never)
    tracker.observe(
      response("https://a.example/start", 302, { location: "https://b.example/final" }, "redirect") as never,
    )
    tracker.observe(
      response("https://b.example/final", 200, { "content-type": "text/html", "x-final": "yes" }, "origin") as never,
    )

    expect(tracker.status).toBe(200)
    expect(tracker.headers["x-final"]).toBe("yes")
    const captured = await captureResponse(tracker.response)
    expect(new TextDecoder().decode(captured.body)).toBe("origin")
    expect(captured.contentType).toBe("text/html")
  })

  test("ignores subresources and iframe navigations", () => {
    const tracker = new MainDocumentResponseTracker(page as never)
    tracker.observe(response("https://example.com/", 200, {}, "main") as never)
    tracker.observe(response("https://example.com/app.js", 404, {}, "script", { navigation: false }) as never)
    tracker.observe(response("https://challenge.example/frame", 403, {}, "frame", { frame: iframe }) as never)

    expect(tracker.status).toBe(200)
    expect(tracker.response?.url()).toBe("https://example.com/")
  })

  test("retains a terminal external-scheme redirect", () => {
    const tracker = new MainDocumentResponseTracker(page as never)
    tracker.observe(response("https://example.com/download", 301, { location: "magnet:?xt=urn:test" }, "") as never)

    expect(tracker.status).toBe(301)
    expect(tracker.headers.location).toBe("magnet:?xt=urn:test")
  })

  test("captures cookie headers from allHeaders even when headers omits them", async () => {
    const tracker = new MainDocumentResponseTracker(page as never)
    tracker.observe(
      response("https://example.com/", 200, { "content-type": "text/html" }, "ok", {
        allHeaders: {
          "content-type": "text/html",
          "set-cookie": "session=one; Path=/; HttpOnly\nclearance=two; Path=/; Secure",
        },
      }) as never,
    )

    expect(tracker.headers["set-cookie"]).toBeUndefined()
    const captured = await captureResponse(tracker.response)
    expect(captured.responseHeaders?.["set-cookie"]).toBe(
      "session=one; Path=/; HttpOnly\nclearance=two; Path=/; Secure",
    )
  })
})
