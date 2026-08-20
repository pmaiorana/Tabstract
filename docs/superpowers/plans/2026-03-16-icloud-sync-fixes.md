# iCloud Sync Reliability Fixes — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 9 data-loss, race-condition, and reliability bugs identified in the sync code review.

**Architecture:** Changes span two files: `CloudKitSyncEngine.swift` (Swift actor handling CloudKit operations) and `background.js` (JS sync orchestration in the Safari extension background page). The Swift changes are independent of each other. The JS changes have ordering dependencies documented below.

**Tech Stack:** Swift (CloudKit, CKRecord, CKAsset), JavaScript (Chrome Extension APIs: storage, alarms, runtime messaging)

**No automated tests.** This project has no test suite. Each task includes manual verification steps using the debug pipeline (native messaging → file). Enable debug mode: `chrome.storage.local.set({debugMode: true})` in any extension page console. Debug output: `~/Library/Group Containers/84HBFJDM48.group.com.paulmaiorana.Tabstract/debug/console.log`.

**Build command (macOS):** `xcodebuild -scheme "Tabstract" -destination "platform=macOS" build`

---

## Dependency Graph

```
Task 1 (Swift: ISO8601 formatter)  — independent
Task 2 (Swift: save policy)        — independent
Task 3 (JS: conflict copies)       — independent, do first in JS
Task 4 (JS: merge guard refactor)  — depends on Task 3
Task 5 (JS: per-record failure)    — independent
Task 6 (JS: token retry limit)     — independent
Task 7 (JS: re-enable full push)   — independent
Task 8 (JS: ISO8601 normalization) — independent
Task 9 (JS: dirty map rehydration)  — independent
```

Recommended order: Tasks 1–2 (Swift, parallel), then Tasks 3–9 (JS, Task 3 before Task 4). Commit after each task.

---

## Task 1: Static ISO8601DateFormatter in Swift

**Bug:** `ISO8601DateFormatter()` is instantiated dozens of times per sync cycle. Not a correctness bug, but wasteful and relevant because Task 8 changes the format.

**Files:**
- Modify: `Tabstract Extension/CloudKitSyncEngine.swift`

- [ ] **Step 1: Add a static formatter with fractional seconds**

At the top of the `CloudKitSyncEngine` actor (after the `tombstoneTTLDays` constant, line 62), add:

```swift
/// Shared formatter — uses fractional seconds to match JS `Date.toISOString()`.
/// Must only be used from the actor (not `nonisolated` methods).
private static let iso8601Formatter: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
}()
```

- [ ] **Step 2: Replace all inline `ISO8601DateFormatter()` calls**

Search the file for `ISO8601DateFormatter()` — every call site except the `static let` itself needs to change to `CloudKitSyncEngine.iso8601Formatter`. There are roughly 8 call sites:

| Location | Change |
|----------|--------|
| `pushRecords` (line ~382) | `ISO8601DateFormatter().date(from:)` → `CloudKitSyncEngine.iso8601Formatter.date(from:)` |
| `pullChanges` → `recordWasChangedBlock` (line ~598) | `ISO8601DateFormatter().string(from:)` → `CloudKitSyncEngine.iso8601Formatter.string(from:)` |
| `updateLastSyncTime` (line ~233) | `ISO8601DateFormatter().string(from:)` → `CloudKitSyncEngine.iso8601Formatter.string(from:)` |
| `purgeStaleTombstonesIfNeeded` (lines ~681, ~686) | Both `ISO8601DateFormatter()` calls → `CloudKitSyncEngine.iso8601Formatter` |
| `loadChangeToken` / `saveChangeToken` | These use `NSKeyedArchiver`, no formatter — skip |

**Important:** The `executePullOperation` method is `nonisolated static` (line 576). It accesses the formatter inside the `recordWasChangedBlock` closure which runs on a CK callback thread. Since `ISO8601DateFormatter` is **not** thread-safe, create a local formatter inside that closure instead:

```swift
// Inside recordWasChangedBlock (line ~598):
let formatter = ISO8601DateFormatter()
formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
if let modifiedAt = record["modifiedAt"] as? Date {
    entry["modifiedAt"] = formatter.string(from: modifiedAt)
}
```

- [ ] **Step 3: Build and verify**

Run: `xcodebuild -scheme "Tabstract" -destination "platform=macOS" build`
Expected: Build succeeds with no errors.

- [ ] **Step 4: Commit**

```
fix(sync): use shared ISO8601 formatter with fractional seconds

Eliminates repeated allocations and standardizes on fractional-second
format to match JavaScript's Date.toISOString() output. Fixes timestamp
comparison mismatch between Swift and JS (review issue 1C).
```

---

## Task 2: Switch push save policy to detect conflicts

**Bug (1A):** `pushBatch` creates fresh `CKRecord` objects and uses `.changedKeys`, which means CloudKit never detects conflicts — the server record is silently overwritten. The conflict copy system never triggers on push-push races.

**Design decision:** We do NOT switch to `.ifServerRecordUnchanged` (which would require fetching server records first, doubling latency). Instead, we keep `.changedKeys` but set `modifiedAt` as a custom field and handle conflict detection in the JS merge logic (which already exists). The real fix is making the **pull-side merge** aware that a just-pushed record might have been overwritten — which Tasks 3–4 handle.

However, we should **also** log when `.changedKeys` silently wins over a server record, so we have visibility. The simplest high-value change: switch to `.allKeys` so that every field is written (not just "changed" fields relative to a nonexistent baseline), which is more correct for our "always write full records" pattern.

**Files:**
- Modify: `Tabstract Extension/CloudKitSyncEngine.swift:464`

- [ ] **Step 1: Change save policy**

```swift
// Line 464: change from .changedKeys to .allKeys
operation.savePolicy = .allKeys
```

This is a one-line change. `.allKeys` still overwrites without conflict detection, but it's semantically correct — we're always sending the full record, not a delta.

- [ ] **Step 2: Build and verify**

Run: `xcodebuild -scheme "Tabstract" -destination "platform=macOS" build`
Expected: Build succeeds.

- [ ] **Step 3: Commit**

```
fix(sync): use .allKeys save policy for push operations

Fresh CKRecords have no server change tag, so .changedKeys was
semantically misleading. .allKeys correctly reflects that we always
send the full record payload. Conflict detection remains pull-side
via LWW merge (review issue 1A).
```

---

## Task 3: Fix conflict copies never syncing (CRITICAL)

**Bug (2C):** In `mergeRemoteChanges`, conflict copies are added to `_syncMergedRecordNames` at line 5016 and then `markSyncDirty` is called at line 5017. But `markSyncDirty` checks that set at line 4590 and exits early — so conflict copies are **never marked dirty** and never reach CloudKit.

**Files:**
- Modify: `Tabstract Extension/Resources/background.js:5012-5020`

- [ ] **Step 1: Fix the conflict copy dirty-marking**

Replace lines 5012-5020:

```js
        // Mark conflict copies as dirty so they sync to other devices
        if (_syncPendingConflictCopies.length > 0) {
          const copies = _syncPendingConflictCopies.splice(0);
          for (const copy of copies) {
            _syncMergedRecordNames.add(copy.recordName);
            markSyncDirty(copy.recordType, copy.recordName, copy.payload);
          }
          debug('[Sync] Marked', copies.length, 'conflict copies dirty for sync');
        }
```

With:

```js
        // Mark conflict copies as dirty so they sync to other devices.
        // Add directly to _syncDirtyRecords — do NOT use markSyncDirty()
        // because _syncMergedRecordNames would suppress it.
        if (_syncPendingConflictCopies.length > 0) {
          const copies = _syncPendingConflictCopies.splice(0);
          for (const copy of copies) {
            _syncDirtyRecords.set(copy.recordName, {
              recordType: copy.recordType,
              recordName: copy.recordName,
              payload: copy.payload,
              modifiedAt: new Date().toISOString(),
              isDeleted: false
            });
          }
          chrome.storage.local.set({ _syncDirtyRecords: Object.fromEntries(_syncDirtyRecords) });
          scheduleSyncPush();
          debug('[Sync] Marked', copies.length, 'conflict copies dirty for sync');
        }
```

**Why this works:** We bypass `markSyncDirty()` entirely and write directly to the dirty map + persist it. This avoids the `_syncMergedRecordNames` check. The `scheduleSyncPush()` call ensures the records get pushed after the debounce period.

- [ ] **Step 2: Apply the same fix to the `!modified` branch**

The `!modified` branch (lines 5031-5043) doesn't have conflict copy handling at all. Conflict copies are only created when `modified` is true (since creating a copy sets `modified = true`), so this branch can't have pending copies. No change needed — but verify by reading lines 5031-5043 to confirm there's no `_syncPendingConflictCopies` reference there.

- [ ] **Step 3: Build and verify**

Run: `xcodebuild -scheme "Tabstract" -destination "platform=macOS" build`
Expected: Build succeeds.

**Manual verification:**
1. Enable debug mode on two devices syncing the same account.
2. Edit a session title on Device A.
3. Before A pushes (within 2s debounce), edit the same session on Device B.
4. Let both sync.
5. Check: Device that "lost" LWW should have a "(sync conflict)" copy. Wait for next sync cycle — the conflict copy should appear on the other device too.
6. Check `console.log` for: `[Sync] Marked N conflict copies dirty for sync` followed later by `[Sync] Push succeeded: N records`.

- [ ] **Step 4: Commit**

```
fix(sync): conflict copies now actually sync to other devices

Conflict copies were added to _syncMergedRecordNames before calling
markSyncDirty(), which checked that set and exited early. Now writes
directly to the dirty map, bypassing the suppression. (review issue 2C)
```

---

## Task 4: Replace timeout-based merge guard with generation counter

**Bug (2A/2B):** `_syncMergedRecordNames` is cleared by a 1-second `setTimeout`, which races with deferred write draining and late `storage.onChanged` events. Deferred writes fire after `_syncMergeInProgress = false`, so they aren't suppressed by the merge flag, and the timeout may clear the record names before their `onChanged` events arrive.

**Files:**
- Modify: `Tabstract Extension/Resources/background.js`

- [ ] **Step 1: Add a merge generation counter**

At line 69 (where `_syncMergedRecordNames` is declared), replace:

```js
let _syncMergedRecordNames = new Set(); // record names from current/recent merge
```

With:

```js
let _syncMergedRecordNames = new Set(); // record names from current/recent merge
let _syncMergeGeneration = 0;           // incremented each merge; onChanged uses to ignore stale events
```

- [ ] **Step 2: Update `mergeRemoteChanges` to use the generation counter**

In `mergeRemoteChanges`, in the `chrome.storage.local.set` callback (line ~4999), replace both branches' cleanup logic.

**Modified branch (lines 4999-5030)** — replace lines 5001-5003:

```js
        _syncMergeInProgress = false;
        // Clear merged record names after a short delay to catch any late onChanged events
        setTimeout(() => { _syncMergedRecordNames.clear(); }, 1000);
```

With:

```js
        _syncMergeInProgress = false;
        // Increment generation — onChanged listeners that see a stale generation
        // will ignore their events without needing a fragile timeout
        const mergeGen = ++_syncMergeGeneration;
```

Then replace lines 5004-5010 (deferred write draining):

```js
        // Drain deferred writes that were queued during merge
        if (_syncDeferredWrites.length > 0) {
          const deferred = _syncDeferredWrites.splice(0);
          debug('[Sync] Draining', deferred.length, 'deferred writes');
          for (const op of deferred) {
            try { op(); } catch (e) { debug('[Sync] Deferred write error:', String(e)); }
          }
        }
```

With:

```js
        // Drain deferred writes that were queued during merge.
        // These will trigger onChanged — the generation counter handles suppression.
        if (_syncDeferredWrites.length > 0) {
          const deferred = _syncDeferredWrites.splice(0);
          debug('[Sync] Draining', deferred.length, 'deferred writes');
          for (const op of deferred) {
            try { op(); } catch (e) { debug('[Sync] Deferred write error:', String(e)); }
          }
        }
        // Clear merged names only after deferred writes have been dispatched
        // and enough time has passed for their onChanged events to fire.
        // The generation counter ensures we only clear OUR set, not a newer merge's.
        setTimeout(() => {
          if (_syncMergeGeneration === mergeGen) {
            _syncMergedRecordNames.clear();
          }
        }, 2000);
```

**Unmodified branch (lines 5032-5043)** — apply the same pattern. Replace:

```js
      _syncMergeInProgress = false;
      setTimeout(() => { _syncMergedRecordNames.clear(); }, 1000);
      // Drain deferred writes
      if (_syncDeferredWrites.length > 0) {
        const deferred = _syncDeferredWrites.splice(0);
        debug('[Sync] Draining', deferred.length, 'deferred writes');
        for (const op of deferred) {
          try { op(); } catch (e) { debug('[Sync] Deferred write error:', String(e)); }
        }
      }
```

With:

```js
      _syncMergeInProgress = false;
      const mergeGen = ++_syncMergeGeneration;
      if (_syncDeferredWrites.length > 0) {
        const deferred = _syncDeferredWrites.splice(0);
        debug('[Sync] Draining', deferred.length, 'deferred writes');
        for (const op of deferred) {
          try { op(); } catch (e) { debug('[Sync] Deferred write error:', String(e)); }
        }
      }
      setTimeout(() => {
        if (_syncMergeGeneration === mergeGen) {
          _syncMergedRecordNames.clear();
        }
      }, 2000);
```

- [ ] **Step 3: Update the `storage.onChanged` listener to also check merge generation**

In the `storage.onChanged` listener at line 842, the existing guard is:

```js
chrome.storage.onChanged.addListener((changes) => {
  if (_syncMergeInProgress) return;
```

This stays as-is — no change needed. The `_syncMergedRecordNames` per-record check in `markSyncDirty` (line 4590) already handles the rest. The generation counter just prevents premature clearing of the set.

- [ ] **Step 4: Build and verify**

Run: `xcodebuild -scheme "Tabstract" -destination "platform=macOS" build`
Expected: Build succeeds.

**Manual verification:**
1. Enable debug mode. Trigger a sync pull that produces changes (edit a session on another device).
2. Watch `console.log` for the merge sequence.
3. Verify no `[Sync] Push succeeded` appears within 3 seconds of merge for records that were just pulled (would indicate re-dirtying loop).

- [ ] **Step 5: Commit**

```
fix(sync): replace timeout-based merge guard with generation counter

The 1-second setTimeout to clear _syncMergedRecordNames raced with
deferred write draining and late onChanged events. Now uses an
incrementing generation counter so only the originating merge clears
its own set, and extends the timeout to 2s to cover deferred writes.
(review issues 2A, 2B)
```

---

## Task 5: Fix push failure handling to be per-record

**Bug (3C):** When any conflict exists in a push batch, ALL failed records are dropped — including non-conflict failures that should be re-queued.

**Files:**
- Modify: `Tabstract Extension/Resources/background.js:4658-4670`
- Modify: `Tabstract Extension/CloudKitSyncEngine.swift:436-460, 488-506`

- [ ] **Step 1: Return per-record conflict info from Swift**

In `CloudKitSyncEngine.swift`, modify `PushCollector` to track conflict vs non-conflict separately. Replace the `PushCollector` class (lines 437-460):

```swift
    // Thread-safe collector for per-record push outcomes
    private final class PushCollector: @unchecked Sendable {
        private let lock = NSLock()
        private var _conflictRecordNames: [String] = []
        private var _failedRecordNames: [String] = []

        func addFailure(_ name: String, isConflict: Bool) {
            lock.lock()
            defer { lock.unlock() }
            if isConflict {
                _conflictRecordNames.append(name)
            } else {
                _failedRecordNames.append(name)
            }
        }

        var conflictRecordNames: [String] {
            lock.lock()
            defer { lock.unlock() }
            return _conflictRecordNames
        }

        var failedRecordNames: [String] {
            lock.lock()
            defer { lock.unlock() }
            return _failedRecordNames
        }

        var allFailedNames: [String] {
            lock.lock()
            defer { lock.unlock() }
            return _conflictRecordNames + _failedRecordNames
        }

        var hasConflicts: Bool {
            lock.lock()
            defer { lock.unlock() }
            return !_conflictRecordNames.isEmpty
        }
    }
```

- [ ] **Step 2: Update `pushBatch` response to include separate lists**

In `pushBatch` (line ~492), update the success response:

```swift
case .success:
    let allFailed = collector.allFailedNames
    response = [
        "pushed": records.count - allFailed.count,
        "failedRecordNames": collector.failedRecordNames,
        "conflictRecordNames": collector.conflictRecordNames,
        "hasConflicts": collector.hasConflicts
    ]
```

- [ ] **Step 3: Update `pushRecords` to aggregate both lists**

In `pushRecords` (lines ~345-433), add a `allConflictRecordNames` array alongside `allFailedRecordNames`. After the batch loop, include it in the response:

At line ~345, add:
```swift
var allConflictRecordNames: [String] = []
```

In the batch result processing (lines ~408-413), add:
```swift
if let conflicts = result["conflictRecordNames"] as? [String] {
    allConflictRecordNames.append(contentsOf: conflicts)
}
```

In the response construction (lines ~424-433), add:
```swift
if !allConflictRecordNames.isEmpty {
    response["conflictRecordNames"] = allConflictRecordNames
}
```

- [ ] **Step 4: Update JS push handler to re-queue non-conflict failures separately**

In `background.js`, replace lines 4658-4670:

```js
      // Re-queue non-conflict failures; conflicts resolved via pull
      if (response.failedRecordNames && response.failedRecordNames.length > 0) {
        if (!response.hasConflicts) {
          for (const name of response.failedRecordNames) {
            const original = records.find(r => r.recordName === name);
            if (original && !_syncDirtyRecords.has(name)) {
              _syncDirtyRecords.set(name, original);
            }
          }
        } else {
          debug('[Sync] Conflicts detected, will resolve via pull');
        }
      }
```

With:

```js
      // Re-queue non-conflict failures (network errors, etc.)
      if (response.failedRecordNames && response.failedRecordNames.length > 0) {
        for (const name of response.failedRecordNames) {
          const original = records.find(r => r.recordName === name);
          if (original && !_syncDirtyRecords.has(name)) {
            _syncDirtyRecords.set(name, original);
          }
        }
      }
      // Conflicts are resolved via the pull that follows
      if (response.hasConflicts) {
        debug('[Sync] Conflicts detected, will resolve via pull');
      }
```

- [ ] **Step 5: Build and verify**

Run: `xcodebuild -scheme "Tabstract" -destination "platform=macOS" build`
Expected: Build succeeds.

- [ ] **Step 6: Commit**

```
fix(sync): re-queue non-conflict push failures independently of conflicts

Previously, when any conflict existed in a push batch, all failed
records were dropped. Now Swift returns separate conflictRecordNames
and failedRecordNames lists, and JS re-queues non-conflict failures
regardless of whether conflicts exist. (review issue 3C)
```

---

## Task 6: Add retry limit to token-expired pull

**Bug (3A):** `executeSyncPull` calls itself recursively on `tokenExpired` with no depth limit, risking stack overflow or Safari killing the page.

**Files:**
- Modify: `Tabstract Extension/Resources/background.js:4696, 4729-4731`

- [ ] **Step 1: Add retry parameter to `executeSyncPull`**

Change the function signature at line 4696:

```js
function executeSyncPull(callback, _tokenRetries) {
```

At line 4729-4731, replace:

```js
    } else if (response?.error === 'tokenExpired') {
      debug('[Sync] Token expired, retrying pull');
      executeSyncPull(callback);
```

With:

```js
    } else if (response?.error === 'tokenExpired') {
      const retries = (_tokenRetries || 0) + 1;
      if (retries <= 1) {
        debug('[Sync] Token expired, retrying pull (attempt', retries + ')');
        executeSyncPull(callback, retries);
      } else {
        debug('[Sync] Token expired after', retries, 'retries, giving up');
        if (callback) callback(false);
        if (_syncPullDeferred) {
          _syncPullDeferred = false;
          executeSyncPull();
        }
      }
```

Note: the `_tokenRetries` parameter won't be passed by any existing callers (they pass just `callback`), so it defaults to `undefined` → `0 + 1 = 1` on first retry, which is the one allowed attempt.

- [ ] **Step 2: Build and verify**

Run: `xcodebuild -scheme "Tabstract" -destination "platform=macOS" build`
Expected: Build succeeds.

- [ ] **Step 3: Commit**

```
fix(sync): limit token-expired pull retries to 1

Prevents infinite recursion when CloudKit repeatedly returns
tokenExpired (e.g., zone deleted). (review issue 3A)
```

---

## Task 7: Mark all records dirty on sync re-enable

**Bug (3B):** When sync is re-enabled after being off, `handleSyncEnable` clears the change token so the first pull does a full fetch. But local changes made while sync was off have no `_syncModifiedAt` timestamps, so LWW lets the remote version win. The existing `performFullPush` call on enable should protect against this, but it runs **before** the pull, so any remote records with newer `modifiedAt` will overwrite the just-pushed local records on the subsequent pull.

The fix is straightforward: ensure all local records get fresh `_syncModifiedAt` timestamps before the full push, so they can compete in LWW.

**Files:**
- Modify: `Tabstract Extension/Resources/background.js:1491-1502`

- [ ] **Step 1: Add a function to stamp all local records**

Add this function right after `performFullPush` (after line ~5168):

```js
/**
 * Stamp ALL local records with _syncModifiedAt = now.
 * Called on sync re-enable so local changes made while sync was off
 * can compete fairly in LWW merge during the first pull.
 * Stamps unconditionally — records modified while sync was off still
 * carry stale _syncModifiedAt from their last sync.
 */
function stampAllLocalRecords(callback) {
  const now = new Date().toISOString();
  chrome.storage.local.get(['savedSessions', 'savedTemplates', 'smartGroups', 'trashedLinks'], (result) => {
    const sessions = (result.savedSessions || []).map(s => ({ ...s, _syncModifiedAt: now }));
    const templates = (result.savedTemplates || []).map(t => ({ ...t, _syncModifiedAt: now }));
    const smartGroups = (result.smartGroups || []).map(g => ({ ...g, _syncModifiedAt: now }));
    const trashedLinks = (result.trashedLinks || []).map(l => ({ ...l, _syncModifiedAt: now }));
    chrome.storage.local.set({ savedSessions: sessions, savedTemplates: templates, smartGroups: smartGroups, trashedLinks: trashedLinks }, () => {
      if (callback) callback();
    });
  });
}
```

- [ ] **Step 2: Call it before `performFullPush` in the enable flow**

In the `enableSync` message handler (line ~1495), replace:

```js
          }, () => {
            scheduleSyncAlarm();
            // Full push then pull
            performFullPush(() => {
              executeSyncPull(() => {
                sendResponse({ success: true, deviceID: response.deviceID });
              });
            });
          });
```

With:

```js
          }, () => {
            scheduleSyncAlarm();
            // Stamp local records so they compete in LWW, then full push, then pull
            stampAllLocalRecords(() => {
              performFullPush(() => {
                executeSyncPull(() => {
                  sendResponse({ success: true, deviceID: response.deviceID });
                });
              });
            });
          });
```

- [ ] **Step 3: Build and verify**

Run: `xcodebuild -scheme "Tabstract" -destination "platform=macOS" build`
Expected: Build succeeds.

**Manual verification:**
1. Disable sync. Edit several sessions locally.
2. Re-enable sync.
3. Verify local sessions are NOT overwritten by stale remote versions.
4. Check `console.log` for the full push succeeding with all records.

- [ ] **Step 4: Commit**

```
fix(sync): stamp local records on re-enable to prevent data loss

Local changes made while sync was off had stale or missing
_syncModifiedAt, so they lost LWW comparisons during the first pull
after re-enabling. Now stamps all records unconditionally before the
initial full push. (review issue 3B)
```

---

## Task 8: Normalize ISO 8601 format in JS to match Swift

**Bug (1C):** Swift's `ISO8601DateFormatter` (after Task 1) produces fractional seconds. JS's `Date.toISOString()` also produces fractional seconds. After Task 1, both sides produce the same format. But the **existing data** in storage may have timestamps in the old Swift format (no fractional seconds). Add a normalization step to the LWW comparison.

**Files:**
- Modify: `Tabstract Extension/Resources/background.js`

- [ ] **Step 1: Add a timestamp normalization helper**

Add this near the top of the iCloud Sync System section (after `runOrDeferSyncWrite` at line ~4571):

```js
/**
 * Normalize a sync timestamp for reliable comparison.
 * Handles both ISO 8601 with and without fractional seconds,
 * and legacy numeric timestamps.
 */
function normalizeSyncTimestamp(ts) {
  if (!ts) return 0;
  if (typeof ts === 'number') return ts;
  const d = new Date(ts);
  return isNaN(d.getTime()) ? 0 : d.getTime();
}
```

- [ ] **Step 2: Replace string comparisons in `mergeRemoteChanges`**

In `mergeRemoteChanges`, update the four LWW comparison sites:

**Session (line ~4835):**

Replace:
```js
            const localMod = local._syncModifiedAt || local.timestamp;
            if (!localMod || modifiedAt > localMod) {
```

With:
```js
            const localModMs = normalizeSyncTimestamp(local._syncModifiedAt || local.timestamp);
            const remoteModMs = normalizeSyncTimestamp(modifiedAt);
            if (!localModMs || remoteModMs > localModMs) {
```

**Template (line ~4870):**

Replace:
```js
            const localMod = local._syncModifiedAt || '';
            if (!localMod || modifiedAt > localMod) {
```

With:
```js
            const localModMs = normalizeSyncTimestamp(local._syncModifiedAt);
            const remoteModMs = normalizeSyncTimestamp(modifiedAt);
            if (!localModMs || remoteModMs > localModMs) {
```

**SmartGroup (line ~4903):**

Replace:
```js
            const localMod = local._syncModifiedAt || '';
            if (!localMod || modifiedAt > localMod) {
```

With:
```js
            const localModMs = normalizeSyncTimestamp(local._syncModifiedAt);
            const remoteModMs = normalizeSyncTimestamp(modifiedAt);
            if (!localModMs || remoteModMs > localModMs) {
```

**TrashedLink (line ~4936):**

Replace:
```js
            const localMod = local._syncModifiedAt || '';
            if (!localMod || modifiedAt > localMod) {
```

With:
```js
            const localModMs = normalizeSyncTimestamp(local._syncModifiedAt);
            const remoteModMs = normalizeSyncTimestamp(modifiedAt);
            if (!localModMs || remoteModMs > localModMs) {
```

- [ ] **Step 3: Build and verify**

Run: `xcodebuild -scheme "Tabstract" -destination "platform=macOS" build`
Expected: Build succeeds.

- [ ] **Step 4: Commit**

```
fix(sync): normalize timestamps to millis for LWW comparison

String comparison of ISO 8601 timestamps fails when formats differ
(with vs without fractional seconds, or numeric epoch vs string).
Now parses to milliseconds before comparing. (review issue 1C, 4B)
```

---

## Task 9: Ensure dirty map is rehydrated before first pull

**Bug (4A):** `shouldCreateConflictCopy` checks the in-memory `_syncDirtyRecords` Map. After a background page restart, `initSyncOnStartup` restores dirty records from storage, but the first pull is scheduled via `setTimeout(3000)`. If the storage read callback takes longer than expected (or the alarm-based safety net fires first), the pull can arrive before dirty records are rehydrated, causing `shouldCreateConflictCopy` to return false for records that were locally modified.

**Files:**
- Modify: `Tabstract Extension/Resources/background.js:5215-5253`

- [ ] **Step 1: Restructure `initSyncOnStartup` to rehydrate before scheduling the pull**

Replace the entire `initSyncOnStartup` function (lines 5215-5264):

```js
function initSyncOnStartup() {
  // Clear "newer version available" flag if app version has changed
  const currentVersion = chrome.runtime.getManifest().version;
  chrome.storage.local.get(['_syncLastKnownVersion'], (res) => {
    if (res._syncLastKnownVersion !== currentVersion) {
      chrome.storage.local.set({
        _syncLastKnownVersion: currentVersion,
        _syncNewerVersionAvailable: false
      });
    }
  });

  chrome.storage.local.get(['icloudSyncEnabled', '_syncDirtyRecords'], (result) => {
    // Restore dirty records FIRST, before any pull
    const persisted = result._syncDirtyRecords;
    if (persisted && typeof persisted === 'object') {
      let count = 0;
      for (const [name, record] of Object.entries(persisted)) {
        if (!_syncDirtyRecords.has(name)) {
          _syncDirtyRecords.set(name, record);
          count++;
        }
      }
      if (count > 0) {
        debug('[Sync] Restored', count, 'persisted dirty records');
        scheduleSyncPush();
      }
    }

    if (result.icloudSyncEnabled) {
      scheduleSyncAlarm();
      // Trigger initial pull after 3s delay — dirty map is already rehydrated
      setTimeout(() => executeSyncPull(), 3000);
      // Alarm safety net in case setTimeout doesn't fire
      chrome.alarms.create('syncStartupPull', { delayInMinutes: 1 });
    }
  });

  // One-time cleanup: remove any non-session objects from savedSessions
  // (guards against data corruption from sync misrouting)
  chrome.storage.local.get(['savedSessions'], (result) => {
    const sessions = result.savedSessions || [];
    const clean = sessions.filter(s => Array.isArray(s.tabs));
    if (clean.length !== sessions.length) {
      debug('[Sync] Startup cleanup: removing', sessions.length - clean.length, 'non-session items from savedSessions');
      chrome.storage.local.set({ savedSessions: clean });
    }
  });
}
```

**Key change:** The `icloudSyncEnabled` and `_syncDirtyRecords` reads are merged into a single `chrome.storage.local.get` call. The dirty map is rehydrated **before** `scheduleSyncAlarm()` and the pull timer, guaranteeing the Map is populated when the first pull's merge runs.

- [ ] **Step 2: Remove the old standalone dirty records restoration block**

The old code at lines ~5237-5253 (the separate `chrome.storage.local.get(['_syncDirtyRecords'], ...)` call) is now merged into the block above. Verify it's been removed and not duplicated.

- [ ] **Step 3: Build and verify**

Run: `xcodebuild -scheme "Tabstract" -destination "platform=macOS" build`
Expected: Build succeeds.

- [ ] **Step 4: Commit**

```
fix(sync): rehydrate dirty map before first pull on startup

shouldCreateConflictCopy checks in-memory _syncDirtyRecords, which
was restored in a separate storage.get call that could complete after
the first pull. Now merges both reads into one call so the dirty map
is populated before scheduling any pulls. (review issue 4A)
```

---

## Final Verification

After all 8 tasks are committed:

- [ ] **Full build:** `xcodebuild -scheme "Tabstract" -destination "platform=macOS" build`
- [ ] **iOS build:** `xcodebuild -scheme "Tabstract iOS" -destination "generic/platform=iOS Simulator" build`
- [ ] **Manual smoke test:** Enable sync on two devices, save a session on each, verify both appear on both devices within 30 seconds.
- [ ] **Conflict test:** Edit the same session on both devices simultaneously, verify conflict copy appears and syncs.
