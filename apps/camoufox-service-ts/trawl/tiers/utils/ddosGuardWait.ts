import type { Page } from "playwright-core"
import { hasDdosGuardChallenge } from "./detect"

type Resolution = "ok" | "ip-blocked" | "timeout"

interface WaitOptions {
  pollMs?: number
  renavigationGraceMs?: number
  renavigationIntervalMs?: number
  maxRenavigations?: number
}

const failedRead = { failed: true } as const

function isFailedRead(value: unknown): value is typeof failedRead {
  return value === failedRead
}

// Unlike a bare Promise.race, this clears its timer when Playwright settles first.
// Playwright operations that expose a timeout also receive the same remaining budget.
async function withinBudget<T>(promise: Promise<T>, timeoutMs: number): Promise<T | typeof failedRead> {
  if (timeoutMs <= 0) return failedRead
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      new Promise<T | typeof failedRead>((resolve) => promise.then(resolve, () => resolve(failedRead))),
      new Promise<typeof failedRead>((resolve) => {
        timer = setTimeout(() => resolve(failedRead), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export async function waitForDdosGuardResolution(
  page: Page,
  timeoutMs: number,
  originalUrl?: string,
  options: WaitOptions = {},
): Promise<Resolution> {
  if (timeoutMs <= 0) return "timeout"

  const deadline = Date.now() + timeoutMs
  const remaining = () => Math.max(0, deadline - Date.now())
  const pollMs = options.pollMs ?? 300
  const renavigationGraceMs = options.renavigationGraceMs ?? 8000
  const renavigationIntervalMs = options.renavigationIntervalMs ?? 15_000
  const maxRenavigations = options.maxRenavigations ?? 2
  let clearanceAt: number | undefined
  let lastRenavigationAt = 0
  let renavigations = 0
  let persistentAfterRenavigation = false

  const targetHost = (() => {
    try {
      return new URL(originalUrl ?? page.url()).hostname
    } catch {
      return ""
    }
  })()

  while (remaining() > 0) {
    const html = await withinBudget(page.content(), remaining())
    // An empty or unreadable document is never evidence that the wall cleared.
    if (!isFailedRead(html) && html.length > 0 && !hasDdosGuardChallenge(html)) {
      await withinBudget(page.waitForLoadState("load", { timeout: remaining() }), remaining())
      return "ok"
    }

    const cookies = await withinBudget(page.context().cookies(), remaining())
    if (!isFailedRead(cookies)) {
      const hasClearance = cookies.some((cookie) => {
        const cookieHost = cookie.domain.replace(/^\./, "")
        const onTargetHost = targetHost && (targetHost === cookieHost || targetHost.endsWith(`.${cookieHost}`))
        return onTargetHost && /^__ddg[25]_/.test(cookie.name)
      })

      if (hasClearance) {
        clearanceAt ??= Date.now()
        const canRenavigate =
          originalUrl &&
          Date.now() - clearanceAt >= renavigationGraceMs &&
          Date.now() - lastRenavigationAt >= renavigationIntervalMs &&
          renavigations < maxRenavigations

        if (canRenavigate && remaining() > 0) {
          lastRenavigationAt = Date.now()
          renavigations++
          await withinBudget(
            page.goto(originalUrl, { waitUntil: "domcontentloaded", timeout: remaining() }),
            remaining(),
          )
          if (remaining() <= 0) return "timeout"
          await withinBudget(page.waitForLoadState("networkidle", { timeout: remaining() }), remaining())
          if (remaining() <= 0) return "timeout"
          const navigatedHtml = await withinBudget(page.content(), remaining())
          if (!isFailedRead(navigatedHtml) && navigatedHtml.length > 0) {
            if (!hasDdosGuardChallenge(navigatedHtml)) return "ok"
            persistentAfterRenavigation = true
          }
          if (persistentAfterRenavigation && renavigations >= maxRenavigations) return "ip-blocked"
        }
      }
    }

    const delay = Math.min(pollMs, remaining())
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
  }

  return persistentAfterRenavigation ? "ip-blocked" : "timeout"
}
