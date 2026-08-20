# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

This is a Safari Web Extension project built with Swift and JavaScript. Development is done through Xcode:

- **Build and run**: Open `Tabstract.xcodeproj` in Xcode, select either the "Tabstract" scheme (macOS app) or "Tabstract Extension" scheme, then Build & Run (⌘R)
- **Enable extension**: After running, enable the extension in Safari → Settings → Extensions
- **Clean build artifacts**: Product → Clean Build Folder in Xcode, or manually delete from `~/Library/Developer/Xcode/DerivedData/`

## Project Architecture

### High-Level Structure
- **Tabstract.xcodeproj**: Xcode project containing both the macOS container app and Safari extension
- **Tabstract/**: macOS container app (minimal Swift app required for Safari extensions)
- **Tabstract Extension/**: Safari Web Extension with Swift handler and JavaScript resources

### Terminology: UI vs Code

**IMPORTANT**: The user-facing terminology differs from the code implementation:
- **"Routines" in UI** = `templates` / `savedTemplates` in code (reusable, schedulable tab groups)
- **"Filters" in UI** = `smartGroups` / `savedSmartGroups` in code (auto-organizing tab patterns)

When discussing features with the user, use UI terminology (Routines, Filters). When working with code, use code terminology (templates, smartGroups).

### Key Components

#### Safari Extension Architecture
- **SafariWebExtensionHandler.swift**: Swift handler for native messaging between JavaScript and macOS (currently just echoes messages)
- **manifest.json**: Web extension manifest defining permissions, commands, and UI entry points
- **background.js**: Service worker managing tab operations, storage, and keyboard shortcuts
- **popup.js**: Main popup UI logic with settings-aware behavior
- **list.js**: Saved sessions management interface
- **settings.js**: User preferences configuration

#### Core Features
- **Tab saving**: Collects open tabs (filtering pinned/invalid URLs), stores with timestamps and custom titles
- **Session management**: Persistent storage of tab collections with restore/delete operations
- **Keyboard shortcuts**: Cmd+Shift+S (save tabs), Cmd+Shift+H (open list), Cmd+Shift+D (save active tab)
- **Settings system**: Configurable behavior for save/restore actions, dark mode, badge visibility
- **Internationalization**: Multi-language support via `_locales/` message files

#### Storage & State Management
- All data stored in Chrome extension storage (local)
- **DEFAULT_SETTINGS** object in background.js defines fallback values
- Settings include: popup behavior, delete after restore, dark mode, keyboard shortcuts, badge preferences
- Sessions stored as arrays with timestamps, titles, and tab data

#### UI Components
- **popup.html/popup.js**: Main extension popup with save button and navigation
- **list.html/list.js**: Saved sessions browser with restore/delete actions
- **settings.html/settings.js**: Preferences configuration interface
- **help.html/help.js**: User documentation and feature explanations

### Development Notes

#### Safari Extension Debugging
- **IMPORTANT**: The developer cannot access Safari's Develop → Show Extension Builder or background page console
- Never suggest checking the Extension Builder or background page console — use the debug pipeline instead
- If extension stops loading after archiving, follow cleanup steps in README.md

##### Debug Pipeline (native messaging → file)

All debug output is written to disk via native messaging so Claude Code can read it directly. **Everything is gated by `DEBUG_MODE`** — zero impact when debug mode is off (the default for all users).

Enable: `chrome.storage.local.set({debugMode: true})` in any extension page console.

**Output directory:** `~/Library/Group Containers/84HBFJDM48.group.com.paulmaiorana.Tabstract/debug/`

| File | Contents | When |
|------|----------|------|
| `console.log` | Timestamped JS console output from all pages | Automatic (all `debug()` calls) |
| `snapshot-{page}.html` | Full DOM snapshot | Auto on page load + on request |
| `snapshot-{page}.css` | All computed CSS rules | Auto on page load + on request |
| `snapshot-{page}.json` | Extension storage + viewport/meta | Auto on page load + on request |
| `element-inspector-{page}.json` | Computed styles, box model, attributes, ancestor chain for a specific element | On request |

Where `{page}` is `list`, `popup`, or `settings`.

##### Element Inspector (on-demand)

To inspect a specific element, write a request file:
```json
// ~/Library/Group Containers/84HBFJDM48.group.com.paulmaiorana.Tabstract/debug/element-request.json
{"selector": ".banner", "source": "list"}
```
The target page polls every 3 seconds (debug mode only), runs `getComputedStyle()` + box model + state collection, and writes the result to `element-inspector-{source}.json`. The request file is deleted after processing.

##### How it works
- JS pages call `browser.runtime.sendNativeMessage("application.id", ...)` → Swift `SafariWebExtensionHandler` → writes files to App Group container
- `background.js`: `nativeDebugLog()` function, `console.error`/`console.warn` interception
- `list.js`, `popup.js`, `settings.js`: `captureDebugSnapshot()`, `inspectElement()`, polling loop
- Swift handlers: `debugLog`, `debugSnapshot`, `checkElementInspectorRequest`, `elementInspectorResult`

#### Code Patterns
- **Message passing**: Background script coordinates all tab operations via chrome.runtime.sendMessage/onMessage
- **Settings management**: ensureDefaultSettings() ensures all preferences have values on startup
- **Tab filtering**: Consistent filtering logic excludes extension pages, about:blank, favorites://, and optionally pinned tabs
- **Undo system**: Temporary storage for deleted sessions with time-limited restore capability
- **Accessibility - Reduced Motion**: All animations and transitions MUST be covered by the `@media (prefers-reduced-motion: reduce)` rule in styles.css (lines 6350-6358). This rule sets animation-duration and transition-duration to 0.01ms for users with reduced motion preferences. When adding new animations, verify they are automatically covered by this global rule.
- **Button Catch-All Rules (CRITICAL)**: styles.css has **four** broad button catch-all selectors that override `background-color`, `color`, and `border` on ALL buttons not explicitly excluded. When adding any new `<button>` element, you MUST add its class to the `:not()` exclusion list on **ALL FOUR** rules. Missing even one causes hover/style bugs. The four rules are:
  1. `html.dark-mode button:not(...)` — base styles (bg, color, border)
  2. `html.dark-mode button:not(...):hover` — hover styles
  3. `body:not(.force-light) button:not(...):hover:not(:disabled)` — light mode hover styles (**easy to miss — this one is NOT under `html.dark-mode`**)
  4. `html.dark-mode button:not(...):disabled` — disabled styles
  Search for `html.dark-mode button:not(.toggle-button)` and `body:not(.force-light) button:not(.toggle-button)` to find all four. When debugging button styling issues, check these rules FIRST — they are the most common cause of button styles being overridden.

#### Localization
- Messages defined in `_locales/[lang]/messages.json` files
- JavaScript accesses via `chrome.i18n.getMessage(key)`
- Supports 17 locales: en, ar, de, es, es-419, fr, fr-CA, it, ja, ko, nl, pt-BR, pt-PT, ru, sv, zh-CN, zh-TW

## Common Development Issues

### Extension Not Loading After Archive
If Safari extension disappears after archiving:
1. Delete build artifacts from Xcode's build folder
2. Clear derived data: `~/Library/Developer/Xcode/DerivedData/`
3. Delete archived builds from Xcode Organizer
4. Remove any duplicate app copies from system
5. Empty Trash and rebuild

This is a Safari/Launch Services issue, not code-related.

### Testing Tab Operations
- Test with various tab types (pinned, extension pages, about:blank)
- Verify keyboard shortcuts work when extension has focus
- Check settings persistence across browser restarts
- Test dark mode switching and badge behavior
- Always run a build after making changes so user can test