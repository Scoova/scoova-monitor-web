# Scoova Monitor — Web SDK

Browser SDK for error tracking, analytics, page-view tracking, network
performance, and Web Vitals. Pure TypeScript, no framework deps. ES2020.

## Install

### NPM (bundled)

```bash
npm install @scoova/monitor-web
```

```typescript
import { ScoovaMonitor } from '@scoova/monitor-web'

ScoovaMonitor.init('sm_your_api_key')
```

### Script tag (CDN)

```html
<script src="https://cdn.scoo-va.info/monitor.js"></script>
<script>ScoovaMonitor.init('sm_your_api_key')</script>
```

Self-hosting the script? Build it (`npm run build`) and serve
`dist/monitor.js`.

## Configuration

```typescript
ScoovaMonitor.init('sm_your_api_key', {
  endpoint: 'https://monitor.scoo-va.info',   // self-hosted? change this
  enableErrorTracking: true,
  enablePerformance: true,
  enablePageViews: true,
  enableNetworkTracking: true,
  enableConsoleErrors: true,
  samplingRate: 1.0,                           // 0.0 – 1.0
  flushIntervalMs: 300_000,                    // 5 minutes
  maxBatchSize: 50,
})
```

The Web SDK does not probe for third-party scripts and does not collect
location — see [the documentation](https://monitor.scoo-va.info/docs)
for the full collection inventory.

## API

### Identify the user

```typescript
ScoovaMonitor.setUserId('user_123')
```

The user ID is hashed before it leaves the browser. Without `setUserId`
the SDK falls back to an anonymous installation ID stored in
`localStorage`.

### Track events

```typescript
ScoovaMonitor.trackEvent('checkout_started', {
  plan: 'annual',
  amount: '29.99',
})
```

### Track page views

Auto-tracked when `enablePageViews: true` (the default). Manual:

```typescript
ScoovaMonitor.trackPageView('/checkout')
```

### Capture errors

Uncaught errors and unhandled promise rejections are captured automatically
when `enableErrorTracking: true`. Manual:

```typescript
try {
  await riskyWork()
} catch (e) {
  ScoovaMonitor.captureError(e as Error)
}
```

### Breadcrumbs

```typescript
ScoovaMonitor.addBreadcrumb('Started photo upload', 'media')
```

### Tagged loggers

```typescript
const log = ScoovaMonitor.logger('payment')
log.info('Started checkout', { amount: '29.99' })
log.error('Card declined', { code: 'card_declined' })
```

### Right-to-erasure (GDPR / CCPA)

```typescript
ScoovaMonitor.clearLocalUserData()
```

Wipes queued events from `localStorage`, pending crash payloads,
breadcrumbs, the anonymous installation ID, the session counter, and the
first-launch marker. Pair with a server-side
`DELETE /v1/ingest/me/{userId}`.

### Manual flush

```typescript
await ScoovaMonitor.flush()
```

The SDK auto-flushes every 5 minutes, on `visibilitychange → hidden`
(via `sendBeacon` when available), and when the batch threshold is hit.
Manual flush is rarely needed.

## Source maps

For de-obfuscated stack traces in the dashboard, upload your bundle's
source maps after each release:

```bash
sdk-web/scripts/scoova-upload-sourcemaps.js \
    --api-key sm_your_api_key \
    --version 1.0.0 \
    --dir ./dist
```

See [the documentation](https://monitor.scoo-va.info/docs) for the full setup
including CSP allowlists.

## Building from source

```bash
cd sdk-web
npm install
npm run build       # emits dist/monitor.js
```

## License

[Apache 2.0](LICENSE).
