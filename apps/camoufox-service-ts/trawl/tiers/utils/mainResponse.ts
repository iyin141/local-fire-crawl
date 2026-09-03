import type { Page, Response } from "playwright-core"

import type { MinimalResponse } from "./response"

type NavigationResponse = MinimalResponse & Pick<Response, "request">

/** Tracks the latest top-level document response across redirects. */
export class MainDocumentResponseTracker {
  private latest?: NavigationResponse

  constructor(private readonly page: Pick<Page, "mainFrame">) {}

  observe(response: NavigationResponse): void {
    try {
      const request = response.request()
      if (!request.isNavigationRequest() || request.frame() !== this.page.mainFrame()) return
      this.latest = response
    } catch {
      // A response can disappear while Firefox is replacing a challenge document.
    }
  }

  get response(): MinimalResponse | undefined {
    return this.latest
  }

  get status(): number {
    return this.latest?.status() ?? 200
  }

  get headers(): Record<string, string> {
    return this.latest?.headers() ?? {}
  }
}

export function trackMainDocumentResponses(page: Page): MainDocumentResponseTracker {
  const tracker = new MainDocumentResponseTracker(page)
  page.on("response", (response) => tracker.observe(response))
  return tracker
}
