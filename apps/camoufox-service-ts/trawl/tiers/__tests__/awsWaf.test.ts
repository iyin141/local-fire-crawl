import { describe, expect, test } from "vitest"
import {
  detectChallengeType,
  getAwsWafAction,
  hasAwsWafCaptcha,
  hasAwsWafChallenge,
  isChallengeWall,
} from "../utils/detect"

const challengeHtml = `<script>window.gokuProps={"key":"x"}</script><script src="https://x.token.awswaf.com/x/challenge.js"></script>`
const captchaHtml = `<script>window.gokuProps={"key":"x"}</script><script src="https://x.token.awswaf.com/x/captcha.js"></script>`

describe("AWS WAF challenge detection", () => {
  test("recognizes case-insensitive authoritative Challenge and CAPTCHA headers with their statuses", () => {
    expect(getAwsWafAction(202, { "X-AmZn-WaF-aCtIoN": "Challenge" })).toBe("challenge")
    expect(getAwsWafAction(405, { "X-AMZN-WAF-ACTION": "CAPTCHA" })).toBe("captcha")
    expect(detectChallengeType("", { "X-Amzn-Waf-Action": "challenge" }, 202)).toBe("aws-waf")
    expect(detectChallengeType("", { "x-amzn-waf-action": "captcha" }, 405)).toBe("aws-waf")
  })

  test("requires the matching status for an action header", () => {
    expect(getAwsWafAction(200, { "x-amzn-waf-action": "challenge" })).toBeUndefined()
    expect(getAwsWafAction(202, { "x-amzn-waf-action": "captcha" })).toBeUndefined()
  })

  test("uses gokuProps plus the matching script for HTML fallback", () => {
    expect(hasAwsWafChallenge(challengeHtml)).toBe(true)
    expect(hasAwsWafCaptcha(captchaHtml)).toBe(true)
    expect(detectChallengeType(challengeHtml)).toBe("aws-waf")
  })

  test("does not classify individual integration markers", () => {
    expect(hasAwsWafChallenge(`<script src="https://x.token.awswaf.com/x/challenge.js"></script>`)).toBe(false)
    expect(hasAwsWafChallenge(`<script>window.awsWafCookieDomainList=['example.com']</script>`)).toBe(false)
    expect(hasAwsWafChallenge(`<script>window.gokuProps={}</script>`)).toBe(false)
  })

  test("leaves empty and non-empty ordinary 202 responses alone", () => {
    expect(detectChallengeType("", {}, 202)).toBe("none")
    expect(isChallengeWall(202, 0, "none")).toBe(false)
    expect(isChallengeWall(202, 512, "none")).toBe(false)
  })

  test("treats a positively identified AWS response as a wall", () => {
    expect(isChallengeWall(202, 0, "aws-waf")).toBe(true)
    expect(isChallengeWall(405, 0, "aws-waf")).toBe(true)
  })
})
