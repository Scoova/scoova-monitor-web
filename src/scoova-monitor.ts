/**
 * Scoova Monitor — Web SDK
 *
 * Lightweight JavaScript SDK for web applications.
 * Captures errors, performance (Web Vitals), page views, network requests, and custom events.
 *
 * Usage:
 *   <script src="https://cdn.scoo-va.info/monitor.js"></script>
 *   <script>ScoovaMonitor.init("sm_your_api_key");</script>
 *
 * Or via npm:
 *   import { ScoovaMonitor } from '@scoova/monitor-web';
 *   ScoovaMonitor.init("sm_your_api_key");
 */

interface Config {
  endpoint?: string
  enableErrorTracking?: boolean
  enablePerformance?: boolean
  enablePageViews?: boolean
  enableNetworkTracking?: boolean
  enableConsoleErrors?: boolean
  samplingRate?: number
  flushIntervalMs?: number
  maxBatchSize?: number
}

interface DeviceInfo {
  manufacturer: string
  model: string
  osName: string
  osVersion: string
  appVersion: string | null
  locale: string
  timezone: string
  country: string
  screenResolution: string
  networkType: string
  framework: string
  sdkVersion: string
  userAgent: string
  referrer: string
  pageUrl: string
}

interface LogEntry {
  level: string
  tag: string
  message: string
  data?: Record<string, string>
  userId?: string | null
  sessionId?: string
  timestamp: string
}

const SDK_VERSION = '1.4.0'
const HTTP_TIMEOUT_MS = 10_000
const FAILURE_BACKOFF_THRESHOLD = 3
const MAX_QUEUE_PERSISTED = 500 // per-queue cap for localStorage; 500 × ~500B ≈ 250KB

/**
 * In-memory queue with localStorage persistence. Survives page reloads / browser
 * crashes. When the SDK can't reach the server, items stay queued and the next
 * flush attempt picks them up.
 *
 * localStorage operations are synchronous in the browser, so unlike the RN
 * SDK's PersistentQueue we don't need a serialization chain.
 */
class PersistentQueue<T> {
  private items: T[] = []
  constructor(private storageKey: string, private max: number = MAX_QUEUE_PERSISTED) {
    try {
      const raw = localStorage.getItem(storageKey)
      if (raw) this.items = JSON.parse(raw)
    } catch { /* localStorage unavailable / private mode / corrupt */ }
  }
  push(item: T) {
    this.items.push(item)
    while (this.items.length > this.max) this.items.shift()
    this.save()
  }
  pushAll(items: T[]) {
    if (!items.length) return
    this.items.push(...items)
    while (this.items.length > this.max) this.items.shift()
    this.save()
  }
  take(n: number): T[] {
    const batch = this.items.splice(0, n)
    this.save()
    return batch
  }
  /** Wipe in-memory + persisted contents. Used by clearLocalUserData. */
  clear() {
    this.items = []
    try { localStorage.removeItem(this.storageKey) } catch { /* */ }
  }
  get length() { return this.items.length }
  private save() {
    try { localStorage.setItem(this.storageKey, JSON.stringify(this.items)) } catch { /* quota / private mode */ }
  }
}

/**
 * Pending crash store for the web. Crashes are saved to localStorage BEFORE
 * the network POST, so a tab crash / page navigation in the next tick still
 * leaves the report on disk for the next session to replay. Mirrors the RN
 * SDK's PendingCrashStore and the native iOS/Android crash handlers.
 */
class WebPendingCrashStore {
  private static KEY = 'sm_pending_crashes'
  private static MAX = 10

  /** Synchronous (localStorage) — completes before the function returns. */
  static save(payload: any): void {
    try {
      const raw = localStorage.getItem(WebPendingCrashStore.KEY)
      const arr: any[] = raw ? JSON.parse(raw) : []
      arr.push(payload)
      while (arr.length > WebPendingCrashStore.MAX) arr.shift()
      localStorage.setItem(WebPendingCrashStore.KEY, JSON.stringify(arr))
    } catch { /* quota / private mode */ }
  }

  /** Atomically read + clear. Caller restores any not-yet-sent items. */
  static drain(): any[] {
    try {
      const raw = localStorage.getItem(WebPendingCrashStore.KEY)
      if (!raw) return []
      localStorage.removeItem(WebPendingCrashStore.KEY)
      return JSON.parse(raw)
    } catch { return [] }
  }

  static restore(unsent: any[]): void {
    if (!unsent.length) return
    try {
      const raw = localStorage.getItem(WebPendingCrashStore.KEY)
      const arr: any[] = raw ? JSON.parse(raw) : []
      arr.unshift(...unsent)
      while (arr.length > WebPendingCrashStore.MAX) arr.shift()
      localStorage.setItem(WebPendingCrashStore.KEY, JSON.stringify(arr))
    } catch { /* quota / private mode */ }
  }
}

/**
 * Anonymous installation ID — used to count unique users / sessions / retention
 * when the host app hasn't called setUserId. Persists across page reloads via
 * localStorage; resets only when the user clears site data. Naming convention:
 *   - "anon_<uuid>" — anonymous, generated on first init
 *   - "h_<sha256-prefix>" — set when setUserId(realId) is called
 *
 * Server-side analytics treat any non-null userId as a unique-user signal,
 * so DAU/MAU and session-per-user work whether or not the host identifies.
 */
function getOrCreateAnonId(): string {
  const KEY = 'sm_anon_id'
  try {
    const existing = localStorage.getItem(KEY)
    if (existing && existing.startsWith('anon_')) return existing
    const fresh = 'anon_' + 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
    })
    localStorage.setItem(KEY, fresh)
    return fresh
  } catch {
    // Private mode / no localStorage — fall back to a per-tab UUID. Better
    // than nothing; analytics will treat it as a separate user per session.
    return 'anon_' + Math.random().toString(36).slice(2) + Date.now().toString(36)
  }
}

class ScoovaMonitorSDK {
  private apiKey = ''
  private endpoint = 'https://monitor.scoo-va.info'
  private anonId = ''
  private initialized = false
  private userId: string | null = null
  private sessionId = ''
  private sessionNumber = 0
  private eventQueue = new PersistentQueue<any>('sm_q_events')
  private logQueue = new PersistentQueue<LogEntry>('sm_q_logs')
  private metricQueue = new PersistentQueue<any>('sm_q_metrics')
  private breadcrumbs: { message: string; category: string; timestamp: string }[] = []
  private flushTimer: ReturnType<typeof setInterval> | null = null
  private consecutiveFailures = 0
  private flushing = false
  private config: Required<Config> = {
    endpoint: 'https://monitor.scoo-va.info',
    enableErrorTracking: true,
    enablePerformance: true,
    enablePageViews: true,
    enableNetworkTracking: true,
    enableConsoleErrors: true,
    samplingRate: 1.0,
    flushIntervalMs: 300000, // 5 minutes — flush is also triggered by batch size, visibilitychange→hidden (sendBeacon), and crashes (which use a separate immediate path)
    maxBatchSize: 50,
  }

  /**
   * Initialize the SDK.
   */
  init(apiKey: string, config?: Config) {
    if (this.initialized) return
    this.apiKey = apiKey
    if (config) Object.assign(this.config, config)
    this.endpoint = this.config.endpoint
    this.initialized = true

    // Anonymous installation ID — survives reloads, resets on site-data clear.
    // Used as the default userId for DAU/MAU/retention until/unless the host
    // app calls setUserId(realId).
    this.anonId = getOrCreateAnonId()

    // Session
    this.sessionId = this.generateId()
    this.sessionNumber = parseInt(localStorage.getItem('sm_session_number') || '0') + 1
    localStorage.setItem('sm_session_number', String(this.sessionNumber))

    // Install error handlers
    if (this.config.enableErrorTracking) this.installErrorHandlers()
    if (this.config.enableConsoleErrors) this.installConsoleCapture()

    // Auto page view tracking
    if (this.config.enablePageViews) this.installPageViewTracking()

    // Auto network tracking
    if (this.config.enableNetworkTracking) this.installNetworkTracking()

    // Web Vitals
    if (this.config.enablePerformance) this.trackWebVitals()

    // Battery tracking (Chrome/Edge Battery API)
    this.trackBattery()

    // Flush timer
    this.flushTimer = setInterval(() => this.flush(), this.config.flushIntervalMs)

    // Flush on page hide
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.flush()
    })

    // First launch detection
    if (!localStorage.getItem('sm_first_launch_done')) {
      localStorage.setItem('sm_first_launch_done', 'true')
      this.trackEvent('first_launch')
      this.detectThirdPartySDKs()
    }

    // Install attribution: parse UTM params from the URL on first load.
    // We persist the result so subsequent sessions still know where the
    // user came from (otherwise it's lost the moment they navigate).
    // Standard params: utm_source / utm_medium / utm_campaign + the
    // document.referrer hostname as a fallback for organic referrals.
    this.captureInstallAttribution()

    // Track session start
    this.trackEvent('session_start', { session_id: this.sessionId })

    // Drain any items the previous session left in localStorage (failed POSTs).
    void this.flush()

    // Replay any pending crashes that the previous session couldn't deliver
    // (e.g. tab was killed before the fetch completed).
    void this.sendPendingCrashes()

    console.log('[ScoovaMonitor] Initialized v' + SDK_VERSION)
  }

  // ─── Public API ───

  /**
   * Track a custom analytics event.
   */
  trackEvent(name: string, data?: Record<string, string>) {
    if (!this.initialized) return
    this.eventQueue.push({
      eventName: name,
      eventData: this.sanitizeData(data),
      userId: this.hashUserId(this.userId),
      sessionId: this.sessionId,
      sessionNumber: this.sessionNumber || undefined,
      device: this.collectDevice(),
      timestamp: new Date().toISOString(),
    })
    if (this.eventQueue.length >= this.config.maxBatchSize) void this.flush()
  }

  /**
   * Set user ID (hashed before sending). If we'd been emitting events
   * under an anon_<uuid> until now and the host is identifying for the
   * first time on this install, fire one /v1/ingest/identify so the
   * server can merge the anon profile into the real one and downstream
   * DAU/MAU/cohort queries dedupe across the handoff.
   *
   * Idempotent: if setUserId is called twice with the same id, we won't
   * re-fire identify (this.identifySent is set on first success). If it's
   * called with a different real id, we fire again so the alias graph
   * stays consistent (anon → most recent real id).
   */
  setUserId(userId: string) {
    const previousUserId = this.userId
    this.userId = userId
    // Only call identify when we actually have an anon to merge, the new
    // user id differs from what we were previously sending, and we
    // haven't already sent identify for this exact (anon, user) pair.
    if (!userId || !this.anonId) return
    if (previousUserId === userId && this.identifySent) return
    const hashedNew = 'h_' + this.sha256(userId)
    if (this.lastIdentifiedAs === hashedNew) return
    void this.fireIdentify(this.anonId, hashedNew)
  }

  private identifySent = false
  private lastIdentifiedAs: string | null = null

  private async fireIdentify(anonId: string, hashedUserId: string) {
    try {
      const ok = await this.postJSON('/v1/ingest/identify',
        { anonId, userId: hashedUserId })
      if (ok) {
        this.identifySent = true
        this.lastIdentifiedAs = hashedUserId
      }
    } catch { /* best-effort — server merge is opportunistic */ }
  }

  /**
   * Get a tagged logger.
   */
  logger(tag: string) {
    return {
      debug: (msg: string, data?: Record<string, string>) => this.log(tag, 'debug', msg, data),
      info: (msg: string, data?: Record<string, string>) => this.log(tag, 'info', msg, data),
      warning: (msg: string, data?: Record<string, string>) => this.log(tag, 'warning', msg, data),
      error: (msg: string, data?: Record<string, string>) => this.log(tag, 'error', msg, data),
    }
  }

  /**
   * Log an event with level and tag.
   */
  log(tag: string, level: string, message: string, data?: Record<string, string>) {
    if (!this.initialized) return
    this.logQueue.push({
      level,
      tag,
      message: this.sanitizeMessage(message),
      data: this.sanitizeData(data),
      userId: this.hashUserId(this.userId),
      sessionId: this.sessionId,
      timestamp: new Date().toISOString(),
    })
    this.addBreadcrumb(`[${level}] [${tag}] ${message}`, 'log')
    if (this.logQueue.length >= this.config.maxBatchSize) void this.flush()
  }

  /**
   * Report a caught error.
   */
  captureError(error: Error, context?: string) {
    this.reportError(error.name, error.message + (context ? ` | ${context}` : ''), error.stack || '', false)
  }

  /**
   * Add a breadcrumb.
   */
  addBreadcrumb(message: string, category = 'custom') {
    if (this.breadcrumbs.length >= 50) this.breadcrumbs.shift()
    this.breadcrumbs.push({ message, category, timestamp: new Date().toISOString() })
  }

  /**
   * Track a page view manually (auto-tracked by default for SPAs).
   */
  trackPageView(pageName?: string) {
    const page = pageName || window.location.pathname
    this.trackEvent('screen_view', {
      screen_name: page,
      referrer: document.referrer || '',
      url: window.location.href,
    })
    this.addBreadcrumb(`Page: ${page}`, 'navigation')
  }

  /**
   * Flush all pending data. Failed batches stay queued (in localStorage)
   * for the next attempt. Idempotent if a flush is already in progress.
   */
  async flush(): Promise<void> {
    if (!this.initialized || this.flushing) return
    if (this.consecutiveFailures >= FAILURE_BACKOFF_THRESHOLD) {
      // Skip this cycle but allow the next one to probe for recovery.
      this.consecutiveFailures--
      return
    }
    this.flushing = true
    try {
      await Promise.all([this.flushEvents(), this.flushLogs(), this.flushMetrics()])
    } finally {
      this.flushing = false
    }
  }

  /**
   * Wipe every piece of telemetry the SDK has buffered or persisted in
   * localStorage. Call this when the host app's user invokes "delete my
   * account" — pairs with the server-side `DELETE /v1/ingest/me/{userId}` to
   * satisfy GDPR Article 17 / CCPA "right to be forgotten" end-to-end.
   *
   * What this clears:
   *   - the in-memory + localStorage event / metric / log queues
   *   - any pending crash payloads from a prior session
   *   - breadcrumbs accumulated this session
   *   - the anonymous installation ID (a fresh one is generated immediately)
   *   - the persisted session counter + first-launch marker
   *   - the user_id set via setUserId()
   *
   * Does NOT contact the server. The host app should also call your server's
   * GDPR delete endpoint with the user_id you previously sent.
   */
  clearLocalUserData(): void {
    if (!this.initialized) return
    // Best-effort wipe — never throw and block the host's delete-account flow.
    try { this.eventQueue.clear() } catch { /* */ }
    try { this.logQueue.clear() } catch { /* */ }
    try { this.metricQueue.clear() } catch { /* */ }
    this.breadcrumbs = []
    this.userId = null
    try {
      localStorage.removeItem('sm_pending_crashes')
      localStorage.removeItem('sm_anon_id')
      localStorage.removeItem('sm_session_number')
      localStorage.removeItem('sm_first_launch_done')
    } catch { /* private mode */ }
    // Regenerate a fresh anon ID immediately so subsequent events still have
    // a non-null user_id.
    this.anonId = getOrCreateAnonId()
    this.sessionNumber = 0
    console.log('[ScoovaMonitor] Local user data cleared')
  }

  // ─── Install Attribution ───────────────────────────────────────
  //
  // Captures UTM params on first load + persists them so future
  // sessions can still attribute the user. Fires an `install_info`
  // event the server already understands (server side-effect updates
  // user_profiles.install_source / install_campaign).
  //
  // Order of preference for source:
  //   1. utm_source (e.g. "google", "facebook", "newsletter")
  //   2. document.referrer hostname (e.g. "twitter.com", "google.com")
  //   3. "direct" — neither set
  //
  // We persist under sm_install_attr the first time we see any of
  // these signals. Subsequent visits never overwrite — install
  // attribution is forever-set on first touch, that's the model
  // every adtech platform uses.

  private captureInstallAttribution() {
    try {
      // Already captured? Nothing to do.
      if (localStorage.getItem('sm_install_attr')) return

      const params = new URLSearchParams(window.location.search)
      const utmSource = params.get('utm_source')
      const utmMedium = params.get('utm_medium')
      const utmCampaign = params.get('utm_campaign')
      const utmContent = params.get('utm_content')
      const utmTerm = params.get('utm_term')

      // Referrer-based source for organic links (Twitter/Reddit/etc).
      // Empty string when the user typed the URL directly or arrived
      // from a private/HTTPS-mismatch page.
      let referrerHost = ''
      try {
        if (document.referrer) {
          const u = new URL(document.referrer)
          // Only count cross-origin referrals — same-site clicks aren't
          // acquisition events.
          if (u.hostname !== window.location.hostname) {
            referrerHost = u.hostname
          }
        }
      } catch { /* malformed referrer */ }

      const source =
        utmSource ||
        (referrerHost ? `referrer:${referrerHost}` : '') ||
        'direct'
      const campaign = utmCampaign || ''

      // Persist before sending so a failed network call still leaves a
      // record on the device. Future sessions skip this entire block.
      const attr = { source, campaign, medium: utmMedium || '', content: utmContent || '', term: utmTerm || '', capturedAt: new Date().toISOString() }
      localStorage.setItem('sm_install_attr', JSON.stringify(attr))

      // Fire the install_info event the server expects. Send the
      // structured fields under the keys the server's side-effect
      // handler reads.
      this.trackEvent('install_info', {
        install_source: source,
        install_campaign: campaign,
        install_medium: utmMedium || '',
        install_content: utmContent || '',
        install_term: utmTerm || '',
        referrer: referrerHost,
      })
    } catch { /* private mode / no localStorage */ }
  }

  // ─── Error Handling ───

  private installErrorHandlers() {
    // Uncaught errors
    window.addEventListener('error', (event) => {
      this.reportError(
        'UncaughtError',
        event.message || 'Unknown error',
        event.error?.stack || `at ${event.filename}:${event.lineno}:${event.colno}`,
        true
      )
    })

    // Unhandled promise rejections
    window.addEventListener('unhandledrejection', (event) => {
      const error = event.reason
      this.reportError(
        'UnhandledPromiseRejection',
        error?.message || String(error) || 'Unhandled rejection',
        error?.stack || '',
        true
      )
    })

    // ANR / main-thread hang detection. Two signals stitched together:
    //
    // 1. PerformanceObserver('longtask') — the OS-level signal. Anything
    //    over the threshold means JS held the main thread for that long.
    //    Symbolicated source isn't available from longtask entries, but
    //    the duration + attribution is.
    //
    // 2. setInterval drift — fallback for browsers without longtask
    //    support (Safari historically). If a 1s tick fires N seconds
    //    late, the main thread was blocked that long. Post-hoc but
    //    reliable.
    //
    // Both routes converge on reportError with exceptionType="ANR (...)"
    // so the dashboard can split ANR rate from crash rate the same way
    // Firebase / Sentry / Crashlytics do.
    this.installHangDetectors()
  }

  private installHangDetectors() {
    const HANG_THRESHOLD_MS = 5000
    const COOLDOWN_MS = 30000
    let nextAllowedReport = 0

    // Route 1: longtask observer
    try {
      const obs = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.duration < HANG_THRESHOLD_MS) continue
          const now = Date.now()
          if (now < nextAllowedReport) continue
          nextAllowedReport = now + COOLDOWN_MS
          this.reportError(
            'ANR (Main Thread Long Task)',
            `Browser main thread blocked for ${Math.round(entry.duration)}ms ` +
              `(>${HANG_THRESHOLD_MS}ms threshold). Source: PerformanceObserver longtask.`,
            `(longtask entries don't expose a JS stack — open the Performance ` +
              `panel around timestamp ${new Date(now).toISOString()} for the ` +
              `recorded flame chart.)`,
            false
          )
        }
      })
      obs.observe({ type: 'longtask', buffered: false })
    } catch (_) { /* longtask not supported (Safari) — Route 2 covers it */ }

    // Route 2: setInterval drift (works everywhere)
    let lastTick = Date.now()
    setInterval(() => {
      const now = Date.now()
      const drift = now - lastTick - 1000
      lastTick = now
      if (document.visibilityState === 'hidden') return // throttled in bg
      if (drift < HANG_THRESHOLD_MS) return
      if (now < nextAllowedReport) return
      nextAllowedReport = now + COOLDOWN_MS
      this.reportError(
        'ANR (Main Thread Hang)',
        `Browser main thread blocked for ~${drift}ms (>${HANG_THRESHOLD_MS}ms threshold).`,
        '(Hang detected via timer-drift after the JS thread unblocked. ' +
          'A pure-JS detector cannot capture the blocking stack.)',
        false
      )
    }, 1000)
  }

  private installConsoleCapture() {
    const originalError = console.error
    console.error = (...args: any[]) => {
      originalError.apply(console, args)
      const message = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')
      this.log('console', 'error', message)
    }
  }

  private reportError(type: string, message: string, stackTrace: string, isFatal: boolean) {
    const breadcrumbStr = this.breadcrumbs.length > 0
      ? '\n\n--- Breadcrumbs ---\n' + this.breadcrumbs.slice(-20).map(b => `[${b.timestamp}] [${b.category}] ${b.message}`).join('\n')
      : ''

    const payload = {
      exceptionType: type,
      message: this.sanitizeMessage(message),
      stackTrace: this.sanitizeStackTrace(stackTrace + breadcrumbStr),
      isFatal,
      device: this.collectDevice(),
      userId: this.hashUserId(this.userId),
      sessionId: this.sessionId,
      timestamp: new Date().toISOString(),
      _id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    }

    // 1. Save to localStorage SYNCHRONOUSLY first. Even if the JS engine is
    //    about to die or the page is about to navigate away, the write is
    //    already on disk by the time this returns.
    WebPendingCrashStore.save(payload)

    // 2. Try to send. On success, remove this entry from the pending store.
    void this.postJSON('/v1/ingest/crashes', payload).then(ok => {
      if (!ok) return
      const remaining = WebPendingCrashStore.drain().filter((p: any) => p?._id !== payload._id)
      if (remaining.length) WebPendingCrashStore.restore(remaining)
    })
  }

  /** Replay any crashes that were saved on disk by a prior session. */
  private async sendPendingCrashes(): Promise<void> {
    const pending = WebPendingCrashStore.drain()
    if (!pending.length) return
    const failed: any[] = []
    for (const payload of pending) {
      const ok = await this.postJSON('/v1/ingest/crashes', payload).catch(() => false)
      if (!ok) failed.push(payload)
    }
    if (failed.length) WebPendingCrashStore.restore(failed)
  }

  // ─── Performance (Web Vitals) ───

  private trackBattery() {
    // Battery Status API (Chrome, Edge, Opera — not Safari/Firefox)
    const nav = navigator as any
    if (!nav.getBattery) return

    nav.getBattery().then((battery: any) => {
      let lastLevel = battery.level
      let lastTime = Date.now()

      // Report initial level
      this.metricQueue.push({
        metricType: 'battery', metricName: 'level',
        value: battery.level * 100, unit: 'percent',
        timestamp: new Date().toISOString()
      })

      // Track level changes
      battery.addEventListener('levelchange', () => {
        const now = Date.now()
        const currentLevel = battery.level * 100
        const prevLevel = lastLevel * 100

        this.metricQueue.push({
          metricType: 'battery', metricName: 'level',
          value: currentLevel, unit: 'percent',
          timestamp: new Date().toISOString()
        })

        // Calculate drain rate (only when discharging)
        if (!battery.charging && prevLevel > currentLevel) {
          const timeDeltaHours = (now - lastTime) / 3600000
          if (timeDeltaHours > 0.01) {
            const drainPerHour = (prevLevel - currentLevel) / timeDeltaHours
            if (drainPerHour > 0 && drainPerHour < 100) {
              this.metricQueue.push({
                metricType: 'battery', metricName: 'drain_rate',
                value: drainPerHour, unit: 'percent_per_hour',
                timestamp: new Date().toISOString()
              })
            }
          }
        }

        lastLevel = battery.level
        lastTime = now
      })

      // Track charging state changes
      battery.addEventListener('chargingchange', () => {
        this.addBreadcrumb(
          battery.charging ? 'Charger connected' : 'Charger disconnected',
          'system'
        )
        lastLevel = battery.level
        lastTime = Date.now()
      })
    }).catch(() => {})
  }

  private trackWebVitals() {
    // First Contentful Paint
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.name === 'first-contentful-paint') {
            this.trackMetric('web_vital', 'FCP', entry.startTime, 'ms')
          }
        }
      })
      observer.observe({ type: 'paint', buffered: true })
    } catch (_) {}

    // Largest Contentful Paint
    try {
      const observer = new PerformanceObserver((list) => {
        const entries = list.getEntries()
        const last = entries[entries.length - 1] as any
        if (last) this.trackMetric('web_vital', 'LCP', last.startTime, 'ms')
      })
      observer.observe({ type: 'largest-contentful-paint', buffered: true })
    } catch (_) {}

    // First Input Delay
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as any[]) {
          this.trackMetric('web_vital', 'FID', entry.processingStart - entry.startTime, 'ms')
        }
      })
      observer.observe({ type: 'first-input', buffered: true })
    } catch (_) {}

    // Cumulative Layout Shift
    try {
      let clsValue = 0
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as any[]) {
          if (!entry.hadRecentInput) clsValue += entry.value
        }
      })
      observer.observe({ type: 'layout-shift', buffered: true })
      // Report CLS on page hide
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
          this.trackMetric('web_vital', 'CLS', clsValue, 'score')
        }
      })
    } catch (_) {}

    // Navigation timing
    window.addEventListener('load', () => {
      setTimeout(() => {
        const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming
        if (nav) {
          this.trackMetric('app_start', 'page_load', nav.loadEventEnd - nav.startTime, 'ms')
          this.trackMetric('web_vital', 'TTFB', nav.responseStart - nav.requestStart, 'ms')
          this.trackMetric('web_vital', 'DOM_interactive', nav.domInteractive - nav.startTime, 'ms')
        }
      }, 0)
    })
  }

  // ─── Page View Tracking (SPA aware) ───

  private installPageViewTracking() {
    // Track initial page
    this.trackPageView()

    // History API (pushState/replaceState)
    const origPushState = history.pushState
    const origReplaceState = history.replaceState
    const self = this

    history.pushState = function (...args: any) {
      origPushState.apply(this, args as any)
      self.trackPageView()
    }
    history.replaceState = function (...args: any) {
      origReplaceState.apply(this, args as any)
      self.trackPageView()
    }

    // Popstate (back/forward)
    window.addEventListener('popstate', () => this.trackPageView())
  }

  // ─── Network Tracking ───

  private installNetworkTracking() {
    // Intercept fetch
    const origFetch = window.fetch
    const self = this

    window.fetch = async function (input: RequestInfo | URL, init?: RequestInit) {
      const url = typeof input === 'string' ? input : (input as Request).url || String(input)

      // Skip our own requests
      if (url.includes('scoo-va.info')) return origFetch.call(this, input, init)

      const start = performance.now()
      try {
        const response = await origFetch.call(this, input, init)
        const duration = performance.now() - start
        self.trackMetric('network', 'fetch', duration, 'ms', {
          url: self.sanitizeUrl(url),
          httpMethod: init?.method || 'GET',
          statusCode: response.status,
        })
        return response
      } catch (error) {
        const duration = performance.now() - start
        self.trackMetric('network', 'fetch', duration, 'ms', {
          url: self.sanitizeUrl(url),
          httpMethod: init?.method || 'GET',
          statusCode: 0,
        })
        throw error
      }
    }

    // Intercept XMLHttpRequest
    const origOpen = XMLHttpRequest.prototype.open
    const origSend = XMLHttpRequest.prototype.send

    XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, async: boolean = true, user?: string | null, password?: string | null) {
      (this as any).__sm_method = method;
      (this as any).__sm_url = String(url)
      return origOpen.call(this, method, url, async, user ?? null, password ?? null)
    }

    XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
      const url: string = (this as any).__sm_url || ''
      if (url.includes('scoo-va.info')) return origSend.call(this, body)

      const start = performance.now()
      this.addEventListener('loadend', () => {
        const duration = performance.now() - start
        self.trackMetric('network', 'xhr', duration, 'ms', {
          url: self.sanitizeUrl(url),
          httpMethod: (this as any).__sm_method || 'GET',
          statusCode: this.status,
        })
      })
      return origSend.call(this, body)
    }
  }

  // ─── Third-party SDK Detection ───

  private detectThirdPartySDKs() {
    const detected: string[] = []
    const checks: Record<string, string> = {
      'ga': 'google-analytics', 'gtag': 'google-analytics',
      'fbq': 'facebook-pixel', 'FB': 'facebook-sdk',
      'Sentry': 'sentry', 'LogRocket': 'logrocket',
      'amplitude': 'amplitude', 'mixpanel': 'mixpanel',
      'Intercom': 'intercom', 'Stripe': 'stripe',
      'firebase': 'firebase', 'hotjar': 'hotjar',
      'posthog': 'posthog', 'heap': 'heap',
      'FullStory': 'fullstory', 'Segment': 'segment',
    }
    for (const [global, name] of Object.entries(checks)) {
      if ((window as any)[global]) detected.push(name)
    }
    if (detected.length > 0) {
      this.trackEvent('detected_sdks', Object.fromEntries(detected.map(s => [s, 'detected'])))
    }
  }

  // ─── Metric Tracking ───

  private trackMetric(type: string, name: string, value: number, unit: string, extra?: Record<string, any>) {
    this.metricQueue.push({
      metricType: type,
      metricName: name,
      value,
      unit,
      sessionId: this.sessionId,
      timestamp: new Date().toISOString(),
      // Web has its own baseline (PerformanceObserver / first-contentful-
      // paint), so the dashboard keeps it segmented from mobile native /
      // RN / Flutter cold-start metrics.
      framework: 'web',
      ...extra,
    })
    if (this.metricQueue.length >= this.config.maxBatchSize) void this.flush()
  }

  // ─── Device Context ───

  private collectDevice(): Record<string, string> {
    const ua = navigator.userAgent
    return {
      manufacturer: this.getBrowser(ua),
      model: this.getOS(ua),
      osName: this.getOSName(ua),
      osVersion: this.getOSVersion(ua),
      locale: navigator.language || '',
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || '',
      country: navigator.language?.split('-')[1] || '',
      screenResolution: `${screen.width}x${screen.height}`,
      networkType: (navigator as any).connection?.effectiveType || 'unknown',
      framework: 'web',
      sdkVersion: SDK_VERSION,
      userAgent: ua.slice(0, 200),
      referrer: document.referrer?.slice(0, 200) || '',
      pageUrl: window.location.pathname,
    }
  }

  // ─── Privacy ───

  /**
   * The user_id we stamp on every event. If the host app called setUserId,
   * we send the SHA256-hashed value (h_<hash>). Otherwise we fall back to
   * the anonymous installation ID (anon_<uuid>) so DAU/MAU/retention always
   * have something distinct to count.
   */
  private effectiveUserId(): string {
    if (this.userId) return 'h_' + this.sha256(this.userId)
    return this.anonId
  }

  // Kept for callsites that still pass an explicit value (e.g. log entries
  // forwarded from a different context). Never returns null — always at
  // least the anon ID.
  private hashUserId(userId: string | null): string {
    if (userId) return 'h_' + this.sha256(userId)
    return this.anonId
  }

  private sanitizeUrl(url: string): string {
    try {
      const u = new URL(url, window.location.origin)
      return u.origin + u.pathname
    } catch { return url.split('?')[0] }
  }

  // PII regex set — kept in sync with sdk-android PrivacyGuard.kt.
  private static readonly RE_EMAIL = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g
  private static readonly RE_PHONE = /^\+?[0-9]{7,15}$/
  private static readonly RE_IP = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g
  private static readonly RE_JWT = /eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g
  private static readonly RE_UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
  private static readonly RE_CC = /\b(?:\d{4}[- ]?){3}\d{4}\b/g
  private static readonly PII_KEYS = [
    'email', 'mail', 'phone', 'tel', 'mobile', 'name', 'username',
    'user_name', 'first_name', 'last_name', 'address', 'ssn', 'password',
    'token', 'secret', 'api_key', 'credit_card', 'card_number',
  ]
  // Keys whose substring would otherwise hit PII_KEYS but which are clearly
  // safe (e.g. "screen_name" matches "name" but is just a route label, not
  // user data). Treat as exact-match exemptions before substring scanning.
  private static readonly PII_KEY_ALLOWLIST = [
    'screen_name', 'previous_screen', 'screen', 'route', 'route_name',
    'next_screen', 'event_name', 'tag_name', 'class_name', 'package_name',
    'session_id', 'session_number', 'view_name', 'page_name', 'pathname',
  ]

  private sanitizeMessage(msg: string): string {
    return msg
      .replace(ScoovaMonitorSDK.RE_EMAIL, (m) => `[hashed_email:${this.sha256(m).slice(0, 8)}]`)
      .replace(ScoovaMonitorSDK.RE_CC, '[redacted_card]')
      .replace(ScoovaMonitorSDK.RE_JWT, '[hashed_token]')
  }

  private sanitizeStackTrace(trace: string): string {
    return trace
      .replace(/\/Users\/[^/]+\//g, '/Users/****/')
      .replace(/\/home\/[^/]+\//g, '/home/****/')
      .replace(ScoovaMonitorSDK.RE_EMAIL, (m) => 'h_' + this.sha256(m).slice(0, 12))
      .replace(ScoovaMonitorSDK.RE_IP, (m) => 'h_' + this.sha256(m).slice(0, 8))
      .replace(ScoovaMonitorSDK.RE_JWT, '[hashed_token]')
  }

  private sanitizeData(data?: Record<string, string>): Record<string, string> | undefined {
    if (!data) return undefined
    const result: Record<string, string> = {}
    for (const [k, v] of Object.entries(data)) {
      const kl = k.toLowerCase()
      if (ScoovaMonitorSDK.PII_KEY_ALLOWLIST.includes(kl)) {
        result[k] = v
        continue
      }
      if (ScoovaMonitorSDK.PII_KEYS.some(p => kl.includes(p))) {
        result[k] = 'h_' + this.sha256(v).slice(0, 16)
        continue
      }
      // Reset global-flag state before .test() — otherwise consecutive calls
      // can return false on the same input.
      if (this.testReset(ScoovaMonitorSDK.RE_EMAIL, v) ||
          this.testReset(ScoovaMonitorSDK.RE_JWT, v) ||
          ScoovaMonitorSDK.RE_UUID.test(v)) {
        result[k] = 'h_' + this.sha256(v).slice(0, 16)
        continue
      }
      if (this.testReset(ScoovaMonitorSDK.RE_CC, v)) {
        result[k] = '[redacted]'
        continue
      }
      const trimmed = v.trim()
      if (ScoovaMonitorSDK.RE_PHONE.test(trimmed) && trimmed.length >= 7 && trimmed.length <= 16) {
        result[k] = 'h_' + this.sha256(v).slice(0, 16)
        continue
      }
      result[k] = v
    }
    return result
  }

  private testReset(re: RegExp, s: string): boolean {
    re.lastIndex = 0
    return re.test(s)
  }

  // ─── Flush ───

  private async flushEvents() {
    if (this.eventQueue.length === 0) return
    const batch = this.eventQueue.take(this.config.maxBatchSize)
    const ok = await this.postJSON('/v1/ingest/events/batch', { events: batch })
    if (!ok) {
      this.eventQueue.pushAll(batch)
      this.consecutiveFailures++
    } else {
      this.consecutiveFailures = 0
    }
  }

  private async flushLogs() {
    if (this.logQueue.length === 0) return
    const batch = this.logQueue.take(this.config.maxBatchSize)
    const ok = await this.postJSON('/v1/ingest/logs/batch', { logs: batch })
    if (!ok) {
      this.logQueue.pushAll(batch)
      this.consecutiveFailures++
    } else {
      this.consecutiveFailures = 0
    }
  }

  private async flushMetrics() {
    if (this.metricQueue.length === 0) return
    const batch = this.metricQueue.take(this.config.maxBatchSize)
    const ok = await this.postJSON('/v1/ingest/metrics/batch', { metrics: batch })
    if (!ok) {
      this.metricQueue.pushAll(batch)
      this.consecutiveFailures++
    } else {
      this.consecutiveFailures = 0
    }
  }

  /**
   * POST to the ingest endpoint. Returns true if the server accepted (2xx) or
   * rejected with 4xx (permanent — no point retrying), false on network /
   * timeout / 5xx (transient — caller will re-queue).
   *
   * On page unload (visibility hidden), uses sendBeacon which is fire-and-
   * forget and reports success when queued by the browser.
   */
  private async postJSON(path: string, payload: any): Promise<boolean> {
    const body = JSON.stringify(payload)
    if (typeof navigator !== 'undefined' && navigator.sendBeacon &&
        typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      const blob = new Blob([body], { type: 'application/json' })
      // sendBeacon returns true if the user agent successfully queued the request.
      return navigator.sendBeacon(`${this.endpoint}${path}?key=${this.apiKey}`, blob)
    }
    try {
      const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null
      const t = ctrl ? setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS) : null
      const resp = await fetch(`${this.endpoint}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': this.apiKey,
          'X-Bundle-Id': window.location.hostname,
        },
        body,
        keepalive: true,
        signal: ctrl?.signal,
      })
      if (t) clearTimeout(t)
      if (resp.ok) return true
      // 4xx is permanent (bad payload, expired key) — drop. 5xx is transient.
      if (resp.status >= 400 && resp.status < 500) return true
      return false
    } catch {
      return false
    }
  }

  // ─── Helpers ───

  private generateId(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
    })
  }

  /**
   * SHA-256 (FIPS 180-4). User IDs and any detected PII are hashed with
   * this before anything leaves the device — the server only ever
   * receives pseudonymized "h_<sha256>" values, never raw identifiers.
   *
   * Implemented inline and synchronous on purpose: the event-build path
   * needs the digest without an async hop, and crypto.subtle.digest is
   * async-only (and unavailable outside secure contexts). Standard
   * algorithm — verified against the FIPS test vectors.
   */
  private sha256(input: string): string {
    // UTF-8 encode
    const bytes: number[] = []
    for (let i = 0; i < input.length; i++) {
      let c = input.charCodeAt(i)
      if (c < 0x80) bytes.push(c)
      else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f))
      else if (c < 0xd800 || c >= 0xe000) bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f))
      else {
        c = 0x10000 + (((c & 0x3ff) << 10) | (input.charCodeAt(++i) & 0x3ff))
        bytes.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f))
      }
    }
    const K = [
      0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
      0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
      0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
      0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
      0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
      0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
      0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
      0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
    ]
    let h0=0x6a09e667,h1=0xbb67ae85,h2=0x3c6ef372,h3=0xa54ff53a,
        h4=0x510e527f,h5=0x9b05688c,h6=0x1f83d9ab,h7=0x5be0cd19
    const bitLen = bytes.length * 8
    bytes.push(0x80)
    while (bytes.length % 64 !== 56) bytes.push(0)
    // 64-bit big-endian length. Identifiers are short, so the high word is 0.
    bytes.push(0, 0, 0, 0, (bitLen >>> 24) & 0xff, (bitLen >>> 16) & 0xff, (bitLen >>> 8) & 0xff, bitLen & 0xff)
    const rotr = (n: number, b: number) => (n >>> b) | (n << (32 - b))
    const w = new Array<number>(64)
    for (let off = 0; off < bytes.length; off += 64) {
      for (let i = 0; i < 16; i++)
        w[i] = ((bytes[off+i*4] << 24) | (bytes[off+i*4+1] << 16) | (bytes[off+i*4+2] << 8) | bytes[off+i*4+3]) | 0
      for (let i = 16; i < 64; i++) {
        const s0 = rotr(w[i-15],7) ^ rotr(w[i-15],18) ^ (w[i-15] >>> 3)
        const s1 = rotr(w[i-2],17) ^ rotr(w[i-2],19) ^ (w[i-2] >>> 10)
        w[i] = (w[i-16] + s0 + w[i-7] + s1) | 0
      }
      let a=h0,b=h1,c=h2,d=h3,e=h4,f=h5,g=h6,h=h7
      for (let i = 0; i < 64; i++) {
        const S1 = rotr(e,6) ^ rotr(e,11) ^ rotr(e,25)
        const ch = (e & f) ^ (~e & g)
        const t1 = (h + S1 + ch + K[i] + w[i]) | 0
        const S0 = rotr(a,2) ^ rotr(a,13) ^ rotr(a,22)
        const maj = (a & b) ^ (a & c) ^ (b & c)
        const t2 = (S0 + maj) | 0
        h=g; g=f; f=e; e=(d+t1)|0; d=c; c=b; b=a; a=(t1+t2)|0
      }
      h0=(h0+a)|0; h1=(h1+b)|0; h2=(h2+c)|0; h3=(h3+d)|0
      h4=(h4+e)|0; h5=(h5+f)|0; h6=(h6+g)|0; h7=(h7+h)|0
    }
    const hex = (n: number) => (n >>> 0).toString(16).padStart(8, '0')
    return hex(h0)+hex(h1)+hex(h2)+hex(h3)+hex(h4)+hex(h5)+hex(h6)+hex(h7)
  }

  private getBrowser(ua: string): string {
    if (ua.includes('Firefox')) return 'Firefox'
    if (ua.includes('Edg/')) return 'Edge'
    if (ua.includes('OPR/') || ua.includes('Opera')) return 'Opera'
    if (ua.includes('Chrome')) return 'Chrome'
    if (ua.includes('Safari')) return 'Safari'
    return 'Other'
  }

  private getOS(ua: string): string {
    if (ua.includes('Windows')) return 'Windows'
    if (ua.includes('Mac OS')) return 'macOS'
    if (ua.includes('Linux')) return 'Linux'
    if (ua.includes('Android')) return 'Android'
    if (ua.includes('iPhone') || ua.includes('iPad')) return 'iOS'
    return 'Other'
  }

  private getOSName(ua: string): string { return this.getOS(ua) }

  private getOSVersion(ua: string): string {
    const m = ua.match(/(?:Windows NT |Mac OS X |Android |CPU (?:iPhone )?OS )([0-9._]+)/)
    return m ? m[1].replace(/_/g, '.') : ''
  }
}

// Export singleton
const ScoovaMonitor = new ScoovaMonitorSDK()

// Make available globally for <script> tag usage
if (typeof window !== 'undefined') {
  (window as any).ScoovaMonitor = ScoovaMonitor
}

export { ScoovaMonitor, ScoovaMonitorSDK }
export default ScoovaMonitor
