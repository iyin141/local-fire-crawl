import { describe, expect, test } from "vitest"
import { isProxyTransportFailure, proxyResponseFailure } from "../utils/proxyFailure"

describe("proxy failure classification", () => {
  test("only treats Proxy-Status with an error parameter as failure", () => {
    expect(proxyResponseFailure(200, { "proxy-status": 'ExampleProxy; next-hop="origin.example"' })).toBeUndefined()
    expect(proxyResponseFailure(502, { "proxy-status": "ExampleProxy; error=dns_error" })).toBe(
      "proxy-connection-failed",
    )
  })

  test("recognizes Chromium and Firefox proxy network errors", () => {
    expect(isProxyTransportFailure(new Error("net::ERR_TUNNEL_CONNECTION_FAILED"))).toBe(true)
    expect(isProxyTransportFailure(new Error("NS_ERROR_PROXY_CONNECTION_REFUSED"))).toBe(true)
  })
})
