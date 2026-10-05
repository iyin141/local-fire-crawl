import { describe, expect, it, vi } from 'vitest'
import {
  BadRequest,
  MAX_FULL_PAGE_HEIGHT,
  MAX_PNG_BYTES,
  captureScreenshot,
  clipFor,
  normaliseNeedle,
  validateScreenshotRequest,
  type ScreenshotDeps,
} from '../screenshot'
import { HIDE_SELECTORS } from '../screenshotHideSelectors'

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(32)])

describe('validateScreenshotRequest', () => {
  it('fills the documented defaults', () => {
    const r = validateScreenshotRequest({ url: 'https://example.org/a' })
    expect(r).toMatchObject({ url: 'https://example.org/a', full_page: false, viewport: { width: 1920, height: 1080 }, padding_px: 24, timeout_ms: 45_000 })
    expect(r.target).toBeUndefined()
  })
  it('accepts a selector string and a {text} target', () => {
    expect(validateScreenshotRequest({ url: 'https://e.org', target: 'h1' }).target).toBe('h1')
    expect(validateScreenshotRequest({ url: 'https://e.org', target: { text: 'a quote' } }).target).toEqual({ text: 'a quote' })
  })
  it.each([
    [{}, /url is required/],
    [{ url: 'https://e.org', target: 5 }, /target must be/],
    [{ url: 'https://e.org', target: '' }, /target selector/],
    [{ url: 'https://e.org', target: { text: ' ' } }, /target.text/],
    [{ url: 'https://e.org', viewport: { width: 10 } }, /viewport.width/],
    [{ url: 'https://e.org', padding_px: 999 }, /padding_px/],
    [{ url: 'https://e.org', timeout: 9999 }, /timeout/],
  ])('refuses %j', (body, message) => {
    expect(() => validateScreenshotRequest(body)).toThrow(BadRequest)
    expect(() => validateScreenshotRequest(body)).toThrow(message)
  })
  it('only treats full_page as true when it is exactly true', () => {
    expect(validateScreenshotRequest({ url: 'https://e.org', full_page: 'yes' }).full_page).toBe(false)
    expect(validateScreenshotRequest({ url: 'https://e.org', full_page: true }).full_page).toBe(true)
  })
})

describe('helpers', () => {
  it('normalises a quote to its first 160 characters, lower-cased and whitespace-collapsed', () => {
    expect(normaliseNeedle('  The  Quick\nBrown ')).toBe('the quick brown')
    expect(normaliseNeedle('x'.repeat(300))).toHaveLength(160)
  })
  it('pads the element box, clamps it to the page and cuts a very tall element', () => {
    expect(clipFor({ x: 100, y: 200, w: 300, h: 80 }, 24, 1920, 5000, 1080)).toEqual({ clip: { x: 76, y: 176, w: 348, h: 128 }, truncated: false })
    const edge = clipFor({ x: 0, y: 0, w: 5000, h: 100 }, 24, 1920, 4000, 1080)
    expect(edge.clip.x).toBe(0)
    expect(edge.clip.w).toBe(1920)
    const tall = clipFor({ x: 0, y: 0, w: 400, h: 9000 }, 24, 1920, 20000, 1080)
    expect(tall.truncated).toBe(true)
    expect(tall.clip.h).toBe(3240)
  })
})

function fakeDeps(over: Partial<{ page: any; verdict: any; challenge: any; acquireError: Error }> = {}) {
  const calls = { released: 0, closed: 0, screenshot: [] as any[], style: [] as string[] }
  const element = { evaluate: vi.fn(async () => ({ x: 100, y: 400, w: 300, h: 60, pageW: 1920, pageH: 5000 })) }
  const page: any = {
    on: vi.fn(),
    mainFrame: () => ({}),
    setViewportSize: vi.fn(async () => undefined),
    goto: vi.fn(async () => undefined),
    content: vi.fn(async () => '<html><body>hello</body></html>'),
    url: () => 'https://example.org/final',
    title: async () => 'A page',
    waitForLoadState: vi.fn(async () => undefined),
    addStyleTag: vi.fn(async ({ content }: any) => { calls.style.push(content) }),
    evaluate: vi.fn(async () => 4000),
    evaluateHandle: vi.fn(async () => ({ asElement: () => element })),
    $: vi.fn(async () => element),
    screenshot: vi.fn(async (opts: any) => { calls.screenshot.push(opts); return PNG }),
    ...over.page,
  }
  const deps: ScreenshotDeps = {
    acquireBrowser: vi.fn(async () => {
      if (over.acquireError) throw over.acquireError
      return { browser: {}, noteTemporaryContext: vi.fn(), requestBrowserReplacement: vi.fn() }
    }),
    releaseBrowser: () => { calls.released += 1 },
    newContext: async () => ({ newPage: async () => page }),
    closeContext: async () => { calls.closed += 1 },
    waitChallenge: vi.fn(async () => over.challenge ?? { challengeType: 'none', resolution: 'ok' }),
    classify: () => over.verdict ?? { kind: 'content' },
  }
  return { deps, page, calls }
}

const req = (extra: any = {}) => validateScreenshotRequest({ url: 'https://example.org/a', ...extra })

describe('captureScreenshot', () => {
  it('captures a selector target cropped to the element with padding, and releases the browser', async () => {
    const { deps, page, calls } = fakeDeps()
    const r = await captureScreenshot(req({ target: 'h1' }), deps)
    expect(r.status).toBe('ok')
    expect(r.matched).toBe(true)
    expect(Buffer.from(r.png_base64!, 'base64').subarray(1, 4).toString()).toBe('PNG')
    expect(r.bbox).toEqual({ x: 76, y: 376, w: 348, h: 108 })
    expect(r.final_url).toBe('https://example.org/final')
    expect(r.page_title).toBe('A page')
    // Playwright wants width/height in the clip (an earlier version passed w/h and the live service rejected it)
    expect(calls.screenshot[0]).toMatchObject({ fullPage: true, clip: { x: 76, y: 376, width: 348, height: 108 } })
    expect(calls.screenshot[0].clip).not.toHaveProperty('w')
    expect(page.$).toHaveBeenCalledWith('h1')
    expect(calls.released).toBe(1)
    expect(calls.closed).toBe(1)
  })

  it('finds a quote by its text', async () => {
    const { deps, page } = fakeDeps()
    const r = await captureScreenshot(req({ target: { text: 'The Quoted  Sentence' } }), deps)
    expect(r.matched).toBe(true)
    expect(page.evaluateHandle.mock.calls[0][1]).toBe('the quoted sentence')
    expect(r.bbox).toBeDefined()
  })

  it('reports matched false and takes the viewport (not the page) when the target is not found', async () => {
    const { deps, calls } = fakeDeps({ page: { $: vi.fn(async () => null) } })
    const r = await captureScreenshot(req({ target: '#nope' }), deps)
    expect(r.status).toBe('ok')
    expect(r.matched).toBe(false)
    expect(calls.screenshot[0]).toMatchObject({ fullPage: false })
    expect(r.bbox).toBeUndefined()
  })

  it('hides cookie banners and sticky ads before capturing', async () => {
    const { deps, calls } = fakeDeps()
    await captureScreenshot(req({ target: 'h1' }), deps)
    expect(calls.style[0]).toContain(HIDE_SELECTORS[0])
    expect(calls.style[0]).toContain('display:none !important')
  })

  it('returns blocked with the WAF name when a challenge is not cleared, and takes no picture', async () => {
    const { deps, calls } = fakeDeps({ challenge: { challengeType: 'cloudflare', resolution: 'ip-blocked' } })
    const r = await captureScreenshot(req({ target: 'h1' }), deps)
    expect(r.status).toBe('blocked')
    expect(r.waf).toBe('cloudflare')
    expect(r.png_base64).toBeUndefined()
    expect(calls.screenshot).toHaveLength(0)
    expect(calls.released).toBe(1)
    expect(calls.closed).toBe(1)
  })

  it('returns blocked when the cleared page still classifies as a challenge', async () => {
    const { deps, calls } = fakeDeps({ verdict: { kind: 'challenge', waf: 'imperva' } })
    const r = await captureScreenshot(req(), deps)
    expect(r.status).toBe('blocked')
    expect(r.waf).toBe('imperva')
    expect(calls.screenshot).toHaveLength(0)
  })

  it('reports a page that could not load, and still releases', async () => {
    const { deps, calls } = fakeDeps({ page: { goto: vi.fn(async () => { throw new Error('net::ERR_NAME_NOT_RESOLVED') }) } })
    const r = await captureScreenshot(req(), deps)
    expect(r.status).toBe('error')
    expect(r.pageError).toMatch(/could not load the page/)
    expect(calls.released).toBe(1)
    expect(calls.closed).toBe(1)
  })

  it('always closes the context and releases the browser even when the screenshot itself throws', async () => {
    const { deps, calls } = fakeDeps({ page: { screenshot: vi.fn(async () => { throw new Error('Target closed') }) } })
    const r = await captureScreenshot(req({ target: 'h1' }), deps)
    expect(r.status).toBe('error')
    expect(calls.released).toBe(1)
    expect(calls.closed).toBe(1)
  })

  it('does not release a browser it never acquired', async () => {
    const { deps, calls } = fakeDeps({ acquireError: new Error('pool exhausted') })
    const r = await captureScreenshot(req(), deps)
    expect(r.status).toBe('error')
    expect(r.pageError).toBe('pool exhausted')
    expect(calls.released).toBe(0)
  })

  it('refuses a picture over the size cap', async () => {
    const big = Buffer.alloc(MAX_PNG_BYTES + 1)
    const { deps } = fakeDeps({ page: { screenshot: vi.fn(async () => big) } })
    const r = await captureScreenshot(req({ target: 'h1' }), deps)
    expect(r.status).toBe('error')
    expect(r.pageError).toMatch(/over the .* byte cap/)
  })

  it('caps a full page capture at the maximum height and says so', async () => {
    const { deps, calls } = fakeDeps({ page: { evaluate: vi.fn(async () => 50_000) } })
    const r = await captureScreenshot(req({ full_page: true }), deps)
    expect(r.truncated).toBe(true)
    expect(calls.screenshot[0].clip.height).toBe(MAX_FULL_PAGE_HEIGHT)
  })
})
