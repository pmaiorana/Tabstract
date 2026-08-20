# Repository Guidelines

## Project Structure & Modules
- `Tabstract/`: macOS host app (Swift). UI, assets, and embedded web view live here. Key files: `AppDelegate.swift`, `ViewController.swift`, `Assets.xcassets/`, `Resources/`.
- `Tabstract Extension/`: Safari Web Extension bridge (Swift handler + web assets). Web code and localization live in `Resources/` (`manifest.json`, `*.js`, `*.html`, `_locales/`).
- `Tabstract.xcodeproj/`: Xcode project. Do not edit by hand.

## Build, Run, and Dev
- Open in Xcode: `open Tabstract.xcodeproj`.
- Build (CLI): `xcodebuild -project Tabstract.xcodeproj -scheme "Tabstract" -configuration Debug -derivedDataPath build`.
- Run in Xcode: select the `Tabstract` scheme, hit Run. This installs/activates the Safari extension for testing.
- Clean: `xcodebuild -project Tabstract.xcodeproj -scheme "Tabstract" clean`.

## Coding Style & Naming
- Swift: 4‑space indent, no tabs. Types and enums `PascalCase`, methods/vars `camelCase`. Prefer `guard`/`if let` over force‑unwrap. Keep imports minimal. Place app code in `Tabstract/` and extension glue in `Tabstract Extension/`.
- JavaScript/CSS/HTML (extension): 2‑space indent. Use semicolons. Keep DOM selectors and i18n keys readable; reuse patterns in `popup.js`, `settings.js`.
- Files: Swift files `PascalCase.swift` near their feature. Web assets in `Tabstract Extension/Resources/` next to related HTML.

## Testing Guidelines
- No XCTest target exists yet. Add tests under `TabstractTests/` using XCTest if contributing significant Swift logic. Aim for focused unit tests and avoid UI flakiness.
- Manual checks: run the app, confirm extension state toggles, verify popup flows (`list.html`, `settings.html`), i18n strings, and badge behavior.

## Commit & PRs
- Commits: short, imperative summaries (e.g., "add keyboard shortcut", "hardening search deletion race conditions"). Group related changes; tag releases like `1.8`.
- PRs: include a clear description, screenshots/GIFs for UI changes, repro steps, and linked issues. Note any plist/entitlement or `manifest.json` changes.

## Security & Configuration
- Do not change bundle identifiers or entitlements without discussion (`Tabstract.entitlements`, `Tabstract_Extension.entitlements`).
- Keep `manifest.json` permissions minimal. Update localization under `Resources/_locales/` when adding new strings.

## Localization Management
- **17 supported locales**: en, ar, de, es, es-419, fr, fr-CA, it, ja, ko, nl, pt-BR, pt-PT, ru, sv, zh-CN, zh-TW

## Debug Pipeline

Safari provides no programmatic access to Web Inspector for extensions. A native messaging debug pipeline writes JS console output, DOM/CSS snapshots, storage state, and per-element inspection data to files on disk that agents can read directly.

**All debug features are gated by `debugMode` in extension storage — disabled by default, zero runtime impact for end users.**

### Enable
Run in any extension page console: `chrome.storage.local.set({debugMode: true})`

### Output Directory
`~/Library/Group Containers/84HBFJDM48.group.com.paulmaiorana.Tabstract/debug/`

### Available Files

| File | Contents | When |
|------|----------|------|
| `console.log` | Timestamped JS console output from all pages | Automatic — all `debug()` calls |
| `snapshot-{page}.html` | Full DOM snapshot | Auto on page load + on request |
| `snapshot-{page}.css` | All computed CSS rules | Auto on page load + on request |
| `snapshot-{page}.json` | Extension storage dump + viewport/meta | Auto on page load + on request |
| `element-inspector-{page}.json` | Computed styles, box model, attributes, ancestor chain | On request |

`{page}` is `list`, `popup`, or `settings`. The target page must be open in Safari.

### Element Inspector

To inspect a specific element on-demand:

1. **Write** `debug/element-request.json`:
   ```json
   {"selector": ".banner", "source": "list"}
   ```
2. **Wait ~3 seconds** for the page to pick it up.
3. **Read** `debug/element-inspector-list.json` — contains:
   - `computedStyles`: every resolved CSS property
   - `pseudoStyles`: `::before`/`::after` styles if present
   - `boxModel`: bounding rect, offset/client/scroll dimensions, `isInViewport`, `isVisible`
   - `elementState`: tag, id, classes, attributes, dataset, text, input values, ARIA attrs
   - `ancestorChain`: selector path from element to `<html>`

The request file is deleted after processing (one-shot).

### Architecture
JS pages → `browser.runtime.sendNativeMessage` → Swift `SafariWebExtensionHandler` → writes to App Group container. Console log auto-truncates at ~500KB. Snapshots overwrite on each capture.

## Agent‑Specific Tips
- When adding files, ensure they’re included in the Xcode target. Keep resource paths stable; mirror existing directory conventions.
