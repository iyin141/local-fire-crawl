import { describe, it, expect } from "vitest";
import { parseProxyServers, isIPPrivate } from "../safeFetch";

// LOCAL CHANGE coverage — PROXY_SERVER became a comma-separated list so the api
// container's direct-download engines (fetch/pdf/document/image, all via
// getSecureDispatcher) can spread across a pool instead of funnelling every
// request through one residential exit. The parsing is the part with real edge
// cases; the round-robin itself is three lines over that parsed list.
describe("parseProxyServers", () => {
  it("returns an empty list when unset, so callers fall back to a no-proxy agent", () => {
    expect(parseProxyServers(undefined)).toEqual([]);
    expect(parseProxyServers("")).toEqual([]);
  });

  it("treats a single value as a one-element list (existing deployments unchanged)", () => {
    expect(parseProxyServers("http://user:pass@p.example.io:80")).toEqual([
      "http://user:pass@p.example.io:80",
    ]);
  });

  it("splits a comma-separated list", () => {
    expect(
      parseProxyServers(
        "http://a:1@p.example.io:80,http://b:2@p.example.io:80,http://c:3@p.example.io:80",
      ),
    ).toEqual([
      "http://a:1@p.example.io:80",
      "http://b:2@p.example.io:80",
      "http://c:3@p.example.io:80",
    ]);
  });

  it("tolerates whitespace and trailing/dangling commas", () => {
    // A 30-entry list pasted into .env across lines is exactly where these creep in.
    expect(parseProxyServers(" http://a:1@p:80 , http://b:2@p:80 ,, ")).toEqual([
      "http://a:1@p:80",
      "http://b:2@p:80",
    ]);
  });

  it("keeps bare host:port entries intact (scheme is added later, not here)", () => {
    expect(parseProxyServers("p.example.io:80,q.example.io:80")).toEqual([
      "p.example.io:80",
      "q.example.io:80",
    ]);
  });
});

// Guard on the SSRF check this module has always carried — unrelated to the proxy
// change, but this file had no unit test at all before it, and the check is the
// reason every engine routes through this dispatcher in the first place.
describe("isIPPrivate", () => {
  it("flags loopback and private ranges", () => {
    expect(isIPPrivate("127.0.0.1")).toBe(true);
    expect(isIPPrivate("10.0.0.1")).toBe(true);
    expect(isIPPrivate("192.168.1.1")).toBe(true);
    expect(isIPPrivate("172.16.0.1")).toBe(true);
  });

  it("allows ordinary public addresses", () => {
    expect(isIPPrivate("8.8.8.8")).toBe(false);
    expect(isIPPrivate("1.1.1.1")).toBe(false);
  });

  it("returns false for anything that is not a valid IP", () => {
    expect(isIPPrivate("not-an-ip")).toBe(false);
    expect(isIPPrivate("")).toBe(false);
  });
});
