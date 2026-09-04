import { describe, expect, test } from "vitest"
import { proxySanitizeHeaders, RESPONSE_HOP_BY_HOP_HEADERS } from "../utils/sanitize"

describe("proxySanitizeHeaders", () => {
  test("returns undefined for empty/undefined input", () => {
    expect(proxySanitizeHeaders(undefined)).toBeUndefined()
    expect(proxySanitizeHeaders({})).toBeUndefined()
  })

  test("passes through Authorization (unlike sanitizeHeaders)", () => {
    const out = proxySanitizeHeaders({ Authorization: "Bearer xyz" })
    expect(out).toEqual({ authorization: "Bearer xyz" })
  })

  test("passes through Cookie", () => {
    const out = proxySanitizeHeaders({ Cookie: "session=abc" })
    expect(out).toEqual({ cookie: "session=abc" })
  })

  test("passes through Range (critical for JDownloader-style chunked downloads)", () => {
    const out = proxySanitizeHeaders({ Range: "bytes=0-1023" })
    expect(out).toEqual({ range: "bytes=0-1023" })
  })

  test("passes through User-Agent", () => {
    const out = proxySanitizeHeaders({ "User-Agent": "JDownloader/2" })
    expect(out).toEqual({ "user-agent": "JDownloader/2" })
  })

  test("passes through Referer, Origin, custom API tokens", () => {
    const out = proxySanitizeHeaders({
      Referer: "https://example.com/page",
      Origin: "https://example.com",
      "X-Api-Key": "secret-token",
    })
    expect(out).toEqual({
      referer: "https://example.com/page",
      origin: "https://example.com",
      "x-api-key": "secret-token",
    })
  })

  test("strips hop-by-hop headers (Connection, Transfer-Encoding, Upgrade)", () => {
    const out = proxySanitizeHeaders({
      Connection: "keep-alive",
      "Transfer-Encoding": "chunked",
      Upgrade: "websocket",
      "Keep-Alive": "timeout=5",
      TE: "trailers",
      "Proxy-Authorization": "Basic xxx",
      Trailer: "Expires",
      "Proxy-Connection": "close",
      Accept: "*/*",
    })
    expect(out).toEqual({ accept: "*/*" })
  })

  test("strips hop-by-hop headers case-insensitively", () => {
    const out = proxySanitizeHeaders({
      CONNECTION: "close",
      "transfer-encoding": "chunked",
      Accept: "*/*",
    })
    expect(out).toEqual({ accept: "*/*" })
  })

  test("lowercases keys for cheap lookup later", () => {
    const out = proxySanitizeHeaders({ "Content-Type": "application/json", "X-Custom": "v" })
    expect(out).toEqual({ "content-type": "application/json", "x-custom": "v" })
  })

  test("strips control characters from values (prevents request smuggling)", () => {
    const out = proxySanitizeHeaders({ "X-Custom": "value\r\nInjected-Header: evil" })
    expect(out).toEqual({ "x-custom": "valueInjected-Header: evil" })
  })

  test("drops empty values", () => {
    const out = proxySanitizeHeaders({ Accept: "   ", "X-Real": "v" })
    expect(out).toEqual({ "x-real": "v" })
  })

  test("drops empty header names", () => {
    const out = proxySanitizeHeaders({ "": "orphan", Accept: "*/*" })
    expect(out).toEqual({ accept: "*/*" })
  })

  test("RESPONSE_HOP_BY_HOP_HEADERS exposes the same set for response filtering", () => {
    expect(RESPONSE_HOP_BY_HOP_HEADERS.has("connection")).toBe(true)
    expect(RESPONSE_HOP_BY_HOP_HEADERS.has("transfer-encoding")).toBe(true)
    expect(RESPONSE_HOP_BY_HOP_HEADERS.has("upgrade")).toBe(true)
    expect(RESPONSE_HOP_BY_HOP_HEADERS.has("authorization")).toBe(false)
    expect(RESPONSE_HOP_BY_HOP_HEADERS.has("set-cookie")).toBe(false)
  })

  test("does not mutate the input record", () => {
    const input = { Authorization: "Bearer xyz", Accept: "*/*" }
    const snapshot = { ...input }
    proxySanitizeHeaders(input)
    expect(input).toEqual(snapshot)
  })
})
