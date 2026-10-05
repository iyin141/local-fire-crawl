# camoufox-service

Browser rendering service for this Firecrawl stack: Camoufox (Firefox) driven by the vendored `trawl` tiers, with a Playwright-service-shaped
`POST /scrape` contract. Port 3000 inside the container.

| Route | Purpose |
|---|---|
| `GET /health` | `{status, engine, screenshot: true}` once the browser pool is warm, else 503. |
| `POST /scrape` | Render a URL and return its HTML (used by the Firecrawl api's `playwright` engine). |
| `POST /screenshot` | Capture a picture of a page, or of one element of it. See below. |

## `POST /screenshot`

Added for a downstream pipeline that wants a picture of the passage a claim cites (a headline, a quoted sentence, an official statement).
The service stays general: nothing here knows about that pipeline. Firecrawl's engine feature flags are unchanged; the `playwright` engine still declares
`screenshot: false`, and `/scrape` is untouched. Only a caller that talks to this service directly can use `/screenshot`.

**Request** (JSON)

| Field | Default | Meaning |
|---|---|---|
| `url` | required | `http` or `https` only. |
| `target` | none | A CSS selector string, or `{"text": "a quoted sentence"}` (the deepest element containing it; matched on the first 160 characters, whitespace and case ignored). |
| `full_page` | `false` | Capture the whole page (height capped at 16,000 px). Ignored when a target is given. |
| `viewport` | `{width: 1920, height: 1080}` | Width 320 to 3840, height 240 to 2160. |
| `padding_px` | `24` | Padding around the target's box, 0 to 200. |
| `timeout` | `45` | Seconds, 1 to 120. Matches the measured Camoufox/WAF timings. |

**Response** (JSON, HTTP 200 unless the request is refused)

```
{status: "ok" | "blocked" | "error", png_base64?, final_url?, page_title?, bbox?: {x, y, w, h}, matched: true | false | null,
 tier: "browser", timing_ms, waf?, pageError?, truncated?}
```

- `matched` is `true` when the target was found and the picture is cropped to it, `false` when it was not found (the picture is then the top of the
  page, not the target), `null` when no target was asked for.
- A page still behind a WAF challenge comes back as `status: "blocked"` with `waf` set. **No picture is ever returned of a challenge page.**
- Cookie banners, consent dialogs and sticky ads are hidden before the capture (`screenshotHideSelectors.ts`: a short selector list plus a generic
  rule for fixed or sticky overlays that mention cookies or consent). Add a selector there to extend it.
- Safety: the same `assertSafeTargetUrl` and SSRF-guard proxy as `/scrape`; private, loopback and link-local targets are refused with HTTP 403.
  The request is limited to one pooled browser, always released and its context closed, on every path. A picture over 8 MB is refused.
  Bad input is HTTP 400.

### Reaching it from the host

By default no host port is published (the api reaches this service over the backend network). To use `/screenshot` from the host, add the loopback-only
override and rebuild only this service:

```
docker compose -f docker-compose.yaml -f docker-compose.screenshot.yaml up -d --build camoufox-service
```

That publishes `127.0.0.1:3004 -> 3000`. The service has no authentication, so keep it on loopback.

### Tests

`pnpm test` runs `__tests__/screenshot.test.ts` (request validation, clip geometry, and the capture flow with a fake page: target found and not found,
text target, banner hiding, blocked challenge, load failure, size cap, full-page cap, and that the context is closed and the browser released on every path).
