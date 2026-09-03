// GeeTest v3/v4 slide captcha solver.
//
// GeeTest v4 flow:
//   1. Click the "Click to verify" button → center modal popup opens.
//   2. Screenshot the challenge image area, analyze pixel brightness column-by-column
//      to find the notch shadow (darkest region), compute drag distance.
//   3. Drag the slider rightward with a bezier trajectory until the piece fills the notch.
//   4. Success: popup closes (modal disappears).

import { randomUUID } from "node:crypto"
import type { Page } from "playwright-core"
import { readFileBytes, rmQuiet, runFfmpeg, writeFile } from "./nodeShell"

const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg"

// Initial "Click to verify" button selectors (GeeTest v4 entry point).
// Use aria-label and specific class — avoid [class*="geetest_btn"] which also matches the icon SVG.
const VERIFY_BUTTON = [
  'div[aria-label="Click to verify"]',
  "div.geetest_btn_click",
  ".geetest_btn_click",
  ".geetest_wind_style",
].join(", ")

// Actual drag handle selectors (v3 CSS classes; v4 is SVG-based with no clear CSS class)
const DRAG_HANDLE_V3 = ".geetest_slider_button, .gt_slider_knob"

export async function solveGeetestSlide(page: Page, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs

  try {
    const frames = page.frames()
    console.log("[geetest] frames:", frames.map((f) => f.url().slice(0, 80)).join(" | "))

    // Phase 1: Click the initial "Click to verify" button to trigger the slide challenge
    const verifyBtn = page.locator(VERIFY_BUTTON).first()
    const verifyVisible = await verifyBtn.isVisible({ timeout: 8000 }).catch(() => false)
    if (!verifyVisible) {
      console.log("[geetest] no initial verify button found")
      return false
    }
    console.log("[geetest] clicking initial verify button")
    // The div has tabindex and aria-label — use page.mouse.click at its actual coordinates
    // so the browser dispatches the click to the div (not forced through a covering element).
    const verifyBox = await verifyBtn.boundingBox().catch(() => undefined)
    if (verifyBox) {
      await page.mouse.click(verifyBox.x + verifyBox.width / 2, verifyBox.y + verifyBox.height / 2)
    } else {
      await verifyBtn.click({ force: true })
    }

    // Phase 2: Wait for the challenge modal popup to load.
    // GeeTest v4 opens a CENTER MODAL (not an expansion of the widget).
    // Wait for the image content to load inside the modal (up to ~4.5s total).
    await new Promise((r) => setTimeout(r, 3000))

    // Enumerate all geetest elements to find the modal popup (large element in center)
    const gElements = await page
      .evaluate(() => {
        const els = Array.from(document.querySelectorAll('[class*="geetest"]'))
        return els
          .map((el) => {
            const r = el.getBoundingClientRect()
            const cls =
              typeof el.className === "string"
                ? (el.className.split(" ").find((c) => c.startsWith("geetest") && !c.includes("_")) ??
                  el.className.split(" ")[0])
                : String(el.className)
            return {
              cls,
              x: Math.round(r.x),
              y: Math.round(r.y),
              w: Math.round(r.width),
              h: Math.round(r.height),
              tag: el.tagName,
            }
          })
          .filter((e) => e.w > 50 && e.h > 50)
      })
      .catch(() => [] as { cls: string; x: number; y: number; w: number; h: number; tag: string }[])
    console.log("[geetest] visible elements:", JSON.stringify(gElements.slice(0, 15)))

    // Find the popup/panel: prefer geetest_box (v4 modal container), else largest
    // non-full-viewport element (backdrop excluded by position check: must be offset from (0,0))
    const vpW = page.viewportSize()?.width ?? 1920
    const vpH = page.viewportSize()?.height ?? 1080
    const popup =
      gElements.find((e) => e.cls.includes("geetest_box") && !e.cls.includes("hint")) ??
      gElements
        .filter((e) => e.w < vpW * 0.6 && e.h < vpH * 0.6 && e.h > 200 && (e.x > 0 || e.y > 0))
        .sort((a, b) => b.w * b.h - a.w * a.h)[0]

    if (!popup) {
      console.log("[geetest] no challenge popup found")
      await page.screenshot({ path: "/tmp/gt-no-challenge.png" }).catch(() => {})
      return false
    }
    console.log(`[geetest] challenge popup: ${popup.w}x${popup.h} at (${popup.x},${popup.y}) [${popup.cls}]`)

    // Wait a bit more for the challenge image to fully render
    await new Promise((r) => setTimeout(r, 1500))

    // Extract specific elements from the challenge popup
    const imageEl = gElements.find((e) => e.cls.includes("geetest_bg") || e.cls.includes("geetest_window"))
    const sliceEl = gElements.find((e) => e.cls.includes("geetest_slice") && !e.cls.includes("bg"))
    const sliderTrackEl = gElements.find(
      (e) => e.cls.includes("geetest_slider") && !e.cls.includes("button") && !e.cls.includes("bg"),
    )

    console.log(
      `[geetest] image=${imageEl ? `${imageEl.w}x${imageEl.h}@(${imageEl.x},${imageEl.y})` : "n/a"} slice=${sliceEl ? `${sliceEl.w}x${sliceEl.h}@(${sliceEl.x},${sliceEl.y})` : "n/a"} slider=${sliderTrackEl ? `${sliderTrackEl.w}x${sliderTrackEl.h}@(${sliderTrackEl.x},${sliderTrackEl.y})` : "n/a"}`,
    )

    // Use actual image element for screenshot area
    const svgBox = imageEl
      ? { x: imageEl.x, y: imageEl.y, width: imageEl.w, height: imageEl.h }
      : { x: popup.x, y: popup.y + Math.round(popup.h * 0.15), width: popup.w, height: Math.round(popup.h * 0.57) }

    // Phase 3: Determine drag handle position.
    // The drag handle (blue pill button) is at the LEFT of the slider track.
    // Its width ≈ puzzle piece width (geetest_slice width).
    // startX = sliderTrack.x + pieceHalfW, startY = sliderTrack center.
    const pieceW = sliceEl?.w ?? 80
    let sliderBox: { x: number; y: number; width: number; height: number }

    const v3Handle = await page
      .locator(DRAG_HANDLE_V3)
      .first()
      .boundingBox()
      .catch(() => undefined)
    if (v3Handle) {
      sliderBox = v3Handle
      console.log(
        `[geetest] drag handle (CSS v3): ${sliderBox.width}x${sliderBox.height} at (${sliderBox.x},${sliderBox.y})`,
      )
    } else if (sliderTrackEl) {
      // Drag handle occupies the left portion of the track, same width as puzzle piece
      sliderBox = { x: sliderTrackEl.x, y: sliderTrackEl.y, width: pieceW, height: sliderTrackEl.h }
      console.log(
        `[geetest] drag handle (track-left): ${sliderBox.width}x${sliderBox.height} at (${sliderBox.x},${sliderBox.y})`,
      )
    } else {
      sliderBox = { x: popup.x + 2, y: popup.y + Math.round(popup.h * 0.74), width: pieceW, height: 44 }
      console.log("[geetest] using estimated drag handle position")
    }

    // Phase 4: Detect the notch position from the screenshot of the image area
    // pieceHalfW is the half-width of the puzzle piece for center-to-center alignment
    const gapX = await findSliderGapByScreenshot(page, sliderBox, svgBox, pieceW / 2)
    console.log("[geetest] estimated gap x-offset:", Math.round(gapX))

    // Phase 5: Drag — try up to 3 times with slight offset adjustments
    const offsets = [0, 15, -15]
    for (let attempt = 0; attempt < offsets.length && Date.now() < deadline; attempt++) {
      const adjustedGap = Math.max(10, gapX + offsets[attempt])

      // Re-read slider box — GeeTest may reset position between attempts
      const currentSlider = await page
        .locator(DRAG_HANDLE_V3)
        .first()
        .boundingBox()
        .catch(() => sliderBox)
      const cur = currentSlider ?? sliderBox
      const startX = cur.x + cur.width / 2
      const startY = cur.y + cur.height / 2

      console.log(
        `[geetest] attempt ${attempt + 1}: drag ${Math.round(adjustedGap)}px from (${Math.round(startX)},${Math.round(startY)})`,
      )

      await page.mouse.move(startX, startY)
      await page.mouse.down()

      const steps = 35
      for (let i = 0; i <= steps; i++) {
        const t = i / steps
        const x = startX + adjustedGap * easeInOut(t) + (Math.random() - 0.5) * 2
        const y = startY + Math.sin(t * Math.PI) * 5 + (Math.random() - 0.5) * 2
        await page.mouse.move(x, y, { steps: 1 })
        if (Date.now() >= deadline) break
        await new Promise((r) => setTimeout(r, 10 + Math.random() * 30))
      }

      await new Promise((r) => setTimeout(r, 400 + Math.random() * 200))
      await page.mouse.up()
      await new Promise((r) => setTimeout(r, 2500))

      const success = await isGeetestSuccess(page)
      if (success) {
        console.log("[geetest] slide solved ✓ (attempt", attempt + 1, ")")
        return true
      }

      console.log(`[geetest] attempt ${attempt + 1} failed`)
      if (attempt < offsets.length - 1) {
        // Reset for next attempt
        await page
          .locator('[class*="geetest"][class*="refresh"], [class*="geetest"][class*="retry"], .geetest_radar_tip')
          .first()
          .click({ timeout: 2000 })
          .catch(() => {})
        await new Promise((r) => setTimeout(r, 1500))
      }
    }

    return false
  } catch (err) {
    console.log("[geetest] error:", err instanceof Error ? err.message : err)
    return false
  }
}

async function findSliderGapByScreenshot(
  page: Page,
  sliderBox: { x: number; y: number; width: number; height: number },
  svgBox: { x: number; y: number; width: number; height: number },
  pieceHalfW = 27,
): Promise<number> {
  const id = randomUUID().slice(0, 8)
  const pngPath = `/tmp/gt-${id}.png`
  const rawPath = `/tmp/gt-${id}.raw`

  try {
    // Screenshot the SVG challenge image — this is where the notch is
    const clip = { x: svgBox.x, y: svgBox.y, width: svgBox.width, height: svgBox.height }

    const png = await page.screenshot({ clip })
    await writeFile(pngPath, png)

    const ff = await runFfmpeg(FFMPEG, ["-i", pngPath, "-f", "rawvideo", "-pix_fmt", "rgb24", rawPath, "-y", "-loglevel", "error"])
    if (ff.exitCode !== 0) {
      console.log("[geetest] ffmpeg failed")
      return fallback(sliderBox)
    }

    const rawData = await readFileBytes(rawPath)
    const w = Math.round(svgBox.width)
    const h = Math.round(svgBox.height)
    if (rawData.length < w * h * 3) {
      console.log("[geetest] raw pixel data too small")
      return fallback(sliderBox)
    }

    // Analyze pixel brightness column by column.
    // The notch is a puzzle-piece-shaped shadow region — distinctly darker than the rest.
    // The puzzle piece starts at the left — skip it (half of its width + small margin).
    const PIECE_W = Math.round(pieceHalfW * 2 + 10) // skip puzzle piece area at left
    const yStart = Math.floor(h * 0.15)
    const yEnd = Math.floor(h * 0.85)

    const edgeScore: number[] = new Array(w).fill(0)
    const avgBright: number[] = new Array(w).fill(0)

    for (let y = yStart; y < yEnd; y++) {
      for (let x = 2; x < w - 2; x++) {
        const iL = (y * w + (x - 2)) * 3
        const iC = (y * w + x) * 3
        const iR = (y * w + (x + 2)) * 3
        const bL = (rawData[iL] + rawData[iL + 1] + rawData[iL + 2]) / 3
        const bC = (rawData[iC] + rawData[iC + 1] + rawData[iC + 2]) / 3
        const bR = (rawData[iR] + rawData[iR + 1] + rawData[iR + 2]) / 3
        edgeScore[x] += Math.abs(bL - bR)
        avgBright[x] += bC
      }
    }
    const rows = yEnd - yStart
    for (let x = 0; x < w; x++) avgBright[x] /= rows

    // Darkest column in [PIECE_W, w-30] — center of the notch shadow
    let minBright = Number.POSITIVE_INFINITY
    let darkX = 0
    for (let x = PIECE_W; x < w - 30; x++) {
      if (avgBright[x] < minBright) {
        minBright = avgBright[x]
        darkX = x
      }
    }

    // Strongest edge in [PIECE_W, w-30] — notch boundary
    let maxEdge = 0
    let edgeX = 0
    for (let x = PIECE_W; x < w - 30; x++) {
      if (edgeScore[x] > maxEdge) {
        maxEdge = edgeScore[x]
        edgeX = x
      }
    }

    // Top peaks for diagnostics
    const peaks = Array.from({ length: w }, (_, x) => ({ x, s: edgeScore[x] }))
      .filter((p) => p.x >= PIECE_W && p.x <= w - 30)
      .sort((a, b) => b.s - a.s)
      .slice(0, 5)
    console.log(`[geetest] dark notch x=${darkX}(bright=${Math.round(minBright)}) edge notch x=${edgeX}`)
    console.log("[geetest] top edge peaks:", peaks.map((p) => `x=${p.x}(${Math.round(p.s)})`).join(" "))

    // Use dark column as primary (consistent across runs), edge as fallback
    const notchCenterX = darkX || edgeX
    if (notchCenterX === 0) {
      console.log("[geetest] notch not found")
      return fallback(sliderBox)
    }

    // CENTER alignment: piece center should be at notch center.
    // After drag by gapX: piece center = sliderBox.x + pieceHalfW + gapX = svgBox.x + notchCenterX
    // gapX = svgBox.x + notchCenterX - sliderBox.x - pieceHalfW  (pieceHalfW = parameter)
    const gapX = svgBox.x + notchCenterX - sliderBox.x - pieceHalfW

    console.log(
      `[geetest] notch at svg-x=${notchCenterX} (page-x=${Math.round(svgBox.x + notchCenterX)}), drag=${Math.round(gapX)}`,
    )
    return Math.max(10, gapX)
  } catch (err) {
    console.log("[geetest] screenshot analysis error:", err instanceof Error ? err.message : err)
    return fallback(sliderBox)
  } finally {
    await rmQuiet(pngPath, rawPath)
  }
}

function fallback(_sliderBox: { x: number; y: number; width: number; height: number }): number {
  console.log("[geetest] using fallback gap 120px")
  return 120
}

async function isGeetestSuccess(page: Page): Promise<boolean> {
  // GeeTest v4: success = popup modal closes (the box/ghost disappear)
  const boxGone = await page
    .locator('[class*="geetest_box"]')
    .first()
    .isVisible({ timeout: 500 })
    .then((v) => !v)
    .catch(() => true)
  if (boxGone) {
    console.log("[geetest] success: popup closed")
    return true
  }

  const ghostGone = await page
    .locator('[class*="geetest_popup_ghost"]')
    .first()
    .isVisible({ timeout: 500 })
    .then((v) => !v)
    .catch(() => true)
  if (ghostGone) {
    console.log("[geetest] success: ghost disappeared")
    return true
  }

  // GeeTest v3 / fallback: look for success CSS class
  const successSels = [
    ".geetest_success_radar_tip",
    ".gt_success",
    ".geetest_holder.geetest_success",
    '[class*="geetest"][class*="success"]',
  ].join(", ")
  return page
    .locator(successSels)
    .isVisible({ timeout: 2000 })
    .catch(() => false)
}

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t
}

export async function hasGeetestSlide(page: Page, timeout = 2000): Promise<boolean> {
  const html = await page.content().catch(() => "")
  if (/geetest|initGeetest|gt_container/i.test(html)) return true
  return page
    .waitForSelector(VERIFY_BUTTON, { timeout, state: "attached" })
    .then(() => true)
    .catch(() => false)
}
