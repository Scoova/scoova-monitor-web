# Changelog

## 1.5.0 — 2026-05-21

### Added
- `Config.appVersion` and `Config.appBuildNumber` — browsers don't expose
  the host app's version, so the host passes them via `init()` and we
  forward as `device.appVersion` / `device.appBuildNumber`.
- Screen orientation captured via `screen.orientation` API.
- Network generation (`2G` / `3G` / `4G`) derived from
  `navigator.connection.effectiveType`.

### Changed
- SDK version reported as `1.5.0` in every event payload.

## 1.4.0

Initial public release.
