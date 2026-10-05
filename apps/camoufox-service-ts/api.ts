import express, { Request, Response } from 'express';
import dotenv from 'dotenv';
import { getError } from './helpers/get_error';
import { lookup } from 'dns/promises';
import IPAddr from 'ipaddr.js';
import { Server, RequestError } from 'proxy-chain';
import { ScrapeError, scrape } from './trawl/tiers';
import type { ScrapeRequest } from './trawl/types';
import { getTrawlDeps, initTrawlPool, shutdownTrawlPool, wireSsrfProxy } from './trawl-deps';
import { classifyContent, describeVerdict, warrantsBrowserRetry } from './shared/classify';
import { closeTemporaryContext, newFreshContext } from './trawl/browser';
import { routeChallengeWait } from './trawl/tiers/utils/challengeRouter';
import { BadRequest, captureScreenshot, validateScreenshotRequest } from './screenshot';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

const ALLOW_LOCAL_WEBHOOKS =
  (process.env.ALLOW_LOCAL_WEBHOOKS || 'False').toUpperCase() === 'TRUE';

const PROXY_SERVER = process.env.PROXY_SERVER || null;
const PROXY_USERNAME = process.env.PROXY_USERNAME || null;
const PROXY_PASSWORD = process.env.PROXY_PASSWORD || null;

// ---------------------------------------------------------------------------
// SSRF guard -- unchanged from the pre-trawl version of this service. This is
// the layer Firecrawl's own maintainers flagged as un-patchable *inside* the
// browser itself (redirect-to-local-IP bypasses any pre-navigation URL
// check); the actual guard is startSSRFProxy below, which validates the
// resolved IP of every connection it forwards, including ones made
// mid-navigation. trawl's own threat model doesn't include this (it's built
// to run as an operator-trusted scraping proxy, not to fetch URLs on behalf
// of untrusted callers) -- wireSsrfProxy() below is what makes every trawl
// tier default through this proxy instead of leaving that gap open. Do not
// replace isInternalHost's range check with a hand-rolled private-range list
// -- ipaddr.js's .range() already classifies loopback/link-local/RFC1918/CGNAT
// correctly, which is the exact class of bug (a missing 172.16/12 case) that
// motivated using a maintained library here instead.
// ---------------------------------------------------------------------------

class InsecureConnectionError extends Error {
  constructor(
    public readonly blockedUrl: string,
    reason: string,
  ) {
    super(`Blocked insecure target URL "${blockedUrl}": ${reason}`);
    this.name = 'InsecureConnectionError';
  }
}

const isInternalHost = async (hostname: string): Promise<boolean> => {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return true;

  let addresses: string[];
  if (IPAddr.isValid(host)) {
    addresses = [host];
  } else {
    try {
      addresses = (await lookup(host, { all: true })).map((a) => a.address);
    } catch {
      return true;
    }
  }
  return (
    addresses.length === 0 ||
    addresses.some((a) => IPAddr.parse(a).range() !== 'unicast')
  );
};

const assertSafeTargetUrl = async (urlString: string): Promise<void> => {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(urlString);
  } catch {
    throw new InsecureConnectionError(urlString, 'URL is invalid');
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new InsecureConnectionError(
      urlString,
      `unsupported protocol "${parsedUrl.protocol}"`,
    );
  }
  if (!ALLOW_LOCAL_WEBHOOKS && (await isInternalHost(parsedUrl.hostname))) {
    throw new InsecureConnectionError(
      urlString,
      'resolves to a private/internal address',
    );
  }
};

const buildUpstreamProxyUrl = (): string | undefined => {
  if (!PROXY_SERVER) return undefined;
  const server = PROXY_SERVER.includes('://')
    ? PROXY_SERVER
    : `http://${PROXY_SERVER}`;
  const url = new URL(server);
  if (PROXY_USERNAME) url.username = PROXY_USERNAME;
  if (PROXY_PASSWORD) url.password = PROXY_PASSWORD;
  return url.toString();
};

const startSSRFProxy = async (): Promise<{ port: number; url: string }> => {
  const server = new Server({
    port: 0,
    host: '127.0.0.1',
    prepareRequestFunction: async ({ hostname }) => {
      if (!ALLOW_LOCAL_WEBHOOKS && (await isInternalHost(hostname))) {
        throw new RequestError(
          'Blocked: target resolves to a private/internal address',
          403,
        );
      }
      return { upstreamProxyUrl: buildUpstreamProxyUrl() };
    },
  });
  await server.listen();
  return { port: server.port, url: `http://127.0.0.1:${server.port}` };
};

const isValidUrl = (urlString: string): boolean => {
  try {
    new URL(urlString);
    return true;
  } catch (_) {
    return false;
  }
};

interface UrlModel {
  url: string;
  wait_after_load?: number;
  timeout?: number;
  headers?: { [key: string]: string };
  check_selector?: string;
  skip_tls_verification?: boolean;
}

let poolReady = false;

app.get('/health', async (_req: Request, res: Response) => {
  if (!poolReady) {
    return res.status(503).json({ status: 'unhealthy', error: 'browser pool not initialized' });
  }
  res.status(200).json({ status: 'healthy', engine: 'camoufox+trawl', screenshot: true });
});

app.post('/scrape', async (req: Request, res: Response) => {
  const {
    url,
    wait_after_load,
    timeout = 15000,
    headers,
    check_selector,
    skip_tls_verification,
  }: UrlModel = req.body;

  console.log(`================= Scrape Request =================`);
  console.log(`URL: ${url}`);
  console.log(`Timeout: ${timeout}`);
  console.log(`Headers: ${headers ? JSON.stringify(headers) : 'None'}`);
  console.log(`Wait After Load: ${wait_after_load ?? 0}`);
  console.log(`Skip TLS Verification: ${skip_tls_verification ?? false}`);
  // check_selector is the one field of the old contract still unimplemented.
  // Firecrawl's own playwright engine never sends it (see
  // apps/api/src/scraper/scrapeURL/engines/playwright/index.ts, which sends only
  // url/wait_after_load/timeout/headers/skip_tls_verification), so nothing in
  // this deployment relies on it -- but warn rather than drop it silently in case
  // some other caller does.
  if (check_selector) {
    console.warn(
      `⚠️  check_selector was requested but is not implemented on this service -- ignored. (check_selector=${check_selector})`,
    );
  }
  console.log(`==================================================`);

  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  if (!isValidUrl(url)) {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  try {
    await assertSafeTargetUrl(url);
  } catch (error) {
    if (error instanceof InsecureConnectionError) {
      return res.json({
        content: '',
        pageStatusCode: 403,
        pageError: error.message,
      });
    }
    throw error;
  }

  if (!PROXY_SERVER) {
    console.warn(
      '⚠️ WARNING: No proxy server provided. Your IP address may be blocked.',
    );
  }

  if (!poolReady) {
    return res.status(503).json({ error: 'Browser pool not ready yet' });
  }

  const scrapeReq: ScrapeRequest = {
    url,
    maxTimeout: timeout,
    // Forwarded as-is, Cookie header included. Unlike the pre-trawl version of
    // this service, there is no redirect-safe cookie-jar seeding here -- that
    // was a fix for a Chromium/Playwright bug (Cookie header dropped across a
    // redirect hop) specific to this service's own hand-rolled context setup,
    // and trawl's tiers don't carry an equivalent. Known gap, not yet ported.
    headers,
    skipTlsVerification: skip_tls_verification,
    waitAfterLoad: wait_after_load,
  };

  try {
    let result = await scrape(scrapeReq, getTrawlDeps());

    // Re-judge what came back, against the whole body rather than whichever window
    // the answering tier happened to use. Tier 1 detects against a bounded 4096-byte
    // preview, so a challenge marker beyond it -- zenithbank.com's sits at 4865 --
    // reaches here labelled a successful scrape. Two shapes are worth one more
    // attempt through the browser tiers: a challenge trawl did not see, and a
    // client-rendered shell trawl does not look for at all. Both are answered by a
    // browser; a plain fetch cannot improve on either.
    let verdict = classifyContent(result.html, result.responseHeaders ?? {}, result.statusCode);

    if (warrantsBrowserRetry(verdict) && result.tier === 1) {
      console.log(`↻ Tier 1 returned ${describeVerdict(verdict, result.html)} -- retrying via browser tiers`);
      try {
        result = await scrape({ ...scrapeReq, skipHttp: true }, getTrawlDeps());
        verdict = classifyContent(result.html, result.responseHeaders ?? {}, result.statusCode);
      } catch (retryError) {
        // The original was a valid 200. If the browser path cannot do better, keep
        // it rather than turning a thin success into a hard failure.
        console.warn(
          `↻ Browser-tier retry failed, keeping the Tier 1 result: ${retryError instanceof Error ? retryError.message : retryError}`,
        );
      }
    }

    // A challenge page that survived the browser tiers is not content, and saying so
    // is the honest answer. Reporting it as a 200 is what let an Imperva interstitial
    // be stored as a bank's homepage and have "links" extracted from it. Surfacing it
    // as a block instead lets Firecrawl fall through to its remaining engines and,
    // failing those, lets the mapping service's existing WAF handling see it for what
    // it is.
    const blockedByChallenge = verdict.kind === "challenge";

    const pageError = blockedByChallenge
      ? `Blocked by ${(verdict as { waf: string }).waf} challenge`
      : result.statusCode !== 200
        ? getError(result.statusCode)
        : undefined;

    if (!pageError) {
      console.log(`✅ Scrape successful! (tier ${result.tier}, ${result.totalMs}ms)`);
    } else if (blockedByChallenge) {
      console.log(
        `🚫 ${describeVerdict(verdict, result.html)} survived tier ${result.tier} -- reporting as blocked`,
      );
    } else {
      console.log(
        `🚨 Scrape failed with status code: ${result.statusCode} ${pageError} (tier ${result.tier})`,
      );
    }

    res.json({
      content: result.html,
      pageStatusCode: blockedByChallenge ? 403 : result.statusCode,
      contentType: result.contentType,
      ...(pageError && { pageError }),
    });
  } catch (error) {
    if (error instanceof InsecureConnectionError) {
      return res.json({
        content: '',
        pageStatusCode: 403,
        pageError: error.message,
      });
    }
    if (error instanceof ScrapeError) {
      console.log(`🚨 All tiers exhausted: ${error.message}`);
      return res.json({
        content: '',
        pageStatusCode: 502,
        pageError: error.message,
      });
    }
    console.error('Scrape error:', error);
    res
      .status(500)
      .json({ error: 'An error occurred while fetching the page.' });
  }
});

// POST /screenshot -- a picture of a page, or of one element of it (selector or quoted text). See screenshot.ts and the README.
// Same SSRF guard as /scrape; browser tiers only; a page still behind a WAF challenge comes back as status "blocked", never as a picture.
app.post('/screenshot', async (req: Request, res: Response) => {
  let parsed;
  try {
    parsed = validateScreenshotRequest(req.body);
  } catch (error) {
    if (error instanceof BadRequest) return res.status(400).json({ status: 'error', error: error.message });
    throw error;
  }
  if (!isValidUrl(parsed.url)) {
    return res.status(400).json({ status: 'error', error: 'Invalid URL' });
  }
  try {
    await assertSafeTargetUrl(parsed.url);
  } catch (error) {
    if (error instanceof InsecureConnectionError) {
      return res.status(403).json({ status: 'error', pageError: error.message });
    }
    throw error;
  }
  if (!poolReady) {
    return res.status(503).json({ status: 'error', error: 'Browser pool not ready yet' });
  }
  console.log(`Screenshot request: ${parsed.url} target=${parsed.target === undefined ? 'none' : typeof parsed.target === 'string' ? 'selector' : 'text'} full_page=${parsed.full_page}`);
  try {
    const trawl = getTrawlDeps();
    const result = await captureScreenshot(parsed, {
      acquireBrowser: trawl.acquireBrowser,
      releaseBrowser: trawl.releaseBrowser,
      newContext: (browser, opts) => newFreshContext(browser, opts),
      closeContext: (ctx, requestReplacement) => closeTemporaryContext(ctx, requestReplacement, 'screenshot context cleanup timed out'),
      waitChallenge: (page, html, headers, timeoutMs, url, status) =>
        routeChallengeWait(page, html, headers, timeoutMs, url, undefined, status),
      classify: (html, headers, status) => classifyContent(html, headers, status) as { kind: string; waf?: string },
    });
    res.json(result);
  } catch (error) {
    console.error('Screenshot error:', error);
    res.status(500).json({ status: 'error', error: 'An error occurred while taking the screenshot.' });
  }
});

const start = async () => {
  const ssrfProxy = await startSSRFProxy();
  wireSsrfProxy(ssrfProxy.url);
  await initTrawlPool();
  poolReady = true;
  app.listen(port, () => {
    console.log(`Camoufox+trawl service is running on port ${port}`);
  });
};
start().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});

if (require.main === module) {
  process.on('SIGINT', () => {
    shutdownTrawlPool().then(() => {
      console.log('Browser pool closed');
      process.exit(0);
    });
  });
}
