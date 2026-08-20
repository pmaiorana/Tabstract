# iCloud Sync Reliability Fixes — Design Spec

**Date:** 2026-03-16
**Scope:** 12 fixes to the iCloud sync system across `background.js`, `CloudKitSyncEngine.swift`, and `SafariWebExtensionHandler.swift`
**Goal:** Eliminate data loss vectors, remove timing hacks, improve conflict handling, and harden the sync pipeline for production reliability.

---

## Fix #1 — Separate push/pull mutex

### Problem
A single `_syncInProgress` boolean guards both `executeSyncPush()` and `executeSyncPull()`. When a push is in flight, all pull requests are silently dropped (and vice versa). Since push triggers pull on success, and alarms trigger pull-then-push, operations are regularly lost.

### Design
Replace `_syncInProgress` with two flags: `_syncPushInProgress` and `_syncPullInProgress`.

- `executeSyncPush()` checks and sets `_syncPushInProgress` only.
- `executeSyncPull()` checks and sets `_syncPullInProgress` only.
- When a pull is requested while `_syncPullInProgress` is true, set `_syncPullDeferred = true`. When the current pull completes (in both success and error paths), check the flag, clear it, and re-execute if it was set.
- Same pattern for push: `_syncPushDeferred = true`. Deferred flags are checked and cleared in all exit paths (success, failure, catch) to prevent orphaned deferrals.

**Files:** `background.js`
**Risk:** Low — purely internal state management.

---

## Fix #2 — Persist dirty records to storage

### Problem
`_syncDirtyRecords` is an in-memory `Map()`. Safari terminates background pages aggressively, especially on iOS. If the page is killed during the 2-second debounce window, dirty records are lost permanently and never sync.

### Design
On every `markSyncDirty()` call, in addition to updating the in-memory map, persist the dirty records map to `chrome.storage.local` under the key `_syncDirtyRecords`.

On startup (`initSyncOnStartup`), load persisted dirty records into the in-memory map and schedule a push if any exist.

When `executeSyncPush()` drains the map, clear the persisted key.

Replace the `setTimeout`-based debounce with `chrome.alarms` as a safety net (Safari may clamp `delayInMinutes` below 1.0 to 1 minute — the exact minimum should be verified experimentally):
- Use a `syncPushDebounce` alarm with `delayInMinutes: 1` (1 minute, conservative).
- Each `markSyncDirty` call clears and re-creates the alarm.
- The alarm handler calls `executeSyncPush()`.
- For responsiveness, keep an in-memory `setTimeout` as well (2s) — the alarm is the safety net if the page is killed before the timeout fires.
- Note: rapid edits (e.g., reordering sessions) will clear/recreate the alarm at high frequency. This is acceptable — alarm creation is cheap and the debounce behavior is correct (only the last one fires).

**Serialization format:** The Map values are plain objects (`{recordType, recordName, payload, modifiedAt, isDeleted}`), so `Object.fromEntries(_syncDirtyRecords)` serializes cleanly to JSON via `chrome.storage.local`.

**Files:** `background.js`
**Risk:** Low — additive persistence, no behavior change when page stays alive.

---

## Fix #3 — Update `_syncModifiedAt` on local edits

### Problem
`_syncModifiedAt` is only set during sync merge, not on local edits. This means local edits have stale timestamps and remote changes with newer `modifiedAt` silently overwrite them.

### Design
Update `_syncModifiedAt` at the point where data is written to storage, not inside `markSyncDirty()`. This is because `markSyncDirty` receives the payload by reference but doesn't persist it — mutating the payload there would update the in-memory copy but not the stored copy, leaving future LWW comparisons stale.

**Implementation:** In the `storage.onChanged` listener (line 834), when a change is detected and about to be marked dirty, also write the updated `_syncModifiedAt` back to the stored object. Specifically, for each detected change, set `_syncModifiedAt` on the payload object before calling `markSyncDirty`, and include the updated array in a `chrome.storage.local.set` call. To avoid re-triggering the `onChanged` listener, add the record names to the `_syncMergedRecordNames` set (from Fix #5) before writing.

The dirty record's `modifiedAt` field (set in `markSyncDirty` line 4544) is already correct for the push. This fix ensures the *local stored copy* also has a current `_syncModifiedAt` for future LWW comparisons against incoming remote changes.

**Files:** `background.js`
**Risk:** Low — makes timestamps accurate rather than stale. Slightly more complex than a one-liner due to needing to persist back to storage.

---

## Fix #4 — Conflict copies (preserve both versions)

### Problem
When a remote record wins LWW over a local record, the local version is silently overwritten. No notification, no recovery.

### Design
In `mergeRemoteChanges()`, when a remote change wins the LWW comparison for an existing local record:

1. Before overwriting, create a conflict copy of the **local** version (the loser).
2. The conflict copy gets:
   - Title: `"[Original Title] (sync conflict)"` (sessions) or name with suffix (templates/smart groups)
   - Metadata flag: `_syncConflict: true`
   - A new unique identifier (new timestamp for sessions, new ID for templates/smart groups) so it doesn't collide with the winner.
   - `_syncModifiedAt` set to the current time so it syncs to other devices.
3. The winner (remote version) replaces the original in its existing position.
4. The conflict copy is inserted adjacent to the winner (for sessions: right after it; for templates/groups: appended).
5. Mark the conflict copy as dirty so it pushes to other devices.

**Scope:** Apply to Sessions, Templates, and SmartGroups. TrashedLinks are ephemeral and don't warrant conflict copies.

**Guard against accumulation:** Only create a conflict copy when the local record was actually modified locally since the last sync. Specifically, only create a conflict copy if the local record has a dirty entry in `_syncDirtyRecords` OR its `_syncModifiedAt` is newer than its last-synced value (i.e., it was edited locally). If the local record is simply stale from a previous sync (not edited locally), the remote version winning is correct behavior — no conflict copy needed. Also, never create a conflict copy if the local record already has `_syncConflict: true` (it's itself a conflict copy; just let the remote version win).

**User resolution:** Users delete whichever version they don't want using existing delete functionality. The `_syncConflict` flag is available for future UI treatment (e.g., a visual indicator) but is not required for v1 — the title suffix is sufficient.

**Note on `_syncMergeInProgress`:** Conflict copies must be marked dirty for sync, but `_syncMergeInProgress` blocks `markSyncDirty()`. Solution: collect conflict copies during merge into a `_syncPendingConflictCopies` array. After the merge completes and `_syncMergeInProgress` is cleared (in the `chrome.storage.local.set` callback), drain the array and call `markSyncDirty` for each. Add their record names to `_syncMergedRecordNames` (Fix #5) to prevent the `onChanged` listener from re-processing them.

**Files:** `background.js`
**Risk:** Medium — new records created during merge. The accumulation guard and `_syncConflict` check prevent runaway duplication.

---

## Fix #5 — Replace 200ms setTimeout with merge-record tracking

### Problem
`_syncMergeInProgress` is cleared after a 200ms `setTimeout`, hoping that `storage.onChanged` listeners fire within that window. On slow devices or with large storage writes, this assumption can fail, causing the listener to re-dirty just-merged records and create infinite sync loops.

### Design
Add a `Set` called `_syncMergedRecordNames` alongside the existing `_syncMergeInProgress` boolean. Each serves a distinct purpose:

- **`_syncMergeInProgress` (boolean):** Retained. Used as a broad early-return in the `storage.onChanged` listener (line 836) to skip all diffing work during a merge, and in `markSyncDirty()` (line 4537) to block dirty-marking during merge. Set to `true` before `chrome.storage.local.set()` in merge, cleared in the `set` callback. This replaces the 200ms `setTimeout` — the callback fires after `onChanged` listeners have processed (documented Chrome extension behavior: listeners fire before the `set` callback).
- **`_syncMergedRecordNames` (Set):** New. Populated with all record names modified by the merge before the `chrome.storage.local.set()` call. Used by `markSyncDirty()` and the `onChanged` listener as a secondary check: if a record name is in the set, skip it. This catches cases where `_syncMergeInProgress` has already been cleared but a delayed `onChanged` event arrives (edge case on slow devices). Also used by Fix #3 and Fix #4 to write back to storage without re-triggering the listener. Cleared in the `set` callback alongside the boolean.

**Files:** `background.js`
**Risk:** Low — more precise than timing, same intent.

---

## Fix #6 — Prevent concurrent storage writes during merge

### Problem
`mergeRemoteChanges()` does a read-all → modify → write-all on four storage keys. Between the `get` and `set`, other code paths (session save, template edit, restore) can write to the same keys, and the merge's `set` overwrites those concurrent changes.

### Design
Extend the `_syncMergeInProgress` flag (retained from Fix #5) to also gate write operations that touch synced storage keys.

Add a guard at the top of functions that write to `savedSessions`, `savedTemplates`, `smartGroups`, or `trashedLinks`. When `_syncMergeInProgress` is true, defer the write by pushing the **operation** (a function to re-execute) onto a `_syncDeferredWrites` queue (an array of callbacks). After merge completes, drain the queue by calling each deferred function, which will re-read current storage values and apply its operation against the post-merge state.

**Why operations, not values:** Storing `{key, value}` snapshots would overwrite the merge result with pre-merge data. The deferred operations were computed against old data. By re-executing the operation (e.g., "delete session with timestamp X", "rename session Y"), it reads the current post-merge state and applies correctly.

**Scope of gating:** Only gate the message handler code paths that do read-modify-write on the four synced keys during the merge window. These handlers already follow a pattern of `chrome.storage.local.get → modify → chrome.storage.local.set`, so wrapping the entire handler body in a deferred callback is straightforward.

**Alternative considered:** Making merge key-by-key instead of all-at-once. Rejected because the four arrays are interdependent (e.g., a session deletion may create a trashed link), and splitting would create partial-write states.

**Files:** `background.js`
**Risk:** Medium — requires identifying all write paths. Missing a path means the same bug persists for that code path. However, the merge window is short (sub-second), so the probability of collision is low even without perfect coverage.

---

## Fix #7 — Clean up CKAsset temp files

### Problem
`pushRecords()` creates a temp file per record for CKAsset payloads but never deletes them. On iOS especially, this accumulates.

### Design
Collect temp file URLs in an array during record preparation. After `pushBatch()` returns (success or failure), delete all temp files.

```swift
var tempURLs: [URL] = []

// In the record loop:
tempURLs.append(tempURL)

// After pushBatch returns:
for url in tempURLs {
    try? FileManager.default.removeItem(at: url)
}
```

**Files:** `CloudKitSyncEngine.swift`
**Risk:** Negligible.

---

## Fix #8 — Track per-record push failures and re-queue

### Problem
When `serverRecordChanged` (conflict) occurs on individual records, `pushBatch` counts the entire batch as successful (`savedCount = records.count`). The dirty record is already cleared from the map, so the conflicted record is never retried.

### Design
Use a `@unchecked Sendable` collector class (similar to `PullCollector`) to track per-record outcomes:

```swift
private final class PushCollector: @unchecked Sendable {
    let lock = NSLock()
    var failedRecordNames: [String] = []

    func addFailure(_ name: String) {
        lock.lock()
        defer { lock.unlock() }
        failedRecordNames.append(name)
    }
}
```

In `perRecordSaveBlock`, on `serverRecordChanged` or any per-record error, add the record name to `failedRecordNames`.

In `modifyRecordsResultBlock`, set `savedCount = records.count - collector.failedRecordNames.count`.

Return `failedRecordNames` and a `hasConflicts` boolean in the response.

**JS side:** In `executeSyncPush()`, after a successful response:
- If `response.hasConflicts` is true, trigger `executeSyncPull()` instead of re-queuing the failed records. The pull will fetch the server's version of the conflicted records, and the merge logic (with Fix #4's conflict copies) will handle reconciliation properly.
- For non-conflict per-record errors (e.g., transient failures), re-add to `_syncDirtyRecords` if the record isn't already there (user may have made a newer edit).
- **Do NOT re-queue `serverRecordChanged` failures as dirty** — re-pushing the same record without the server's `recordChangeTag` will produce the same conflict indefinitely.

**Files:** `CloudKitSyncEngine.swift`, `background.js`
**Risk:** Low — additive tracking, no behavior change for successful records.

---

## Fix #9 — Check schema version on pull

### Problem
`schemaVersion` is written to every CKRecord but never checked during pull. A newer client could write v2 records that an older client silently corrupts.

### Design
In `mergeRemoteChanges()`, at the top of the change processing loop, check the record's schema version:

```js
const CURRENT_SCHEMA_VERSION = 1;

for (const change of changes) {
    if (change.schemaVersion && change.schemaVersion > CURRENT_SCHEMA_VERSION) {
        skippedNewerVersion = true;
        continue; // Skip records we don't understand
    }
    // ... existing merge logic
}
```

After the merge loop, if `skippedNewerVersion` is true, set a storage flag:
```js
chrome.storage.local.set({ _syncNewerVersionAvailable: true });
```

The settings UI can check this flag and show a hint like "A newer version of Tabstract is available" in the sync status area.

**Clearing the flag:** On startup (`initSyncOnStartup`), compare `chrome.runtime.getManifest().version` against a stored `_syncLastKnownVersion`. If the version has changed, clear `_syncNewerVersionAvailable` and update the stored version. This ensures the hint disappears after the user updates Tabstract.

**Swift side:** Add `schemaVersion` to the pull response data in `executePullOperation`, reading it from `record["schemaVersion"]`.

**Files:** `background.js`, `CloudKitSyncEngine.swift`
**Risk:** Negligible — additive check, no behavior change for v1 records.

---

## Fix #10 — Thread-safe PullCollector

### Problem
`PullCollector` is `@unchecked Sendable` with mutable arrays appended from CKOperation callbacks that may fire on different threads.

### Design
Add an `NSLock` to protect all mutations:

```swift
private final class PullCollector: @unchecked Sendable {
    private let lock = NSLock()
    private var _changedRecords: [[String: Any]] = []
    private var _deletedRecordIDs: [[String: Any]] = []
    var newToken: CKServerChangeToken?
    var errorStr: String?
    var tokenExpired = false

    func addChanged(_ record: [String: Any]) {
        lock.lock()
        defer { lock.unlock() }
        _changedRecords.append(record)
    }

    func addDeleted(_ record: [String: Any]) {
        lock.lock()
        defer { lock.unlock() }
        _deletedRecordIDs.append(record)
    }

    var changedRecords: [[String: Any]] {
        lock.lock()
        defer { lock.unlock() }
        return _changedRecords
    }

    var deletedRecordIDs: [[String: Any]] {
        lock.lock()
        defer { lock.unlock() }
        return _deletedRecordIDs
    }
}
```

`newToken`, `errorStr`, and `tokenExpired` are only written from the zone-level callbacks (which are serialized per-zone), so they don't need locking.

**Files:** `CloudKitSyncEngine.swift`
**Risk:** Negligible.

---

## Fix #11 — Batch full push on JS side

### Problem
`performFullPush()` serializes all records into a single native message. Safari's native messaging has undocumented size limits that could be hit with large datasets.

### Design
Chunk records into batches of 400 (matching `CloudKitSyncEngine.maxRecordsPerBatch`) and send sequentially:

```js
const BATCH_SIZE = 400;
const batches = [];
for (let i = 0; i < records.length; i += BATCH_SIZE) {
    batches.push(records.slice(i, i + BATCH_SIZE));
}

let totalPushed = 0;
let lastError = null;

for (const batch of batches) {
    const response = await browser.runtime.sendNativeMessage("application.id", {
        action: "syncFullPush",
        records: batch
    });
    if (response && response.success) {
        totalPushed += response.pushed || 0;
    } else {
        lastError = response?.error;
        // Continue with remaining batches — partial sync is better than no sync
    }
}
```

Convert `performFullPush` from callback-style to async/await for cleaner sequential batching.

**Files:** `background.js`
**Risk:** Low — same records, same endpoint, just chunked.

---

## Fix #12 — AccountChangeObserver clears stored userRecordID

### Problem
`AccountChangeObserver` logs `CKAccountChanged` but doesn't invalidate the stored `userRecordID`. Combined with `checkForAccountSwitch(forceCheck: false)` skipping the network call when a stored ID exists, account switches are never detected.

### Design
Give `AccountChangeObserver` a callback to invalidate the cached user ID:

```swift
private class AccountChangeObserver: NSObject {
    var onAccountChange: (() -> Void)?

    override init() {
        super.init()
        NotificationCenter.default.addObserver(
            self, selector: #selector(accountChanged),
            name: .CKAccountChanged, object: nil
        )
    }

    deinit { NotificationCenter.default.removeObserver(self) }

    @objc func accountChanged() {
        os_log(.info, "CloudKitSyncEngine: CKAccountChanged — clearing cached user ID")
        onAccountChange?()
    }
}
```

In `CloudKitSyncEngine.init()`, set the callback to clear the stored `userRecordID` from sync state and invalidate the account status cache:

```swift
accountObserver.onAccountChange = { [weak self] in
    Task { [weak self] in
        guard let self else { return }
        await self.clearCachedUserRecordID()
    }
}
```

Add `clearCachedUserRecordID()` method that removes `userRecordID` from sync state and clears `cachedAccountStatus`/`accountStatusCacheTime`.

**Files:** `CloudKitSyncEngine.swift`
**Risk:** Low — makes existing detection mechanism actually work.

---

## Implementation Order

Fixes are ordered to minimize risk and build on each other:

1. **#10** (PullCollector thread safety) — isolated Swift change, no dependencies
2. **#7** (temp file cleanup) — isolated Swift change, no dependencies
3. **#12** (account switch observer) — isolated Swift change, no dependencies
4. **#8** (per-record push failure tracking) — Swift + JS, but isolated to push path
5. **#9** (schema version check) — Swift + JS, isolated to pull path
6. **#1** (separate push/pull mutex) — JS only, foundational for other fixes
7. **#2** (persist dirty records) — JS only, depends on #1 being stable
8. **#3** (update _syncModifiedAt on local edits) — JS only, small change
9. **#5** (replace setTimeout with merge-record tracking) — JS only, foundational for #4 and #6
10. **#6** (gate storage writes during merge) — JS only, depends on #5
11. **#4** (conflict copies) — JS only, depends on #5, #3, and #6
12. **#11** (batch full push) — JS only, independent but saved for last as lowest priority

---

## Additional Hardening (addressed within the 12 fixes)

These items were identified during spec review and are handled within the existing fixes:

1. **`initSyncOnStartup` uses `setTimeout` for initial pull (line 5005):** Fix #2 already addresses `setTimeout` unreliability. The startup pull should also use a `chrome.alarms` safety net — add a `syncStartupPull` alarm in `initSyncOnStartup` as a fallback in case the 3-second `setTimeout` doesn't fire.

2. **Regular `executeSyncPush` could also hit native message size limits:** Fix #11 addresses `performFullPush` batching. The regular `executeSyncPush` drains all dirty records into one message. However, the dirty map accumulates at most one entry per user action (save, rename, delete), and 15-minute alarm pulls drain it regularly. In practice this stays well under message limits. If it ever becomes an issue, the same batching pattern from Fix #11 can be applied — but it's not necessary for v1.

3. **Background page killed mid-merge:** If Safari kills the page after `chrome.storage.local.set` in merge but before `_syncMergeInProgress` is cleared, the next startup has consistent data (the `set` completed) but stale in-memory flags. Since all flags are initialized to `false`/empty on page load, this is safe — the next sync cycle operates normally.

---

## Testing Strategy

- **Manual cross-device testing:** Edit a session on Mac, verify it appears on iOS (and vice versa). Edit the same session on both before sync fires, verify conflict copy is created.
- **Background termination testing:** On iOS, save a session, immediately switch away from Safari, wait, return — verify the session synced.
- **Large dataset testing:** Create 50+ sessions, enable sync, verify full push completes without timeout.
- **Account switch testing:** Sign out of iCloud, sign into a different account, verify sync detects the change and does a full re-fetch.
- **Debug pipeline:** Use existing `debug()` logging to trace sync operations end-to-end.
