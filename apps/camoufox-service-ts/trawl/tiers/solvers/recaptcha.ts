// reCAPTCHA v2 solver using the audio challenge channel.
//
// Flow:
//  1. Click the reCaptcha checkbox — with a real Chrome fingerprint and good IP,
//     Google's risk scoring often auto-passes at score ≥ 0.5 (green checkmark).
//  2. If a visual image challenge appears, switch to audio mode.
//  3. Download the audio MP3 from Google's servers.
//  4. Transcribe via speech-to-text (Google's free API or configured Whisper endpoint).
//     Note: Google's own reCaptcha audio is designed to be solvable by accessibility
//     tools, meaning their own STT model handles it well — we exploit this circularity.
//  5. Submit the digit string.
//
// reCaptcha v3: purely passive — no widget, no interaction. Real Chrome browsers
// with good behavioral patterns (no automation signals) score ≥ 0.7 automatically.

import type { Page } from "playwright-core"
import { transcribeAudio } from "./stt"

const ANCHOR_IFRAME = 'iframe[src*="recaptcha"][src*="anchor"]'
const BFRAME_IFRAME = 'iframe[src*="recaptcha"][src*="bframe"]'

export async function solveRecaptchaV2(page: Page, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs

  try {
    // Step 1: wait for the anchor iframe
    // Use .first() — sites like nopecha also embed an invisible reCAPTCHA alongside the demo
    // widget, so the selector can match 2 elements (strict mode violation without .first())
    const hasAnchor = await page
      .waitForSelector(ANCHOR_IFRAME, { timeout: 8000 })
      .then(() => true)
      .catch(() => false)
    if (!hasAnchor) return false
    const anchor = page.frameLocator(ANCHOR_IFRAME).first()

    // Step 2: click the checkbox — force:true handles widgets inside hidden tab containers
    await anchor.locator("#recaptcha-anchor").click({ timeout: 5000, force: true })
    console.log("[recaptcha] clicked checkbox")

    // Give Google's risk scoring time to run
    await new Promise((r) => setTimeout(r, 2500))

    // Check for auto-pass (green checkmark)
    if (
      await anchor
        .locator('#recaptcha-anchor[aria-checked="true"]')
        .isVisible({ timeout: 1000 })
        .catch(() => false)
    ) {
      console.log("[recaptcha] auto-passed")
      return true
    }

    // Step 3: challenge appeared — switch to audio mode
    const hasBframe = await page
      .waitForSelector(BFRAME_IFRAME, { timeout: 8000 })
      .then(() => true)
      .catch(() => false)
    if (!hasBframe) {
      console.log("[recaptcha] bframe not found")
      return false
    }
    const bframe = page.frameLocator(BFRAME_IFRAME).first()

    // Log bframe content summary for debugging
    const bframeText = await bframe
      .locator("body")
      .innerText({ timeout: 3000 })
      .catch(() => "")
    console.log("[recaptcha] bframe text snippet:", bframeText.slice(0, 120).replace(/\s+/g, " "))

    const audioBtn = bframe.locator("#recaptcha-audio-button")
    const isAudioVisible = await audioBtn.isVisible({ timeout: 5000 }).catch(() => false)
    if (!isAudioVisible) {
      // Check if image challenge is showing — means audio tab exists but needs click
      const hasImageChallenge = await bframe
        .locator(".rc-imageselect, #rc-imageselect")
        .isVisible({ timeout: 2000 })
        .catch(() => false)
      if (hasImageChallenge) {
        console.log("[recaptcha] image challenge visible — attempting audio button click anyway")
        await audioBtn.click({ timeout: 3000, force: true }).catch(() => {})
        await new Promise((r) => setTimeout(r, 2000))
        const nowVisible = await audioBtn.isVisible({ timeout: 2000 }).catch(() => false)
        if (!nowVisible) {
          console.log("[recaptcha] audio button not accessible (image-only challenge or risk score too low)")
          return false
        }
      } else {
        console.log("[recaptcha] audio button not visible, no image challenge either")
        return false
      }
    }
    await audioBtn.click({ timeout: 5000 })
    console.log("[recaptcha] switched to audio challenge")

    // Step 4: transcribe and submit (retry up to 3 times with fresh audio)
    let attempt = 0
    while (Date.now() < deadline && attempt < 3) {
      attempt++

      // Wait for audio source element to appear (loads after the bframe transitions).
      // If this times out, Google may have blocked the audio challenge for this IP.
      const hasAudioSrc = await bframe
        .locator("#audio-source, audio")
        .waitFor({ timeout: 10_000 })
        .then(() => true)
        .catch(() => false)
      if (!hasAudioSrc) {
        const bframeText2 = await bframe
          .locator("body")
          .innerText()
          .catch(() => "")
        console.log("[recaptcha] audio element not found; bframe:", bframeText2.slice(0, 120).replace(/\s+/g, " "))
        if (/automated queries|try again|network may be/i.test(bframeText2)) {
          console.log("[recaptcha] blocked by Google — audio challenge requires residential proxy")
          return false
        }
      }

      // Small wait after audio element appears — src may be set asynchronously
      await new Promise((r) => setTimeout(r, 1500))

      // Get audio URL via JS property (getAttribute can miss dynamically-set src)
      const rawHref =
        (await bframe
          .locator("#audio-source")
          .evaluate((el) => (el as HTMLAudioElement).src || el.getAttribute("src") || "")
          .catch(() => "")) ||
        (await bframe
          .locator("audio")
          .evaluate((el) => (el as HTMLAudioElement).src || "")
          .catch(() => "")) ||
        (await bframe
          .locator(".rc-audiochallenge-tdownload-link")
          .getAttribute("href", { timeout: 1000 })
          .catch(() => undefined)) ||
        ""

      // Reject blob: URLs — they're browser-internal and can't be fetched from outside
      const audioHref = rawHref && !rawHref.startsWith("blob:") ? rawHref : undefined
      console.log("[recaptcha] raw audio href:", rawHref?.slice(0, 100) ?? "none")

      console.log("[recaptcha] audio URL:", audioHref?.slice(0, 80) ?? "unavailable")

      if (!audioHref) {
        console.log("[recaptcha] audio URL not found, retry", attempt)
        await bframe
          .locator("#recaptcha-reload-button")
          .click({ timeout: 3000 })
          .catch(() => {})
        await new Promise((r) => setTimeout(r, 2000))
        continue
      }

      const absUrl = audioHref.startsWith("http") ? audioHref : `https://www.google.com${audioHref}`
      console.log("[recaptcha] transcribing audio (attempt", attempt, ")")

      const signal = AbortSignal.timeout(Math.max(deadline - Date.now() - 3000, 8000))
      const answer = await transcribeAudio(absUrl, signal)

      if (!answer) {
        console.log("[recaptcha] transcription empty, refreshing audio")
        await bframe
          .locator("#recaptcha-reload-button")
          .click({ timeout: 3000 })
          .catch(() => {})
        await new Promise((r) => setTimeout(r, 1500))
        continue
      }

      console.log("[recaptcha] answer:", answer)

      // Submit
      await bframe
        .locator("#audio-response")
        .fill(answer, { timeout: 3000 })
        .catch(() => {})
      await bframe
        .locator("#recaptcha-verify-button")
        .click({ timeout: 3000 })
        .catch(() => {})
      await new Promise((r) => setTimeout(r, 2000))

      if (
        await anchor
          .locator('#recaptcha-anchor[aria-checked="true"]')
          .isVisible({ timeout: 2000 })
          .catch(() => false)
      ) {
        console.log("[recaptcha] solved via audio ✓")
        return true
      }

      // Wrong answer — get a new challenge
      await bframe
        .locator("#recaptcha-reload-button")
        .click({ timeout: 3000 })
        .catch(() => {})
      await new Promise((r) => setTimeout(r, 1500))
    }

    return false
  } catch (err) {
    console.log("[recaptcha] solver error:", err instanceof Error ? err.message : err)
    return false
  }
}

export async function hasRecaptchaV2(page: Page, timeout = 2000): Promise<boolean> {
  // Use state: 'attached' — the iframe may be present but inside a display:none container
  // (nopecha shows all difficulty tabs in DOM, hides inactive ones with CSS).
  // The solver uses force:true to interact through hidden containers.
  return page
    .waitForSelector(ANCHOR_IFRAME, { timeout, state: "attached" })
    .then(() => true)
    .catch(() => false)
}
