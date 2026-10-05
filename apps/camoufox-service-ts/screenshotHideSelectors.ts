// Selectors hidden before a /screenshot capture so the picture shows the page, not its cookie banner or sticky ad.
// A small data list, easy to extend: add a selector here, nothing else. Everything is hidden with `display: none !important`.
// Second list: text a fixed or sticky overlay must contain to be treated as a consent dialog (checked case-insensitively).

export const HIDE_SELECTORS: string[] = [
  '#onetrust-banner-sdk',
  '#onetrust-consent-sdk',
  '#CybotCookiebotDialog',
  '#cookie-banner',
  '#cookie-notice',
  '#cookieconsent',
  '#gdpr-cookie-notice',
  '#truste-consent-track',
  '#didomi-host',
  '#qc-cmp2-container',
  '.cc-window',
  '.cookie-banner',
  '.cookie-consent',
  '.cookie-notice',
  '.cmp-container',
  '.fc-consent-root',
  '.sp_message_container',
  'div[id^="sp_message_container"]',
  'iframe[id^="sp_message_iframe"]',
  '[aria-label*="cookie" i]',
  '[aria-label*="consent" i]',
  '[class*="cookie-banner" i]',
  '[class*="consent-banner" i]',
  '[class*="newsletter-popup" i]',
  '[class*="sticky-ad" i]',
  '[id*="google_ads_iframe"]',
  '[data-testid="ad-slot"]',
]

export const CONSENT_TEXT: RegExp = /\b(cookies?|consent|gdpr|privacy choices|we value your privacy)\b/i
