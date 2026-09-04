import type { BrowserHandle } from "../../browser"
import { closeTemporaryContext, FINGERPRINT, newFreshContext } from "../../browser"
import type { Cookie, TierResult } from "../../types"
import { solvePageCaptchas } from "../solvers"
import { routeChallengeWait } from "../utils/challengeRouter"
import { snapshotChallengeCookies, toCookies } from "../utils/cookies"
import {
  hasAkamaiChallenge,
  hasDataDomeChallenge,
  hasDdosGuardChallenge,
  hasImpervaChallenge,
  isBlocked,
  isBrowserErrorPage,
  isCloudflarePage,
  isContentlessWall,
} from "../utils/detect"
import { normalizeHtml } from "../utils/html"
import { trackMainDocumentResponses } from "../utils/mainResponse"
import { isHardNetworkFailure } from "../utils/network"
import { isProxyTransportFailure, normalizeProxyError, proxyResponseFailure } from "../utils/proxyFailure"
import { captureResponse, isTextContentType } from "../utils/response"
import type { RouteLike } from "../utils/sanitize"
import { routeContinueOverrides } from "../utils/sanitize"

export interface Tier4Result extends TierResult {
  tier: 4
  challenge?: "datadome"
  effectiveUrl?: string
  html?: string
  body?: Uint8Array
  responseHeaders?: Record<string, string>
  contentType?: string
  cookies?: Cookie[]
  userAgent?: string
  statusCode?: number
  captchasSolved?: string[]
}

export async function runTier4(
  url: string,
  handle: BrowserHandle,
  maxTimeout: number,
  proxyUrl: string,
  extraHeaders?: Record<string, string>,
  method?: string,
  body?: string,
  opts?: { skipTlsVerification?: boolean; waitAfterLoad?: number },
): Promise<Tier4Result> {
  const start = Date.now()

  // Create an isolated context routed through the proxy.
  // Proxies must be set at context creation time in Playwright — they cannot be
  // applied per-request. We create a fresh context here and close it when done,
  // leaving the pool's shared context untouched.
  const state: { proxyContext?: Awaited<ReturnType<typeof newFreshContext>> } = {}

  try {
    const proxyContext = await newFreshContext(handle.browser, {
      proxy: proxyUrl,
      ignoreHTTPSErrors: opts?.skipTlsVerification,
      onCreated: handle.noteTemporaryContext,
      requestReplacement: handle.requestBrowserReplacement,
    })
    state.proxyContext = proxyContext

    const page = await proxyContext.newPage()
    const initialCookies = snapshotChallengeCookies(await proxyContext.cookies())

    if ((extraHeaders && Object.keys(extraHeaders).length > 0) || method === "POST") {
      await page.route(url, (route: RouteLike) => {
        route.continue(routeContinueOverrides(route, extraHeaders, method, body))
      })
    }

    const mainResponse = trackMainDocumentResponses(page)

    const gotoErr = await page
      .goto(url, {
        waitUntil: "domcontentloaded",
        timeout: Math.min(maxTimeout, 30_000),
      })
      .catch((e: Error) => e)

    if (isHardNetworkFailure(gotoErr)) {
      return { tier: 4, status: "error", durationMs: Date.now() - start, reason: normalizeProxyError(gotoErr) }
    }
    const earlyProxyFailure = proxyResponseFailure(mainResponse.status, mainResponse.headers)
    if (earlyProxyFailure) {
      return { tier: 4, status: "error", durationMs: Date.now() - start, reason: earlyProxyFailure }
    }

    const remaining = maxTimeout - (Date.now() - start)
    const peekHtml = await page.content().catch(() => "")
    const { challengeType, resolution } = await routeChallengeWait(
      page,
      peekHtml,
      mainResponse.headers,
      remaining,
      url,
      undefined,
      mainResponse.status,
      initialCookies,
    )

    if (resolution !== "ok") {
      return {
        tier: 4,
        status: resolution === "ip-blocked" || resolution === "captcha-required" ? "blocked" : "timeout",
        durationMs: Date.now() - start,
        reason:
          resolution === "captcha-required"
            ? `${challengeType}-captcha-required`
            : resolution === "ip-blocked"
              ? "proxy-ip-blocked"
              : `${challengeType === "none" ? "cloudflare" : challengeType}-challenge-timeout`,
      }
    }

    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {})

    // Attempt to solve any embedded captcha widgets on the page (Turnstile, reCaptcha, hCaptcha) —
    // same as Tier 3. Sites that reach Tier 4 for IP reputation can still have an in-page widget.
    const solveRemaining = maxTimeout - (Date.now() - start)
    let captchasSolved: string[] = []
    if (solveRemaining > 5000) {
      const solveResult = await solvePageCaptchas(page, solveRemaining).catch(() => ({ attempted: [], solved: [] }))
      captchasSolved = solveResult.solved
    }

    // See Tier 3: idle for client-side rendering once any challenge has settled,
    // bounded by what remains of the caller's budget.
    if (opts?.waitAfterLoad && opts.waitAfterLoad > 0) {
      const waitRemaining = Math.max(0, Math.min(opts.waitAfterLoad, maxTimeout - (Date.now() - start)))
      if (waitRemaining > 0) await new Promise((r) => setTimeout(r, waitRemaining))
    }

    const html = await page.content()

    if (html.length < 100) {
      return { tier: 4, status: "error", durationMs: Date.now() - start, reason: "page returned empty content" }
    }

    if (isBrowserErrorPage(html)) {
      return {
        tier: 4,
        status: "error",
        durationMs: Date.now() - start,
        reason: "proxy-connection-failed",
      }
    }

    if (isCloudflarePage(html, mainResponse.headers) && isContentlessWall(html)) {
      return {
        tier: 4,
        status: "blocked",
        durationMs: Date.now() - start,
        reason: "cloudflare-persistent",
      }
    }

    if (hasImpervaChallenge(html) && isContentlessWall(html)) {
      return {
        tier: 4,
        status: "blocked",
        durationMs: Date.now() - start,
        reason: "imperva-persistent",
      }
    }

    if (hasAkamaiChallenge(html) && isContentlessWall(html)) {
      return {
        tier: 4,
        status: "blocked",
        durationMs: Date.now() - start,
        reason: "akamai-persistent",
      }
    }

    if (hasDdosGuardChallenge(html) && isContentlessWall(html)) {
      const pageTitle = await page.title().catch(() => "?")
      const pageUrl = page.url()
      console.log(`[tier4] ddos-guard-persistent: url="${pageUrl}" title="${pageTitle}" html=${html.length}b`)
      return { tier: 4, status: "blocked", durationMs: Date.now() - start, reason: "ddos-guard-persistent" }
    }

    if (hasDataDomeChallenge(html) && isContentlessWall(html)) {
      const pageTitle = await page.title().catch(() => "?")
      const pageUrl = page.url()
      console.log(`[tier4] datadome-persistent: url="${pageUrl}" title="${pageTitle}" html=${html.length}b`)
      return {
        tier: 4,
        status: "blocked",
        durationMs: Date.now() - start,
        reason: "datadome-persistent",
        challenge: "datadome",
      }
    }

    if (isBlocked(mainResponse.status, html)) {
      return { tier: 4, status: "blocked", durationMs: Date.now() - start, reason: `http-${mainResponse.status}` }
    }

    const cookies: Cookie[] = toCookies(await proxyContext.cookies())

    const captured = await captureResponse(mainResponse.response)

    return {
      tier: 4,
      status: "success",
      durationMs: Date.now() - start,
      effectiveUrl: page.url(),
      html: !captured.contentType || isTextContentType(captured.contentType) ? normalizeHtml(html) : "",
      ...captured,
      cookies,
      userAgent: await page.evaluate(() => navigator.userAgent).catch(() => FINGERPRINT.userAgent),
      statusCode: mainResponse.status,
      captchasSolved: captchasSolved.length > 0 ? captchasSolved : undefined,
    }
  } catch (err) {
    return {
      tier: 4,
      status: "error",
      durationMs: Date.now() - start,
      reason: isProxyTransportFailure(err)
        ? normalizeProxyError(err)
        : err instanceof Error
          ? err.message
          : String(err),
    }
  } finally {
    await closeTemporaryContext(state.proxyContext, handle.requestBrowserReplacement, "tier4 context cleanup timed out")
  }
}
