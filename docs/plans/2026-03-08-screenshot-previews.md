# Screenshot Previews — PRD & Technical Architecture

**Status:** Planning (PoC complete 2026-03-08)
**Date:** 2026-03-08
**Scope:** macOS only

---

## Overview

Add visual thumbnail previews for saved tabs. Screenshots are captured and stored locally on macOS — they are never synced via CloudKit. When a session created on iOS syncs to the Mac, screenshots are fetched asynchronously for those tabs after they arrive.

---

## PoC Findings (2026-03-08)

Tested multiple approaches for WKWebView screenshot capture. Key findings:

### What works

| Approach | Result |
|----------|--------|
| WKWebView `takeSnapshot()` in extension appex | Works — produced valid JPEG |
| URLSession network requests from appex | Works — can fetch HTML |
| WKWebView `load(URLRequest)` in container app | Works — full page rendering with proper network entitlements + strong references to WKWebView/delegate |

### What does NOT work in the extension appex

| Approach | Failure mode |
|----------|-------------|
| `WKWebView.load(URLRequest)` | Sandbox blocks all network — `didFinish` never fires, times out |
| `WKWebView.loadHTMLString()` | `didFailProvisionalNavigation` fires immediately |
| JS `fetch()` inside WKWebView | Sandbox blocks network from the web content process |
| URLSession fetch + `document.write()` inject | Works for **static sites only**. JS-heavy apps (Google Docs, Gmail) render blank — their HTML is just a bootstrap shell |

### Architecture approaches tested

| Approach | Result |
|----------|--------|
| All-in-appex (WKWebView + URLSession fetch + inject) | Partial — static pages only, not viable for production |
| Container app launched hidden | Works functionally but **app always becomes visible** (Dock icon, window flash). `config.activates = false`, `config.hides = true`, `NSApp.setActivationPolicy(.accessory)` all failed to fully suppress visibility. Not viable for production — users save 20+ tab sessions |
| Distributed notifications (extension → container app) | Works for IPC but doesn't solve the visibility problem |

### Key technical details discovered

- Extension appex is sandboxed — `com.apple.security.network.client` entitlement alone is not sufficient for WKWebView (only for URLSession)
- Container app is auto-sandboxed by Xcode (`ENABLE_APP_SANDBOX = YES`) — needs explicit `com.apple.security.network.client` for WKWebView to load URLs
- WKWebView and its navigation delegate must be held as **strong instance properties** — local variables get deallocated before async callbacks fire
- `applicationDidFinishLaunching` only fires on first launch — if app is already running, need alternative IPC (distributed notifications worked)

### Recommended architecture: XPC Service

The production approach should use an **XPC Service** bundled in the main app:

- Runs as a **headless background process** — no Dock icon, no window, no UI
- Managed by launchd — starts on demand, stays alive as needed
- Has its own entitlements (network access, App Group)
- WKWebView `load()` should work with full network access (not in appex sandbox)
- Extension communicates via `NSXPCConnection` or file-based IPC through App Group container

This is the standard Apple pattern for background work that needs capabilities the extension doesn't have.

---

## Key Decisions

| Decision | Outcome | Rationale |
|----------|---------|-----------|
| Platform | macOS only | iOS has no mechanism for headless rendering; screenshots are a desktop-class feature |
| Capture method | **XPC Service with WKWebView** | `captureVisibleTab` is not available in Safari Web Extensions. WKWebView cannot load URLs inside the appex (sandbox). Container app approach causes visible UI. XPC Service runs headlessly with full network |
| Storage | App Group container files (JPEG on disk) | Base64 in `chrome.storage.local` risks hitting Safari native messaging size limits and storage quotas. File-based storage in App Group is more scalable. JS reads via native messaging |
| Synced sessions | Async backfill | When `mergeRemoteChanges()` inserts a session from iOS, queue its tabs for background screenshot capture |
| Image format | JPEG, heavily compressed | PNG is too large for storage at scale. Target ~30-50KB per thumbnail |
| Resolution | Reduced viewport (e.g. 1280×800 → scaled down to ~640×400 thumbnail) | Balance quality vs storage. Retina not needed for small preview cards |

---

## Architecture

### Capture Flow (macOS save)

```
User saves tabs
  → background.js: handleSaveTabs() saves session as usual
  → background.js: sends native message { action: "captureScreenshots", urls: [...] }
  → SafariWebExtensionHandler: writes request to App Group, signals XPC Service
  → XPC Service: for each URL, load in WKWebView → snapshot → compress to JPEG
  → XPC Service: writes JPEG files to App Group screenshots directory
  → SafariWebExtensionHandler: polls for results, returns paths/status to JS
  → background.js: stores screenshot metadata (paths) keyed by URL
```

### Backfill Flow (synced sessions from iOS)

```
mergeRemoteChanges() inserts new session from CloudKit
  → background.js detects session has no local screenshots
  → Same capture flow as above
  → Screenshots stored locally, never marked as sync-dirty
```

### Storage Schema

```javascript
// Metadata in chrome.storage.local (lightweight)
{
  "tabScreenshots": {
    "https://example.com/page": {
      "filename": "abc123.jpg",  // File in App Group screenshots dir
      "capturedAt": 1709900000000
    }
  }
}
// Actual JPEG files stored in:
// ~/Library/Group Containers/84HBFJDM48.group.com.paulmaiorana.Tabstract/screenshots/
```

**Why URL-keyed (not session-keyed):**
- Same URL across multiple sessions reuses one screenshot
- Easier cache invalidation (TTL per URL)
- Avoids bloating session objects that flow through sync

### XPC Service

New Xcode target: `TabstractScreenshotService` (XPC Service), bundled in `Tabstract.app/Contents/XPCServices/`.

**Responsibilities:**
- Receive screenshot requests (URL list)
- Create off-screen WKWebView (1280×800 viewport)
- Load each URL with timeout (10s per page)
- Take snapshot after page load + render delay
- Compress to JPEG, write to App Group screenshots directory
- Return results (success/failure per URL)

**Entitlements needed:**
- `com.apple.security.network.client` — outbound network for WKWebView
- `com.apple.security.application-groups` — shared App Group container

**Considerations:**
- WKWebView must be created on main thread
- Must hold strong references to WKWebView + navigation delegate
- Rate-limit concurrent loads (3-4 at a time) for memory pressure
- Skip non-http(s) URLs, extension pages, about:blank

### UI Integration

Screenshots would display as thumbnail previews in the session list (list.js). Exact UI design TBD, but likely:
- Small thumbnail beside each tab entry in expanded session view
- Lazy-load from storage as sessions are expanded
- Placeholder/skeleton while screenshots are being captured
- Graceful fallback to favicon-only if no screenshot available

---

## Constraints & Risks

| Risk | Mitigation |
|------|------------|
| Storage bloat (many tabs × ~30-50KB each) | URL-keyed dedup, TTL-based expiry, configurable max cache size |
| WKWebView memory pressure | Limit concurrent loads, reuse/destroy webviews promptly |
| Pages that block rendering (auth walls, CAPTCHAs, interstitials) | Timeout + fallback to no-screenshot gracefully |
| Service worker suspension during capture | XPC Service does all the work independently; JS just initiates and reads results later |
| XPC Service lifecycle | launchd manages automatically — starts on demand, idle timeout kills it |
| WKWebView in XPC Service may hit same sandbox issues as appex | **Needs validation** — XPC Services have their own sandbox profile. If WKWebView `load()` doesn't work, may need to investigate sandbox exceptions or alternative rendering approaches |

---

## Open Questions

- [ ] What TTL for cached screenshots? 7 days (like page metadata cache)? 30 days? Never expire until storage pressure?
- [ ] Max total storage budget for screenshots?
- [ ] Should users be able to disable screenshot capture in settings?
- [ ] Batch size — how many screenshots per XPC request? All at once or chunked?
- [ ] Should screenshots update when a tab URL is visited again, or is first-capture permanent?
- [ ] Exact UI treatment — hover preview? inline thumbnail? lightbox on click?
- [x] ~~Should the App Group container files approach be used instead of base64 in native message responses?~~ **Yes — file-based storage in App Group container**
- [ ] Does WKWebView `load()` work inside an XPC Service sandbox? (Needs PoC validation)
- [ ] NSXPCConnection vs file-based IPC — which is simpler for extension ↔ XPC communication?

---

## Not In Scope

- iOS screenshot capture
- Syncing screenshots via CloudKit
- Full-page screenshots (viewport only)
- Video/animated previews
