import type { Page } from "playwright-core"
import { hasAkamaiChallenge } from "./detect"

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const hostnameFor = (url?: string) => {
  try {
    return url ? new URL(url).hostname : ""
  } catch {
    return ""
  }
}

export async function waitForAkamaiResolution(
  page: Page,
  timeoutMs: number,
  originalUrl?: string,
): Promise<"ok" | "ip-blocked" | "timeout"> {
  const deadline = Date.now() + Math.max(timeoutMs, 0)
  const targetHost = hostnameFor(originalUrl ?? page.url())

  const early = await page.content().catch(() => "")
  if (early && !hasAkamaiChallenge(early)) {
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {})
    return "ok"
  }
  if (Date.now() >= deadline) return "timeout"

  await sleep(Math.min(1500, Math.max(deadline - Date.now(), 0)))
  await wanderMouse(page, 8, deadline)

  let heldOnce = false
  let navigatedOnce = false
  let sawCookieAt: number | undefined

  while (Date.now() < deadline) {
    const html = await page.content().catch(() => "")
    if (html && !hasAkamaiChallenge(html)) {
      await page.waitForLoadState("load", { timeout: 5000 }).catch(() => {})
      return "ok"
    }

    const hasAbck = await pageHasAkamaiCookie(page, targetHost)
    if (hasAbck && sawCookieAt === undefined) {
      sawCookieAt = Date.now()
      console.log("[akamai] _abck cookie present")
    }
    if (hasAbck && !navigatedOnce && originalUrl && sawCookieAt && Date.now() - sawCookieAt > 6000) {
      navigatedOnce = true
      console.log("[akamai] cookie set but still on interstitial — navigating to original URL")
      await page.goto(originalUrl, { waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => {})
      await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {})
      const resolvedHtml = await page.content().catch(() => "")
      return resolvedHtml && !hasAkamaiChallenge(resolvedHtml) ? "ok" : "ip-blocked"
    }

    if (!heldOnce && deadline - Date.now() > 6000) heldOnce = await pressAndHold(page)

    await wanderMouse(page, 3, deadline)
    await sleep(Math.min(600, Math.max(deadline - Date.now(), 0)))
  }

  return "timeout"
}

async function pageHasAkamaiCookie(page: Page, targetHost: string): Promise<boolean> {
  const cookies: Array<{ name: string; value: string; domain: string }> = await page
    .context()
    .cookies()
    .catch(() => [])
  const abck = cookies.find(
    (cookie) =>
      cookie.name === "_abck" &&
      targetHost &&
      (cookie.domain === targetHost ||
        cookie.domain === `.${targetHost}` ||
        targetHost.endsWith(cookie.domain.replace(/^\./, ""))),
  )
  if (!abck) return false
  const seg = abck.value.split("~")[1]
  return seg !== undefined && seg !== "-1"
}

async function wanderMouse(page: Page, points: number, deadline: number): Promise<void> {
  try {
    const vp = page.viewportSize() || { width: 1280, height: 800 }
    let x = Math.random() * vp.width
    let y = Math.random() * vp.height
    for (let i = 0; i < points; i++) {
      if (Date.now() >= deadline) break
      const nx = Math.max(2, Math.min(vp.width - 2, x + (Math.random() - 0.5) * vp.width * 0.5))
      const ny = Math.max(2, Math.min(vp.height - 2, y + (Math.random() - 0.5) * vp.height * 0.5))
      await page.mouse.move(nx, ny, { steps: 4 + Math.floor(Math.random() * 8) })
      x = nx
      y = ny
      await sleep(Math.min(60 + Math.random() * 140, Math.max(deadline - Date.now(), 0)))
    }
  } catch {
    // Navigation can temporarily invalidate the input target.
  }
}

async function pressAndHold(page: Page): Promise<boolean> {
  const sel = "#progress-button, .behavioral-button, #sec-if-cpt-container [role='button']"
  let mouseDown = false
  try {
    const el = page.locator(sel).first()
    if (!(await el.isVisible({ timeout: 500 }).catch(() => false))) return false
    const box = await el.boundingBox().catch(() => undefined)
    if (!box || box.width < 4 || box.height < 4) return false
    const cx = box.x + box.width / 2
    const cy = box.y + box.height / 2
    await page.mouse.move(cx - 18, cy - 10, { steps: 6 })
    await page.mouse.move(cx, cy, { steps: 8 })
    await page.mouse.down()
    mouseDown = true
    const holdUntil = Date.now() + 5500
    while (Date.now() < holdUntil) {
      await page.mouse.move(cx + (Math.random() - 0.5) * 3, cy + (Math.random() - 0.5) * 3, { steps: 2 })
      await sleep(220)
    }
    console.log("[akamai] press-and-hold performed")
    return true
  } catch {
    return false
  } finally {
    if (mouseDown) await page.mouse.up().catch(() => {})
  }
}
