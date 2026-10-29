import { Request, Response } from "express";
import { config } from "../../config";
import { logger as _logger } from "../../lib/logger";

// LOCAL CHANGE: POST /v1/scrape/screenshot
//
// The camoufox-service has its own POST /screenshot (apps/camoufox-service-ts). It is on the private backend network only, so a caller outside the stack
// could not reach it without opening another port. This route is the one public door for it: same host, same /v1/scrape path family, same auth middleware as
// /v1/scrape, and the request and response are passed through unchanged (the service owns the contract; see its README). The service's own SSRF guard stays
// the guard: private, loopback and link-local targets come back as HTTP 403.

const DEFAULT_TIMEOUT_S = 45;
const MAX_TIMEOUT_S = 120;

/** `http://camoufox-service:3000/scrape` -> `http://camoufox-service:3000/screenshot`. Undefined when no browser service is configured. */
export function screenshotServiceUrl(scrapeUrl: string | undefined): string | undefined {
  if (!scrapeUrl) return undefined;
  return scrapeUrl.replace(/\/scrape\/?$/, "").replace(/\/+$/, "") + "/screenshot";
}

export async function scrapeScreenshotController(
  req: Request,
  res: Response,
): Promise<any> {
  const logger = _logger.child({ module: "scrape-screenshot" });
  const target = screenshotServiceUrl(config.PLAYWRIGHT_MICROSERVICE_URL);
  if (!target) {
    return res.status(501).json({
      success: false,
      error:
        "Screenshots are not available: no browser service (PLAYWRIGHT_MICROSERVICE_URL) is configured.",
    });
  }
  const body = req.body;
  if (!body || typeof body !== "object" || typeof body.url !== "string") {
    return res
      .status(400)
      .json({ success: false, error: "Body must be a JSON object with a url." });
  }
  const timeoutS = Math.min(
    MAX_TIMEOUT_S,
    Math.max(1, Number(body.timeout) || DEFAULT_TIMEOUT_S),
  );
  try {
    const upstream = await fetch(target, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout((timeoutS + 15) * 1000),
    });
    const text = await upstream.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      logger.warn("screenshot service returned a non-JSON body", {
        status: upstream.status,
      });
      return res.status(502).json({
        success: false,
        error: "The screenshot service returned something that is not JSON.",
      });
    }
    return res.status(upstream.status).json(json);
  } catch (error) {
    logger.warn("screenshot service request failed", { error });
    return res.status(502).json({
      success: false,
      error: "The screenshot service did not answer.",
    });
  }
}
