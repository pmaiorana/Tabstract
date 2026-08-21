# Tabstract

Too many tabs? Tabstract helps clear the clutter and sharpen your focus, while keeping your data completely private and local.

**[Download on the App Store](https://apps.apple.com/app/tabstract/id6743376666)** · **[tabstract.app](https://tabstract.app)**

## Prerequisites

- macOS with Safari installed
- Xcode 15 or newer

## Opening the project

1. Clone this repository.
2. Open `Tabstract.xcodeproj` in Xcode.
3. Select the **Tabstract** scheme or the **Tabstract Extension** scheme.

## Running the Safari extension

1. Build and run the **Tabstract** macOS application.
2. Enable the extension in **Safari ▸ Settings ▸ Extensions** if prompted.
3. The extension should now be available in Safari's toolbar.

## Project structure

- `Tabstract.xcodeproj` – Xcode project containing both targets.
- `Tabstract` – macOS container app used to manage the extension.
- `Tabstract Extension` – Safari Web Extension resources.

## Debug Pipeline

Tabstract includes a built-in debug pipeline that writes JS console output, DOM snapshots, CSS, storage state, and per-element inspection data to files on disk via native messaging. This allows debugging without access to Safari's Web Inspector for extensions.

**All debug features are gated by `debugMode` in extension storage — disabled by default, zero runtime impact for end users.**

Enable debug mode from any extension page console:
```js
chrome.storage.local.set({debugMode: true})
```

Output is written to:
```
~/Library/Group Containers/84HBFJDM48.group.com.paulmaiorana.Tabstract/debug/
```

See [CLAUDE.md](CLAUDE.md) for full details on available output files and the element inspector.

## Note to Future Self: Safari Extension Not Loading After Archive

If your Safari extension disappears or stops working after archiving the app in Xcode, it's likely due to multiple versions of the same app or extension existing on your machine. Safari can get confused and stop registering the extension entirely.

**Workaround steps:**

1. In Xcode: go to **Product ▸ Show Build Folder in Finder**.
2. Delete anything Tabstract-related from that build folder.
3. Go to `~/Library/Developer/Xcode/DerivedData/` and delete your project's derived data.
4. In Xcode: go to **Window ▸ Organizer** and delete any archived builds for the app.
5. Make sure you don't have other copies of the app anywhere else on disk (check Downloads, Desktop, etc).
6. Empty your Trash.
7. Back in Xcode: do a fresh **Build & Run**.

This usually resolves the issue. It's a Safari/Launch Services quirk — not a bug in your extension code.

Reference: Apple Developer Forums thread 772581, answer ID 821488022.
<https://developer.apple.com/forums/thread/772581>
