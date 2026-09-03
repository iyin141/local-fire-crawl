// Cloudflare Turnstile solver — handles both:
//
// 1. Interstitial mode: CF serves a full-page Turnstile challenge BEFORE
//    letting the user through. The challengeWait.ts loop handles this by
//    clicking the iframe widget while polling for cf_clearance.
//
// 2. Embedded mode: The page itself contains a <div class="cf-turnstile"> widget.
//    This is used by sites as a form protection (not as a page gate).
//    Solving it generates a turnstile token in the hidden input, which the
//    page's JS can then use to allow form submission or reveal content.
//
// Non-interactive mode: When Cloudflare determines the browser has a good
// risk score (Camoufox Firefox, residential IP, no automation signals), Turnstile
// auto-solves without any click — a spinner briefly appears then turns into
// a green checkmark.

import type { Frame, Page } from "playwright-core"

// Turnstile iframes can come from multiple CF origin paths depending on region and mode.
const CF_ORIGINS = ["challenges.cloudflare.com", "cloudflare.com/cdn-cgi", "cdn-cgi/challenge-platform"]

export async function solveTurnstile(page: Page, timeoutMs = 25_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs

  // With Camoufox (Firefox + geoip), Turnstile often auto-solves immediately.
  // The token lands in the hidden input before the iframe even appears.
  const existingToken = await page
    .locator('input[name="cf-turnstile-response"]')
    .inputValue()
    .catch(() => "")
  if (existingToken) {
    console.log("[turnstile] auto-solved, token:", `${existingToken.slice(0, 20)}...`)
    return true
  }

  const allFrames = page.frames()
  console.log(`[turnstile] ${allFrames.length} frames on page:`, allFrames.map((f) => f.url().slice(0, 80)).join(" | "))

  console.log("[turnstile] waiting for challenge iframe or auto-solve token...")

  // Give managed-mode Turnstile time to auto-verify before attempting click.
  // On good IPs + Camoufox Firefox fingerprint, CF resolves within 3-8s passively.
  await new Promise((r) => setTimeout(r, 5000))

  let clickAttempts = 0
  while (Date.now() < deadline) {
    // Check all possible token locations (hidden input set by turnstile.js)
    const token = await page
      .evaluate(() => {
        const el = document.querySelector<HTMLInputElement>('[name="cf-turnstile-response"]')
        return el?.value ?? ""
      })
      .catch(() => "")
    if (token) {
      console.log("[turnstile] solved, token:", `${token.slice(0, 30)}...`)
      return true
    }

    // Find the CF challenge frame and attempt click
    const frames = page.frames()
    const cfFrame = frames.find(isChallengeFrame)
    if (cfFrame) {
      // Try frame-internal click — may succeed if Fission doesn't isolate this frame
      const clickedInternal = await clickInFrameCheckbox(cfFrame)
      if (clickedInternal) {
        console.log("[turnstile] clicked via frame locator (attempt", ++clickAttempts, ")")
      } else {
        // Firefox Fission isolates CF iframe in a separate process — frame DOM is inaccessible.
        // frame.frameElement() gives us the <iframe> element in the parent page, so we can
        // get its bounding box and click at the checkbox position via page mouse coordinates.
        const frameEl = await cfFrame.frameElement().catch(() => undefined)
        const box = frameEl ? await frameEl.boundingBox().catch(() => undefined) : undefined

        if (box && box.width > 20) {
          // Checkbox is in the left portion of the Turnstile iframe (approx x+24, vertically centered).
          const cx = box.x + Math.min(24, box.width * 0.12)
          const cy = box.y + box.height / 2
          clickAttempts++
          console.log(
            `[turnstile] iframe ${Math.round(box.width)}x${Math.round(box.height)} at (${Math.round(box.x)},${Math.round(box.y)}) — natural click attempt ${clickAttempts}`,
          )

          // Approach the checkbox with natural mouse movement to avoid synthetic-click detection.
          // Start from above-left of the iframe, move toward the checkbox.
          await page.mouse.move(cx - 60, cy - 40)
          await new Promise((r) => setTimeout(r, 100 + Math.random() * 150))
          await page.mouse.move(cx - 20, cy + (Math.random() - 0.5) * 8, { steps: 5 })
          await new Promise((r) => setTimeout(r, 80 + Math.random() * 120))
          await page.mouse.move(cx + (Math.random() - 0.5) * 4, cy + (Math.random() - 0.5) * 4, { steps: 3 })
          await new Promise((r) => setTimeout(r, 120 + Math.random() * 80))
          await page.mouse.click(cx, cy)
          console.log("[turnstile] clicked checkbox")
        } else {
          console.log("[turnstile] iframe not found or zero-size")
        }
      }

      // Wait for CF to evaluate and potentially generate the token.
      // CF's invisible check after click can take 2-10s for non-trivial evaluations.
      await new Promise((r) => setTimeout(r, 8000))
      continue
    }

    await new Promise((r) => setTimeout(r, 1500))
  }

  return false
}

export async function hasTurnstileWidget(page: Page): Promise<boolean> {
  return page
    .locator('.cf-turnstile, #cf-turnstile, input[name="cf-turnstile-response"]')
    .isVisible({ timeout: 2000 })
    .catch(() => false)
}

function isChallengeFrame(frame: Frame): boolean {
  const url = frame.url()
  return CF_ORIGINS.some((o) => url.includes(o))
}

// CF Turnstile renders the checkbox via shadow DOM — accessibility role selectors pierce shadow
// boundaries, CSS selectors only reach light DOM. Try both.
async function clickInFrameCheckbox(frame: Frame): Promise<boolean> {
  const accessibilitySelectors = ['[role="checkbox"]', "role=checkbox", "role=button"]
  for (const sel of accessibilitySelectors) {
    try {
      const el = frame.locator(sel).first()
      if (await el.isVisible({ timeout: 500 }).catch(() => false)) {
        await el.click({ timeout: 2000, force: true })
        return true
      }
    } catch {}
  }

  // CSS selectors (light DOM)
  const cssSelectors = [".ctp-checkbox-label", 'input[type="checkbox"]', "#challenge-stage div", ".cb-i", "label"]
  for (const sel of cssSelectors) {
    try {
      const el = frame.locator(sel).first()
      if (await el.isVisible({ timeout: 300 }).catch(() => false)) {
        await el.click({ timeout: 2000, force: true })
        return true
      }
    } catch {}
  }
  return false
}
