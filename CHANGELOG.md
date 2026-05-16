# Changelog

## 1.4.1

- `dist/monitor.js` (the `<script>`-tag / CDN build) is now a classic
  script. 1.4.0 shipped it as an ES module, which broke plain
  `<script src>` usage in the browser. npm `import` usage was unaffected.

## 1.4.0

Initial public release of the Scoova Monitor Web SDK.

- Error tracking — uncaught errors and unhandled promise rejections
- Web Vitals (FCP, LCP, FID, CLS, TTFB) and navigation timing
- Page-view tracking and custom analytics events
- Network request performance tracking
- Structured logging with tagged loggers
- Privacy: user IDs are SHA-256 hashed in the browser before sending;
  no device location is collected
- GDPR / CCPA `clearLocalUserData()` helper
