import {
  scrapeScreenshotController,
  screenshotServiceUrl,
} from "../scrape-screenshot";
import { config } from "../../../config";

function fakeRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (c: number) => {
    res.statusCode = c;
    return res;
  };
  res.json = (b: any) => {
    res.body = b;
    return res;
  };
  return res;
}

describe("POST /v1/scrape/screenshot", () => {
  const original = config.PLAYWRIGHT_MICROSERVICE_URL;
  afterEach(() => {
    (config as any).PLAYWRIGHT_MICROSERVICE_URL = original;
    vi.unstubAllGlobals();
  });

  it("derives the screenshot URL from the scrape URL", () => {
    expect(screenshotServiceUrl("http://camoufox-service:3000/scrape")).toBe(
      "http://camoufox-service:3000/screenshot",
    );
    expect(screenshotServiceUrl("http://x:3000/scrape/")).toBe(
      "http://x:3000/screenshot",
    );
    expect(screenshotServiceUrl("http://x:3000")).toBe("http://x:3000/screenshot");
    expect(screenshotServiceUrl(undefined)).toBeUndefined();
    expect(screenshotServiceUrl("")).toBeUndefined();
  });

  it("answers 501 when no browser service is configured", async () => {
    (config as any).PLAYWRIGHT_MICROSERVICE_URL = undefined;
    const res = fakeRes();
    await scrapeScreenshotController({ body: { url: "https://example.com" } } as any, res);
    expect(res.statusCode).toBe(501);
    expect(res.body.success).toBe(false);
  });

  it("refuses a body without a url", async () => {
    (config as any).PLAYWRIGHT_MICROSERVICE_URL = "http://c:3000/scrape";
    const res = fakeRes();
    await scrapeScreenshotController({ body: {} } as any, res);
    expect(res.statusCode).toBe(400);
  });

  it("passes the request through and returns the service's answer and status unchanged", async () => {
    (config as any).PLAYWRIGHT_MICROSERVICE_URL = "http://c:3000/scrape";
    const calls: any[] = [];
    vi.stubGlobal("fetch", async (url: string, init: any) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ status: "ok", matched: true, png_base64: "AAAA" }), {
        status: 200,
      });
    });
    const req = { body: { url: "https://example.com", target: "p", timeout: 30 } };
    const res = fakeRes();
    await scrapeScreenshotController(req as any, res);
    expect(calls[0].url).toBe("http://c:3000/screenshot");
    expect(calls[0].body).toEqual(req.body);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ status: "ok", matched: true, png_base64: "AAAA" });
  });

  it("keeps the service's refusal status (a private target is 403)", async () => {
    (config as any).PLAYWRIGHT_MICROSERVICE_URL = "http://c:3000/scrape";
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: "blocked target" }), { status: 403 }));
    const res = fakeRes();
    await scrapeScreenshotController({ body: { url: "http://127.0.0.1/" } } as any, res);
    expect(res.statusCode).toBe(403);
  });

  it("answers 502 when the service is down or returns junk", async () => {
    (config as any).PLAYWRIGHT_MICROSERVICE_URL = "http://c:3000/scrape";
    vi.stubGlobal("fetch", async () => {
      throw new Error("ECONNREFUSED");
    });
    let res = fakeRes();
    await scrapeScreenshotController({ body: { url: "https://example.com" } } as any, res);
    expect(res.statusCode).toBe(502);
    vi.stubGlobal("fetch", async () => new Response("<html>nope</html>", { status: 200 }));
    res = fakeRes();
    await scrapeScreenshotController({ body: { url: "https://example.com" } } as any, res);
    expect(res.statusCode).toBe(502);
  });
});
