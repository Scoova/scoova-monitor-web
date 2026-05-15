# Changelog

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
