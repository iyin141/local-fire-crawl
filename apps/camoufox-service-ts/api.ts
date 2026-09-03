import express, { Request, Response } from 'express';
import dotenv from 'dotenv';
import { getError } from './helpers/get_error';
import { lookup } from 'dns/promises';
import IPAddr from 'ipaddr.js';
import { Server, RequestError } from 'proxy-chain';
import { ScrapeError, scrape } from './trawl/tiers';
import type { ScrapeRequest } from './trawl/types';
import { getTrawlDeps, initTrawlPool, shutdownTrawlPool, wireSsrfProxy } from './trawl-deps';

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
  res.status(200).json({ status: 'healthy', engine: 'camoufox+trawl' });
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
  // wait_after_load, check_selector, and skip_tls_verification are accepted for
  // request-shape compatibility with the old playwright-service/camoufox-only
  // contract, but are NOT implemented against trawl's orchestrator -- its
  // ScrapeRequest type has no equivalent fields, and threading them through
  // (into orchestrator.ts -> tiers 2-4 -> pool.ts's context creation) touches
  // vendored package internals across three files for what was, until now, a
  // narrow need (skip_tls_verification specifically mattered for CHELLARAM's
  // broken cert chain during validation). Logged loudly rather than silently
  // dropped so a caller relying on them notices in the logs, not just in
  // unexpectedly-unmet expectations.
  if (wait_after_load || check_selector || skip_tls_verification) {
    console.warn(
      `⚠️  wait_after_load/check_selector/skip_tls_verification were requested but are not supported via the trawl-orchestrated path -- ignored. (wait_after_load=${wait_after_load}, check_selector=${check_selector}, skip_tls_verification=${skip_tls_verification})`,
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
  };

  try {
    const result = await scrape(scrapeReq, getTrawlDeps());
    const pageError =
      result.statusCode !== 200 ? getError(result.statusCode) : undefined;

    if (!pageError) {
      console.log(`✅ Scrape successful! (tier ${result.tier}, ${result.totalMs}ms)`);
    } else {
      console.log(
        `🚨 Scrape failed with status code: ${result.statusCode} ${pageError} (tier ${result.tier})`,
      );
    }

    res.json({
      content: result.html,
      pageStatusCode: result.statusCode,
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
