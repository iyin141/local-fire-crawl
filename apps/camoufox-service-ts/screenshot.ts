// POST /screenshot: capture what a page (or one element of it) looks like. Added for a downstream pipeline that wants a picture of the passage
// a claim cites; see README "Screenshot endpoint". The service itself stays a general browser: nothing here knows about that pipeline.
//
// Design:
//   - Same SSRF guard as /scrape (the caller, api.ts, runs assertSafeTargetUrl first and every browser connection also goes through the
//     SSRF proxy that trawl-deps wires in as the default egress).
//   - Browser tiers only: a fresh context from the pool's browser, never the plain-HTTP tier 1, because a screenshot needs a rendered page.
//   - A page still behind a WAF challenge is reported as `blocked` with the WAF name. It is never captured: a screenshot of a challenge page
//     would look like content.
//   - Cookie banners, consent dialogs and sticky ads are hidden before capture (screenshotHideSelectors.ts).
//   - Always releases the pooled browser and closes the context, on every path.
//   - The pure helpers (validateScreenshotRequest, clipFor, normaliseNeedle) are exported for tests; captureScreenshot takes its dependencies
//     as an argument so tests can drive it with a fake page.

import { CONSENT_TEXT, HIDE_SELECTORS } from './screenshotHideSelectors'

export const MAX_PNG_BYTES = 8 * 1024 * 1024
export const MAX_FULL_PAGE_HEIGHT = 16_000
export const DEFAULT_TIMEOUT_SECONDS = 45
export const MAX_TIMEOUT_SECONDS = 120

export type Target = string | { text: string }

export interface ScreenshotRequest {
  url: string
  target?: Target
  full_page: boolean
  viewport: { width: number; height: number }
  padding_px: number
  timeout_ms: number
}

export interface Rect { x: number; y: number; w: number; h: number }

export interface ScreenshotResult {
  status: 'ok' | 'blocked' | 'error'
  png_base64?: string
  final_url?: string
  page_title?: string
  bbox?: Rect
  matched: boolean | null
  tier: 'browser'
  timing_ms: number
  waf?: string
  pageError?: string
  truncated?: boolean
}

export class BadRequest extends Error {}

const num = (v: unknown, fallback: number, lo: number, hi: number, name: string): number => {
  if (v === undefined || v === null) return fallback
  const n = Number(v)
  if (!Number.isFinite(n) || n < lo || n > hi) throw new BadRequest(`${name} must be a number between ${lo} and ${hi}`)
  return n
}

/** Validates and normalises a request body; throws BadRequest naming the first bad field. The URL itself is checked by the caller (SSRF guard). */
export function validateScreenshotRequest(body: any): ScreenshotRequest {
  if (!body || typeof body !== 'object') throw new BadRequest('body must be a JSON object')
  if (typeof body.url !== 'string' || !body.url) throw new BadRequest('url is required')
  let target: Target | undefined
  if (body.target !== undefined && body.target !== null) {
    if (typeof body.target === 'string') {
      if (!body.target.trim() || body.target.length > 500) throw new BadRequest('target selector must be 1 to 500 characters')
      target = body.target
    } else if (typeof body.target === 'object' && typeof body.target.text === 'string') {
      if (!body.target.text.trim() || body.target.text.length > 2000) throw new BadRequest('target.text must be 1 to 2000 characters')
      target = { text: body.target.text }
    } else {
      throw new BadRequest('target must be a CSS selector string or {text: "..."}')
    }
  }
  const vp = body.viewport ?? {}
  const timeoutSeconds = num(body.timeout, DEFAULT_TIMEOUT_SECONDS, 1, MAX_TIMEOUT_SECONDS, 'timeout (seconds)')
  return {
    url: body.url,
    target,
    full_page: body.full_page === true,
    viewport: { width: num(vp.width, 1920, 320, 3840, 'viewport.width'), height: num(vp.height, 1080, 240, 2160, 'viewport.height') },
    padding_px: num(body.padding_px, 24, 0, 200, 'padding_px'),
    timeout_ms: Math.round(timeoutSeconds * 1000),
  }
}

/** Whitespace-collapsed, lower-cased start of a quote, used to find the element that contains it (long quotes match on their first 160 characters). */
export function normaliseNeedle(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 160)
}

/** The capture rectangle: the element's box plus padding, clamped to the page and to a sane height. `truncated` when the height was cut. */
export function clipFor(rect: Rect, pad: number, pageW: number, pageH: number, viewportH: number): { clip: Rect; truncated: boolean } {
  const x = Math.max(0, Math.floor(rect.x - pad))
  const y = Math.max(0, Math.floor(rect.y - pad))
  const w = Math.max(1, Math.min(Math.ceil(rect.w + 2 * pad), Math.max(1, pageW - x)))
  const maxH = viewportH * 3
  const rawH = Math.max(1, Math.min(Math.ceil(rect.h + 2 * pad), Math.max(1, pageH - y)))
  return { clip: { x, y, w, h: Math.min(rawH, maxH) }, truncated: rawH > maxH }
}

export interface ScreenshotDeps {
  acquireBrowser: (domain: string, budgetMs?: number) => Promise<any>
  releaseBrowser: (handle: any) => void
  newContext: (browser: any, opts: { onCreated?: () => void; requestReplacement?: (reason: string) => void }) => Promise<any>
  closeContext: (ctx: any, requestReplacement?: (reason: string) => void) => Promise<void>
  /** Resolves a challenge if it can: returns {challengeType, resolution} like trawl's routeChallengeWait. */
  waitChallenge: (page: any, html: string, headers: Record<string, string>, timeoutMs: number, url: string, status: number) => Promise<{ challengeType: string; resolution: string }>
  /** Judges the rendered page: {kind: 'challenge', waf} when it is still a challenge page. */
  classify: (html: string, headers: Record<string, string>, status: number) => { kind: string; waf?: string }
  now?: () => number
}

// Page-side functions are real functions (Playwright serialises them), not strings: a string passed to evaluate() is evaluated as an expression
// and a function-valued result is NOT called with the argument.
const findByText = (needle: string): Element | null => {
  const norm = (s: string | null | undefined) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase()
  for (const el of Array.from(document.body.querySelectorAll('*')) as HTMLElement[]) {
    if (!norm(el.innerText).includes(needle)) continue
    // the deepest element that still contains the whole quote
    if (Array.from(el.children).some((c) => norm((c as HTMLElement).innerText).includes(needle))) continue
    return el
  }
  return null
}

const rectOf = (el: Element) => {
  el.scrollIntoView({ block: 'center', inline: 'nearest' })
  const r = el.getBoundingClientRect()
  return {
    x: r.x + window.scrollX, y: r.y + window.scrollY, w: r.width, h: r.height,
    pageW: document.documentElement.scrollWidth, pageH: document.documentElement.scrollHeight,
  }
}

async function hideClutter(page: any): Promise<void> {
  const css = HIDE_SELECTORS.map((s) => `${s}{display:none !important}`).join('\n')
  await page.addStyleTag({ content: css }).catch(() => undefined)
  await page
    .evaluate(
      ([source, flags]: [string, string]) => {
        const re = new RegExp(source, flags)
        for (const el of Array.from(document.querySelectorAll('body *')) as HTMLElement[]) {
          const pos = getComputedStyle(el).position
          if ((pos === 'fixed' || pos === 'sticky') && re.test(el.innerText || '')) el.style.setProperty('display', 'none', 'important')
        }
        document.body.style.setProperty('overflow', 'auto', 'important')   // a consent dialog often locks scrolling
        document.documentElement.style.setProperty('overflow', 'auto', 'important')
      },
      [CONSENT_TEXT.source, CONSENT_TEXT.flags] as [string, string],
    )
    .catch(() => undefined)
}

async function settle(page: any): Promise<void> {
  // fonts and images, best effort and bounded: a slow tracker must not hold the capture hostage
  await page
    .evaluate(
      () =>
        Promise.race([
          Promise.all([
            (document as any).fonts?.ready ?? Promise.resolve(),
            ...Array.from(document.images).map((img) => (img.complete ? Promise.resolve() : new Promise((r) => { img.onload = img.onerror = () => r(null) }))),
          ]),
          new Promise((r) => setTimeout(r, 6000)),
        ]),
    )
    .catch(() => undefined)
}

export async function captureScreenshot(req: ScreenshotRequest, deps: ScreenshotDeps): Promise<ScreenshotResult> {
  const now = deps.now ?? Date.now
  const started = now()
  const elapsed = () => now() - started
  const base = { tier: 'browser' as const, matched: null as boolean | null }
  const fail = (pageError: string, extra: Partial<ScreenshotResult> = {}): ScreenshotResult => ({
    ...base, status: 'error', timing_ms: elapsed(), pageError, ...extra,
  })

  let host = ''
  try { host = new URL(req.url).hostname } catch { return fail('invalid URL') }

  let handle: any
  let ctx: any
  try {
    handle = await deps.acquireBrowser(host, Math.min(req.timeout_ms, 15_000))
    ctx = await deps.newContext(handle.browser, { onCreated: handle.noteTemporaryContext, requestReplacement: handle.requestBrowserReplacement })
    const page = await ctx.newPage()
    await page.setViewportSize(req.viewport).catch(() => undefined)

    let mainStatus = 200
    let mainHeaders: Record<string, string> = {}
    page.on('response', (r: any) => {
      try {
        const rq = r.request()
        if (rq.isNavigationRequest() && rq.frame() === page.mainFrame()) { mainStatus = r.status(); mainHeaders = r.headers() }
      } catch { /* a response can vanish while a challenge document is replaced */ }
    })

    const gotoError = await page.goto(req.url, { waitUntil: 'domcontentloaded', timeout: Math.min(req.timeout_ms, 30_000) }).catch((e: Error) => e)
    if (gotoError instanceof Error && !/interrupted|navigation/i.test(gotoError.message)) {
      return fail(`could not load the page: ${gotoError.message.split('\n')[0]}`)
    }

    const peek = await page.content().catch(() => '')
    const remaining = Math.max(1000, req.timeout_ms - elapsed())
    const { challengeType, resolution } = await deps.waitChallenge(page, peek, mainHeaders, remaining, req.url, mainStatus)
    if (resolution !== 'ok') {
      return { ...base, status: 'blocked', timing_ms: elapsed(), waf: challengeType === 'none' ? 'unknown' : challengeType, pageError: `challenge not cleared (${resolution})`, final_url: page.url() }
    }
    const html = await page.content().catch(() => '')
    const verdict = deps.classify(html, mainHeaders, mainStatus)
    if (verdict.kind === 'challenge') {
      return { ...base, status: 'blocked', timing_ms: elapsed(), waf: verdict.waf ?? 'unknown', pageError: 'still a challenge page after clearing', final_url: page.url() }
    }

    await page.waitForLoadState('load', { timeout: 8000 }).catch(() => undefined)
    await hideClutter(page)
    await settle(page)

    const finalUrl: string = page.url()
    const pageTitle: string = await page.title().catch(() => '')
    let png: Buffer
    let bbox: Rect | undefined
    let matched: boolean | null = null
    let truncated = false

    if (req.target !== undefined && !req.full_page) {
      let rect: any = null
      try {
        const handleEl = typeof req.target === 'string'
          ? await page.$(req.target)
          : await page.evaluateHandle(findByText, normaliseNeedle(req.target.text)).then((h: any) => h.asElement())
        if (handleEl) rect = await handleEl.evaluate(rectOf)
        console.log(`[screenshot] target ${typeof req.target === 'string' ? 'selector' : 'text'} element=${handleEl ? 'found' : 'none'} rect=${JSON.stringify(rect)}`)
      } catch (e) {
        return fail(`the target could not be evaluated: ${(e as Error).message.split('\n')[0]}`, { final_url: finalUrl, page_title: pageTitle, matched: false })
      }
      if (rect && rect.w > 0 && rect.h > 0) {
        matched = true
        const { clip, truncated: cut } = clipFor(rect, req.padding_px, rect.pageW, rect.pageH, req.viewport.height)
        truncated = cut
        bbox = { x: clip.x, y: clip.y, w: clip.w, h: clip.h }
        // Playwright's clip is {x, y, width, height}, not the {w, h} used in the response's bbox
        png = await page.screenshot({ type: 'png', fullPage: true, clip: { x: clip.x, y: clip.y, width: clip.w, height: clip.h }, timeout: Math.max(5000, req.timeout_ms - elapsed()) })
      } else {
        matched = false   // not found: the top of the page, for the caller to see what was there; it is not the target
        png = await page.screenshot({ type: 'png', fullPage: false, timeout: Math.max(5000, req.timeout_ms - elapsed()) })
      }
    } else if (req.full_page) {
      const pageH: number = await page.evaluate(() => document.documentElement.scrollHeight).catch(() => req.viewport.height)
      const h = Math.min(pageH, MAX_FULL_PAGE_HEIGHT)
      truncated = pageH > MAX_FULL_PAGE_HEIGHT
      png = await page.screenshot({ type: 'png', fullPage: true, clip: { x: 0, y: 0, width: req.viewport.width, height: h }, timeout: Math.max(5000, req.timeout_ms - elapsed()) })
      bbox = { x: 0, y: 0, w: req.viewport.width, h }
    } else {
      png = await page.screenshot({ type: 'png', fullPage: false, timeout: Math.max(5000, req.timeout_ms - elapsed()) })
    }

    if (png.length > MAX_PNG_BYTES) return fail(`the picture is ${png.length} bytes, over the ${MAX_PNG_BYTES} byte cap; ask for a narrower target`, { final_url: finalUrl, page_title: pageTitle, matched })
    return { ...base, status: 'ok', png_base64: png.toString('base64'), final_url: finalUrl, page_title: pageTitle, bbox, matched, timing_ms: elapsed(), truncated: truncated || undefined }
  } catch (e) {
    return fail(e instanceof Error ? e.message.split('\n')[0] : String(e))
  } finally {
    // always: close the temporary context, then hand the browser back to the pool
    if (ctx) await deps.closeContext(ctx, handle?.requestBrowserReplacement).catch(() => undefined)
    if (handle) deps.releaseBrowser(handle)
  }
}
