import { z } from "zod";
import { config } from "../../../../config";
import { EngineScrapeResult } from "..";
import { Meta } from "../..";
import { robustFetch } from "../../lib/fetch";
import { getInnerJson } from "@mendable/firecrawl-rs";

export async function scrapeURLWithPlaywright(
  meta: Meta,
): Promise<EngineScrapeResult> {
  const response = await robustFetch({
    url: config.PLAYWRIGHT_MICROSERVICE_URL!,
    headers: {
      "Content-Type": "application/json",
    },
    body: {
      url: meta.rewrittenUrl ?? meta.url,
      wait_after_load: meta.options.waitFor,
      timeout: meta.abort.scrapeTimeout(),
      headers: meta.options.headers,
      skip_tls_verification: meta.options.skipTlsVerification,
    },
    method: "POST",
    logger: meta.logger.child("scrapeURLWithPlaywright/robustFetch"),
    schema: z.object({
      content: z.string(),
      pageStatusCode: z.number(),
      pageError: z.string().optional(),
      contentType: z.string().optional(),
    }),
    mock: meta.mock,
    abort: meta.abort.asSignal(),
  });

  if (response.contentType?.includes("application/json")) {
    response.content = await getInnerJson(response.content);
  }

  return {
    url: meta.rewrittenUrl ?? meta.url, // TODO: impove redirect following
    html: response.content,
    statusCode: response.pageStatusCode,
    error: response.pageError,
    contentType: response.contentType,

    proxyUsed: "basic",
  };
}

// LOCAL CHANGE: this used to be a flat `waitFor + 30000`, the same shape as
// fire-engine's chrome-cdp budget. That is the right heuristic when a
// fallback engine could plausibly substitute for a slow one -- but on this
// deployment nothing can substitute for playwright/camoufox on an HTML page:
// pdf and document are file parsers, not renderers, and racing them in after
// 30s does not give the scrape a second chance, it just starts two engines
// that cannot succeed while abandoning the one that was about to.
//
// Observed live on vfdgroup.com: camoufox-service resolves a Cloudflare
// Turnstile challenge in 20-40s depending on load (confirmed via its own
// logs -- "Scrape successful! (tier 3, ...)" -- appearing after the 30s
// waterfall had already fired and pivoted to pdf/document, both of which
// then failed and reported "All scraping engines failed" for a page that
// Camoufox was in the middle of successfully solving). Same site, same
// input, flipped between success and failure across consecutive requests
// purely on which side of the 30s line the solve landed.
//
// So this now tracks the actual budget the request was given -- the same
// number already sent to camoufox-service as `timeout` in the POST body --
// rather than a constant that assumes a stock headless browser's speed.
// meta.abort.scrapeTimeout() is undefined only when the caller relies on
// the platform default, so the fallback mirrors that default (see
// ScrapeJobTimeoutError above).
export function playwrightMaxReasonableTime(meta: Meta): number {
  return meta.abort.scrapeTimeout() ?? 300000;
}
