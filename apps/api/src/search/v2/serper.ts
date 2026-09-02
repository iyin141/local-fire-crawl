import axios from "axios";
import { config } from "../../config";
import { SearchV2Response, WebSearchResult } from "../../lib/entities";
import { logger } from "../../lib/logger";

// Serper.dev (https://serper.dev) -- a paid Google-results API. Added as an
// alternative to the DuckDuckGo fallback, which throttles hard under
// sustained automated querying (silent timeouts via AbortController, not
// an error DDG itself returns) and has no official API to fall back on.
// Same SearchV2Response contract as ddgsearch.ts/searxng.ts, so it's a
// drop-in alternative in v2/index.ts's backend chain.

interface SearchOptions {
  tbs?: string;
  lang?: string;
  country?: string;
  location?: string;
  num_results: number;
}

// tbs (Google's date-range shorthand, e.g. "qdr:d"/"qdr:w"/"qdr:m"/"qdr:y")
// is the same convention ddgsearch.ts already partially supports; Serper
// accepts it verbatim as the `tbs` param.
export async function serper_search(
  q: string,
  options: SearchOptions,
): Promise<SearchV2Response> {
  const apiKey = config.SERPER_API_KEY;
  if (!apiKey) {
    return {};
  }

  try {
    const response = await axios.post(
      "https://google.serper.dev/search",
      {
        q,
        gl: (options.country ?? "us").toLowerCase(),
        hl: options.lang ?? "en",
        num: Math.max(options.num_results, 1),
        location: options.location,
        tbs: options.tbs,
      },
      {
        headers: {
          "X-API-KEY": apiKey,
          "Content-Type": "application/json",
        },
        timeout: 10000,
      },
    );

    const organic = response.data?.organic;
    if (!Array.isArray(organic) || organic.length === 0) {
      return {};
    }

    const web: WebSearchResult[] = organic
      .filter((r: any) => r.link && r.title)
      .map((r: any, i: number) => ({
        url: r.link,
        title: r.title,
        description: r.snippet ?? "",
        position: r.position ?? i + 1,
      }));

    return web.length > 0 ? { web: web.slice(0, options.num_results) } : {};
  } catch (error: any) {
    // Same posture as searxng_search: log and return an empty result so
    // v2/index.ts's chain falls through to the next backend rather than
    // the whole request failing because one provider had a bad moment.
    if (error.response?.status === 401 || error.response?.status === 403) {
      logger.error("Serper: authentication failed -- check SERPER_API_KEY", {
        status: error.response.status,
      });
    } else {
      logger.error("Serper search error", { error: error.message, term: q });
    }
    return {};
  }
}
