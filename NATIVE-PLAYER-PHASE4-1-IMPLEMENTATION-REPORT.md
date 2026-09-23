# Native Player Phase 4.1 — origin diagnostics

## Scope

Phase 4.1 is intentionally diagnostic. It does not change the Phase 4 buffering, range-size policy, mpv cache profile, or seek behaviour.

The goal is to determine which client path is actually producing each `/baia/v1/media` request seen by the Host Connector.

## Finding that motivated this patch

The Phase 4 source contains a NativeMediaSource range policy of 1 MiB -> 2 MiB -> max 4 MiB, while the legacy `media_bridge.rs` still uses `CONNECTOR_MEDIA_CHUNK_BYTES = 8 * 1024 * 1024`. Server logs continued to show many exact 8 MiB requests even after a clean Windows build. Therefore server-side logs alone could not prove whether those requests came from `baia://` or the legacy WebView bridge.

## Changes

### End-to-end media origin marker

Connector media frames now include an optional `clientKind` value:

- `native_media_source`
- `legacy_media_bridge`

The Host Connector accepts the marker only from this allowlist and remains compatible with older clients that omit it (`unknown`).

### Host Connector logging

Direct-file lines now include:

- `client_kind`
- `request_path`
- the existing range/bytes/disconnect/latency fields

This makes exact 8 MiB requests attributable without inference.

### Client-side diagnostic logging

Immediately before sending a Connector media request:

- NativeMediaSource logs `event=http_request`, request ID, method, and exact Range.
- Media Bridge logs the same data plus logical path.

### Analyzer

`scripts/analyze-native-player-poc.js` now reports:

- direct-file request counts by `client_kind`
- Range-size distributions by `client_kind`

### Convenience script

`scripts/phase4-1-connector-origin-summary.sh` summarizes origin counts, Range sizes, recent native/legacy requests, and disconnect errors directly from journald.

## Important Windows build flag

The native player is feature-flagged. `.env.example` defaults `BAIA_NATIVE_VIDEO_PLAYER=false`. A test build should explicitly compile with the flag enabled, for example in PowerShell:

```powershell
$env:BAIA_NATIVE_VIDEO_PLAYER = "true"
npm.cmd run tauri -- build --bundles nsis
```

If the runtime environment does not provide the flag and the build did not capture it as `true`, the frontend intentionally falls back to the WebView/Media Bridge path.

## Expected next-test interpretation

- Exact 8 MiB requests tagged `legacy_media_bridge`: NativeMediaSource is not the source of those requests; investigate fallback/stale WebView stream/feature flag.
- Requests tagged `native_media_source`: expected steady-state maximum is 4 MiB. Any 8 MiB native-tagged request would contradict the current NativeMediaSource construction and warrants tracing the exact serialized frame/request ID.
- Both tags present simultaneously for the same movie: two media paths are active concurrently and must be separated before further transport tuning.
