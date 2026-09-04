// A single verdict on "what did we actually get back", shared by every caller in
// this service.
//
// This is a WRAPPER around trawl's detectors, not a replacement and not an edit to
// them: trawl/ is vendored and we want to keep pulling upstream fixes, so the
// detectors stay untouched and the policy that was wrong lives out here instead.
//
// The policy that was wrong: each caller decided for itself how much of the body to
// examine. Tier 1 detects against a bounded 4096-byte preview (deliberately -- see
// upstream's runTier1FullBody.test.ts, which names it "the 4 KiB detection preview"
// and exists so multi-megabyte pages are not decoded just to look for markers),
// tiers 2-4 use the full body, and the Python side used markdown[:500]. Same
// question, three windows. zenithbank.com's only Imperva marker sat at byte 4865
// and was returned to callers as a successful scrape.

import {
  detectChallengeType,
  isBrowserErrorPage,
  type ChallengeType,
} from "../trawl/tiers/utils/detect"

export type ContentVerdict =
  | { kind: "ok" }
  | { kind: "challenge"; waf: ChallengeType }
  | { kind: "unrendered_shell"; visibleTextChars: number; scriptTags: number }
  | { kind: "browser_error_page" }

// Above this, fall back to a bounded prefix. The bounded preview exists to avoid
// decoding very large bodies, and that concern is real -- but it does not apply to
// the pages we actually need to catch. Challenge interstitials are inherently
// small: the Imperva one that prompted this is 6KB, Cloudflare's is ~3KB, and
// trawl's own lean-body thresholds top out at 5KB. A page above this size is
// content, whatever else it is.
export const WHOLE_BODY_SCAN_LIMIT = 256 * 1024

// Deliberately not a size check. example.com's real page (558B) is LARGER than the
// SPA shell that prompted this (473B), so any length-based rule misfires. What
// separates them is visible text against the presence of scripts able to produce
// more of it.
export const SHELL_MAX_VISIBLE_TEXT = 200

export function bodyForDetection(html: string): string {
  return html.length <= WHOLE_BODY_SCAN_LIMIT ? html : html.slice(0, WHOLE_BODY_SCAN_LIMIT)
}

export function countScriptTags(html: string): number {
  return (html.match(/<script\b/gi) ?? []).length
}

export function visibleText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
}

// A client-rendered page whose content only exists after JS runs. Distinct from a
// challenge: nothing is blocking us, the page just has not rendered. trawl escalates
// past challenges, not past this, so it would otherwise be reported as a clean win.
export function looksLikeUnrenderedShell(html: string): boolean {
  if (!html) return false
  // No scripts means nothing is pending -- a short page here is simply a short page.
  if (countScriptTags(html) === 0) return false
  return visibleText(html).length < SHELL_MAX_VISIBLE_TEXT
}

export function classifyContent(
  html: string,
  headers: Record<string, string> = {},
  status?: number,
): ContentVerdict {
  if (!html) return { kind: "ok" }

  const body = bodyForDetection(html)

  // Challenge first: an interstitial is also thin, and calling it a shell would send
  // it down a retry path that cannot help.
  const waf = detectChallengeType(body, headers, status)
  if (waf !== "none") return { kind: "challenge", waf }

  if (isBrowserErrorPage(body)) return { kind: "browser_error_page" }

  if (looksLikeUnrenderedShell(body)) {
    return {
      kind: "unrendered_shell",
      visibleTextChars: visibleText(body).length,
      scriptTags: countScriptTags(body),
    }
  }

  return { kind: "ok" }
}

// Both of these are answered by a browser, so both are worth one escalation past a
// plain HTTP fetch. A browser_error_page is not -- that is the browser itself having
// failed, and repeating it changes nothing.
export function warrantsBrowserRetry(verdict: ContentVerdict): boolean {
  return verdict.kind === "challenge" || verdict.kind === "unrendered_shell"
}

export function describeVerdict(verdict: ContentVerdict, html: string): string {
  switch (verdict.kind) {
    case "challenge":
      return `${verdict.waf} challenge page (${html.length}B)`
    case "unrendered_shell":
      return `unrendered shell (${html.length}B, ${verdict.visibleTextChars} visible chars, ${verdict.scriptTags} script tags)`
    case "browser_error_page":
      return `browser error page (${html.length}B)`
    case "ok":
      return `ok (${html.length}B)`
  }
}
