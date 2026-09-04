import { describe, expect, test } from "vitest"
import { isCloudflarePage } from "../utils/detect"

describe("Cloudflare challenge detection", () => {
  test("treats cf-mitigated challenge as authoritative regardless of case or page title", () => {
    const html = `<html><title>Welcome</title><body>${"content ".repeat(1000)}</body></html>`
    expect(isCloudflarePage(html, { "CF-Mitigated": "Challenge" })).toBe(true)
  })

  test("detects active orchestration markers on large pages", () => {
    const padding = "content ".repeat(1000)
    expect(isCloudflarePage(`<script>window._cf_chl_opt={}</script>${padding}`, {})).toBe(true)
    expect(isCloudflarePage(`<form id="challenge-form"></form>${padding}`, {})).toBe(true)
    expect(
      isCloudflarePage(`<script src="/cdn-cgi/challenge-platform/orchestrate/chl_page/v1"></script>${padding}`, {}),
    ).toBe(true)
  })

  test("allows passive Cloudflare telemetry on an ordinary large page", () => {
    const html = `<html><title>Real page</title><body>${"content ".repeat(1000)}<script>__CF$cv$params={}</script><script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script></body></html>`
    expect(isCloudflarePage(html, {})).toBe(false)
  })
})
