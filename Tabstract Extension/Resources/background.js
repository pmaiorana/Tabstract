// =============================
// Centralized Default Settings
// =============================
const DEFAULT_SETTINGS = {
  popupBehavior: "saveAndClose",   // "Save Tabs" also closes all of your open tabs
  deleteAfterRestore: true,        // Restoring tabs deletes them from Tabstract
  closeHomeTabOnOpen: true,        // Close Tabstract after restoring tabs
  restoreTabsTo: "current",        // Where to restore tabs: "current", "new", or "smart"
  enableBadge: true,               // Display reminder badge in toolbar
  enableKeyboardShortcuts: true,   // Enable keyboard shortcuts
  snoozeHours: 24,                 // Default badge-snooze hours
  undoTimeoutSec: 5,               // Default "undo" timeout (in seconds)
  darkMode: "Auto",                // "Light", "Dark", or "Auto"
  pinnedTabs: true,                // If true, pinned tabs are ignored (not saved/closed)
  avoidDuplicates: true,           // "Don't save duplicate tabs in the same session"
  saveAllWindows: false,           // If true, save tabs from all windows instead of current window only
  opentabsBackground: true,        // If true, newly opened/restored tabs open in background
  launchOnStartup: false,          // If true, open Tabstract when Safari starts
  saveTabsOnStartup: false,        // If true, save all open tabs as a session on Safari launch
  totalSessionsSaved: 0,           // Cumulative count of sessions saved
  installDate: 0,                  // Install date timestamp (set on first run)
  trashedLinks: [],                // Array of trashed link objects
  maxTrashItems: 1000,             // Maximum number of items to keep in trash
  trashRetentionDays: 30,          // Days to retain trashed items before auto-deletion
  aiTitleSuggestions: false,       // Use on-device AI to suggest session titles
  aiSmartCategorization: false,    // Automatically organize sessions by topic (future)
  debugMode: false,                // Enable debug logging to console
  icloudSyncEnabled: false,        // iCloud sync enabled
  icloudSyncLastTime: null,        // Last successful sync timestamp
  icloudSyncDeviceID: null         // This device's unique ID for sync
};

// Backup debounce uses in-memory timestamp (resets on service worker restart)

// Track active categorization/title operations to prevent duplicate concurrent calls
const activeCategorizationTimestamps = new Set();
const activeTitleTimestamps = new Set();

// Queue for serializing AI title storage updates to prevent race conditions
const titleUpdateQueue = [];
let titleUpdateProcessing = false;

// Define the extension pages to be matched in various functions
const EXTENSION_PAGES = [
  "list.html",
  "settings.html",
  "help.html"
];

// All features are now free - no pro gating

// Track last known Apple Intelligence availability so we can avoid re-queueing doomed work
let lastKnownAIAvailability = null;

// =============================
// iCloud Sync State
// =============================
const SYNC_DEBOUNCE_MS = 2000;        // 2s debounce after writes
const SYNC_ALARM_NAME = 'icloudSync';
const SYNC_ALARM_MINUTES = 5;
const SYNC_PUSH_DEBOUNCE_ALARM = 'syncPushDebounce';
const SYNC_LOCK_TIMEOUT_MS = 30000;   // 30s — if push/pull lock held longer, consider it stale
let _syncDirtyRecords = new Map();     // recordName → {recordType, payload, modifiedAt, isDeleted}
let _syncPushTimeout = null;
let _syncPushInProgress = false;
let _syncPushLockedAt = 0;            // timestamp when push lock was acquired
let _syncPullInProgress = false;
let _syncPullLockedAt = 0;            // timestamp when pull lock was acquired
let _syncPushDeferred = false;
let _syncPullDeferred = false;
let _syncMergeInProgress = false;      // prevents re-dirtying during merge
let _syncMergedRecordNames = new Set(); // record names from current/recent merge
let _syncMergeGeneration = 0;           // incremented each merge; onChanged uses to ignore stale events
let _syncDeferredWrites = [];           // queued operations during merge
let _syncPendingConflictCopies = [];    // conflict copies to mark dirty after merge
let _syncInFlightRecordNames = new Set(); // records in a push whose response hasn't arrived yet
let lastAICheckDetails = null;

// Cache for page metadata to survive content script termination and browser restarts
// Map<url, {ogDescription: string, timestamp: number}>
const pageMetadataCache = new Map();
const METADATA_CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days (meta descriptions rarely change)
const METADATA_STORAGE_KEY = 'pageMetadataCache';
let metadataCacheLoaded = false;

// Load cache from storage on startup
chrome.storage.local.get([METADATA_STORAGE_KEY], (result) => {
  if (result[METADATA_STORAGE_KEY]) {
    const stored = result[METADATA_STORAGE_KEY];
    const now = Date.now();
    let loaded = 0;
    let expired = 0;

    for (const [url, data] of Object.entries(stored)) {
      // Only load non-expired entries
      if (data && data.timestamp && (now - data.timestamp) < METADATA_CACHE_TTL) {
        pageMetadataCache.set(url, data);
        loaded++;
      } else {
        expired++;
      }
    }

    if (loaded > 0) {
      debug(`[Tabstract BG] Loaded ${loaded} cached descriptions from storage (${expired} expired)`);
    }
  }
  metadataCacheLoaded = true;
});

// Debounced persistence of metadata cache
let persistMetadataTimeout = null;
function persistMetadataCache() {
  // Debounce writes - wait for 2 seconds of inactivity before persisting
  if (persistMetadataTimeout) {
    clearTimeout(persistMetadataTimeout);
  }

  persistMetadataTimeout = setTimeout(() => {
    const cacheObject = Object.fromEntries(pageMetadataCache);
    chrome.storage.local.set({ [METADATA_STORAGE_KEY]: cacheObject }, () => {
      if (chrome.runtime.lastError) {
        debug('[Tabstract BG] Error persisting metadata cache:', chrome.runtime.lastError);
      }
    });
  }, 2000);
}

// Periodic cleanup of expired cache entries (every 10 minutes)
setInterval(() => {
  const now = Date.now();
  let removed = 0;

  for (const [url, data] of pageMetadataCache.entries()) {
    if (!data || !data.timestamp || (now - data.timestamp) >= METADATA_CACHE_TTL) {
      pageMetadataCache.delete(url);
      removed++;
    }
  }

  if (removed > 0) {
    persistMetadataCache();
    debug(`[Tabstract BG] Cleaned up ${removed} expired metadata cache entries`);
  }
}, 10 * 60 * 1000);

// Helper function to get the full URLs for all extension pages
function getExtensionPageUrls() {
  return EXTENSION_PAGES.map(page => chrome.runtime.getURL(page));
}

// =============================
// Smart Groups Pattern Matching
// =============================

/**
 * Check if a tab matches a Smart Group pattern
 * @param {Object} tab - Tab object with url and title
 * @param {Object} smartGroup - Smart Group with patterns array and matchMode
 * @returns {boolean} - True if tab matches based on matchMode (any/all)
 */
function matchesSmartGroupPattern(tab, smartGroup) {
  // Support multiple patterns
  const patterns = smartGroup.patterns || [];
  if (patterns.length === 0) return false;

  const url = (tab.url || '').toLowerCase();
  const title = (tab.title || '').toLowerCase();
  const searchText = `${url} ${title}`;
  const matchMode = smartGroup.matchMode || 'any'; // Default to 'any' for backward compatibility

  // Helper function to test a single pattern
  const testPattern = (pattern) => {
    try {
      const { type, value } = pattern;
      if (!value || !type) return false;

      switch (type) {
        case 'domain': {
          // Extract hostname from URL
          let hostname = '';
          try {
            const urlObj = new URL(tab.url);
            hostname = urlObj.hostname.toLowerCase();
          } catch (e) {
            return false;
          }
          const patternLower = value.toLowerCase();
          // Match exact domain OR subdomain (e.g., "github.com" matches both "github.com" and "api.github.com")
          return hostname === patternLower || hostname.endsWith('.' + patternLower);
        }

        case 'keyword': {
          const patternLower = value.toLowerCase();
          return searchText.includes(patternLower);
        }

        case 'regex': {
          const regex = new RegExp(value, 'i'); // case-insensitive
          return regex.test(searchText);
        }

        default:
          return false;
      }
    } catch (error) {
      debug(`[Smart Groups] Error matching pattern for group "${smartGroup.name}":`, error);
      return false;
    }
  };

  // Match based on mode
  if (matchMode === 'all') {
    // ALL mode: Every pattern must match
    return patterns.every(testPattern);
  } else {
    // ANY mode: At least one pattern must match (default)
    return patterns.some(testPattern);
  }
}

/**
 * Process tabs through Smart Groups matching
 * Extracts tabs that match Smart Group patterns and adds them to their respective groups
 * @param {Array} tabs - Array of tab objects
 * @param {Function} callback - Callback with (remainingTabs, matchedTabsByGroup)
 */
function processTabsThroughSmartGroups(tabs, callback) {
  chrome.storage.local.get(['smartGroups'], (result) => {
    const smartGroups = result.smartGroups || [];

    if (smartGroups.length === 0) {
      // No Smart Groups defined, return all tabs as remaining
      callback(tabs, new Map());
      return;
    }

    // Sort Smart Groups by priority (lower number = higher priority)
    const sortedGroups = [...smartGroups].sort((a, b) => (a.priority || 0) - (b.priority || 0));

    const remainingTabs = [];
    const matchedTabsByGroup = new Map(); // Map<groupId, tabs[]>
    const matchedTabIndices = new Set(); // Track which tabs have been matched

    // Process each tab
    tabs.forEach((tab, index) => {
      let matched = false;

      // Check against each Smart Group in priority order
      for (const group of sortedGroups) {
        if (matchesSmartGroupPattern(tab, group)) {
          // First match wins
          if (!matchedTabsByGroup.has(group.id)) {
            matchedTabsByGroup.set(group.id, []);
          }
          matchedTabsByGroup.get(group.id).push(tab);
          matchedTabIndices.add(index);
          matched = true;
          debug(`[Smart Groups] Tab "${tab.title}" matched group "${group.name}"`);
          break;
        }
      }

      if (!matched) {
        remainingTabs.push(tab);
      }
    });

    // Update Smart Groups with new tabs
    if (matchedTabsByGroup.size > 0) {
      updateSmartGroupsWithTabs(matchedTabsByGroup, smartGroups, () => {
        callback(remainingTabs, matchedTabsByGroup);
      });
    } else {
      callback(remainingTabs, matchedTabsByGroup);
    }
  });
}

/**
 * Update sessions with tabs matched to Smart Groups
 * Creates or updates regular sessions in savedSessions with the Smart Group's name
 * OR sends tabs to trash if the Smart Group action is 'trash'
 * @param {Map} matchedTabsByGroup - Map of group IDs to arrays of matched tabs
 * @param {Array} smartGroups - Current Smart Groups array (for getting names)
 * @param {Function} callback - Callback when update is complete
 */
function updateSmartGroupsWithTabs(matchedTabsByGroup, smartGroups, callback) {
  // Get current sessions
  chrome.storage.local.get(['savedSessions'], (result) => {
    let sessions = result.savedSessions || [];

    // Base timestamp - add offset for each session to ensure uniqueness
    let timestampOffset = 0;
    // Track insertion position to maintain order (first processed = position 0, second = position 1, etc.)
    let insertPosition = 0;

    // Sort smart groups by priority to maintain consistent order
    const sortedGroups = [...smartGroups].sort((a, b) => (a.priority || 0) - (b.priority || 0));

    // For each Smart Group (in priority order), create/update session if it has matched tabs
    sortedGroups.forEach(group => {
      const newTabs = matchedTabsByGroup.get(group.id);
      if (!newTabs || newTabs.length === 0) return;

      // Check if this Smart Group has a trash action
      const action = group.action || {};
      if (action.primaryAction === 'trash') {
        // Send all matched tabs to trash in a single batch
        batchMoveToTrash(newTabs, group.name, new Date().toISOString());
        debug(`[Smart Groups] Sent ${newTabs.length} tabs to trash via group "${group.name}"`);
        return; // Skip session creation
      }

      // Determine session name from action or fallback to group name
      const sessionName = (action.primaryAction === 'tabGroup' && action.sessionName)
        ? action.sessionName
        : group.name;

      // Find existing session with this Smart Group's name
      const existingSession = sessions.find(s => s.customName === sessionName && s.smartGroupId === group.id);

      if (existingSession) {
        // Add new tabs to the beginning of existing session
        existingSession.tabs = [...newTabs, ...(existingSession.tabs || [])];
        existingSession.timestamp = new Date(Date.now() + timestampOffset++).toISOString();

        // Apply action properties to existing session (only if not already set by user)
        if (action.primaryAction === 'tabGroup' && action.sessionProperties) {
          action.sessionProperties.forEach(prop => {
            switch (prop.type) {
              case 'color':
                // Don't reset color - allow user's manual color override to persist
                if (!existingSession.color) {
                  existingSession.color = prop.value;
                }
                break;
              case 'lock':
                if (!existingSession.locked) {
                  existingSession.locked = true;
                }
                break;
              case 'pin':
                if (!existingSession.pinned) {
                  existingSession.pinned = true;
                  existingSession.pinnedAt = Date.now();
                }
                break;
            }
          });
        }

        // If Smart Group has autoPin enabled and session is not already pinned, pin it
        if (group.autoPin && !existingSession.pinned) {
          existingSession.pinned = true;
          existingSession.pinnedAt = Date.now();
          debug(`[Smart Groups] Auto-pinned existing session "${sessionName}"`);
        }

        debug(`[Smart Groups] Added ${newTabs.length} tabs to existing session "${sessionName}"`);
      } else {
        // Create new session for this Smart Group
        const newSession = {
          timestamp: new Date(Date.now() + timestampOffset++).toISOString(),
          customName: sessionName,
          tabs: newTabs,
          smartGroupId: group.id, // Track which Smart Group created this session
          locked: false,
          color: group.color || null
        };

        // Apply action properties to new session
        if (action.primaryAction === 'tabGroup' && action.sessionProperties) {
          action.sessionProperties.forEach(prop => {
            switch (prop.type) {
              case 'color':
                newSession.color = prop.value;
                break;
              case 'lock':
                newSession.locked = true;
                break;
              case 'pin':
                newSession.pinned = true;
                newSession.pinnedAt = Date.now();
                break;
            }
          });
        }

        // If Smart Group has autoPin enabled, pin the new session
        if (group.autoPin) {
          newSession.pinned = true;
          newSession.pinnedAt = Date.now();
          debug(`[Smart Groups] Auto-pinned new session "${sessionName}"`);
        }

        // Insert at specific position to maintain order (first processed = first in list)
        sessions.splice(insertPosition++, 0, newSession);
        debug(`[Smart Groups] Created new session "${sessionName}" with ${newTabs.length} tabs at position ${insertPosition - 1}`);
      }
    });

    // Save updated sessions
    chrome.storage.local.set({ savedSessions: sessions }, () => {
      if (chrome.runtime.lastError) {
        debug('[Smart Groups] Error updating sessions:', chrome.runtime.lastError);
      } else {
        debug(`[Smart Groups] Updated/created sessions for ${matchedTabsByGroup.size} group(s)`);
        // Sync: mark all affected sessions dirty
        sessions.forEach(s => {
          markSyncDirty('Session', 'session-' + s.timestamp, s);
        });
      }

      // Notify list.html to refresh if it's open
      chrome.tabs.query({}, (tabs) => {
        const listUrl = chrome.runtime.getURL('list.html');
        tabs.forEach(tab => {
          if (tab.url && tab.url.startsWith(listUrl)) {
            chrome.tabs.sendMessage(tab.id, {
              action: "refreshSessions"
            });
          }
        });
      });

      if (callback) callback();
    });
  });
}

/**
 * Run filters on existing sessions
 * Processes all unlocked sessions through Smart Groups filters
 * @param {Function} callback - Called with results object after completion
 */
function runFiltersOnExistingSessions(callback) {
  chrome.storage.local.get(['savedSessions', 'smartGroups'], (result) => {
    const allSessions = result.savedSessions || [];
    const smartGroups = result.smartGroups || [];

    if (smartGroups.length === 0) {
      if (callback) callback({ success: false, error: 'no-filters' });
      return;
    }

    // Filter to only unlocked sessions
    const unlocked = allSessions.filter(s => !s.locked);

    if (unlocked.length === 0) {
      if (callback) callback({ success: false, error: 'no-unlocked-sessions' });
      return;
    }

    // Get undo timeout setting
    chrome.storage.local.get(['undoTimeoutSec'], (timeoutResult) => {
      const undoTimeoutSec = timeoutResult.undoTimeoutSec || 5;
      const undoTimeoutMs = undoTimeoutSec * 1000;

      // Create snapshot for undo
      const undoSnapshot = {
        sessions: JSON.parse(JSON.stringify(allSessions)),
        timestamp: Date.now(),
        expiresAt: Date.now() + undoTimeoutMs
      };

    // Extract all tabs from unlocked sessions
    const allTabs = [];
    unlocked.forEach(session => {
      if (session.tabs && session.tabs.length > 0) {
        const sessionLabel = session.smartGroupId ? `Filter: ${session.customName}` : session.customName || 'Unnamed';
        debug(`[Run Filters] Extracting ${session.tabs.length} tabs from session: ${sessionLabel}`);
        allTabs.push(...session.tabs);
      }
    });

    const totalTabs = allTabs.length;
    const totalSessions = unlocked.length;
    debug(`[Run Filters] Starting: ${totalSessions} unlocked sessions, ${totalTabs} total tabs`);

    // Process tabs through filters (match only, don't update sessions yet)
    // Sort Smart Groups by priority (lower number = higher priority)
    const sortedGroups = [...smartGroups].sort((a, b) => (a.priority || 0) - (b.priority || 0));

    const remainingTabs = [];
    const matchedTabsByGroup = new Map(); // Map<groupId, tabs[]>

    // Process each tab
    allTabs.forEach((tab) => {
      let matched = false;

      // Check against each Smart Group in priority order
      for (const group of sortedGroups) {
        if (matchesSmartGroupPattern(tab, group)) {
          // First match wins
          if (!matchedTabsByGroup.has(group.id)) {
            matchedTabsByGroup.set(group.id, []);
          }
          matchedTabsByGroup.get(group.id).push(tab);
          matched = true;
          break;
        }
      }

      if (!matched) {
        remainingTabs.push(tab);
      }
    });

    // Now process the matches
    (() => {
      debug('[Run Filters] Total tabs processed:', allTabs.length);
      debug('[Run Filters] Matched groups:', matchedTabsByGroup.size);
      matchedTabsByGroup.forEach((tabs, groupId) => {
        debug(`[Run Filters] Group ${groupId}: ${tabs.length} tabs`);
      });

      // Remove matched tabs from original sessions, keeping unmatched ones
      const tabsToRemove = new Set();
      matchedTabsByGroup.forEach((tabs) => {
        tabs.forEach(tab => tabsToRemove.add(tab.url));
      });
      debug('[Run Filters] Tabs to remove from sessions:', tabsToRemove.size);

      let sessions = [...allSessions];
      let deletedCount = 0;

      // Update unlocked sessions by removing matched tabs
      sessions = sessions.map(session => {
        if (session.locked) return session; // Skip locked sessions

        const originalTabCount = session.tabs ? session.tabs.length : 0;
        const remainingSessionTabs = (session.tabs || []).filter(tab => !tabsToRemove.has(tab.url));

        if (remainingSessionTabs.length === 0) {
          // Session is now empty - mark for deletion
          deletedCount++;
          return null;
        } else if (remainingSessionTabs.length !== originalTabCount) {
          // Session has fewer tabs
          return { ...session, tabs: remainingSessionTabs };
        } else {
          // Session unchanged
          return session;
        }
      }).filter(s => s !== null); // Remove null entries (deleted sessions)

      // Now process filter sessions in the same way as normal save
      // Base timestamp - add offset for each session to ensure uniqueness
      let timestampOffset = 0;
      // Track insertion position to maintain order
      let insertPosition = 0;

      // Sort smart groups by priority to maintain consistent order
      const sortedGroups = [...smartGroups].sort((a, b) => (a.priority || 0) - (b.priority || 0));

      // For each Smart Group (in priority order), create/update session if it has matched tabs
      sortedGroups.forEach(group => {
        const newTabs = matchedTabsByGroup.get(group.id);
        if (!newTabs || newTabs.length === 0) return;

        // Check if this Smart Group has a trash action
        const action = group.action || {};
        if (action.primaryAction === 'trash') {
          // Send all matched tabs to trash in a single batch
          batchMoveToTrash(newTabs, group.name, new Date().toISOString());
          debug(`[Run Filters] Sent ${newTabs.length} tabs to trash via group "${group.name}"`);
          return; // Skip session creation
        }

        // Determine session name from action or fallback to group name
        const sessionName = (action.primaryAction === 'tabGroup' && action.sessionName)
          ? action.sessionName
          : group.name;

        // Find existing session with this Smart Group's name
        const existingSession = sessions.find(s => s.customName === sessionName && s.smartGroupId === group.id);

        if (existingSession) {
          // If session is locked, APPEND tabs (locked sessions weren't processed, so their tabs weren't extracted)
          // If session is unlocked, REPLACE tabs (unlocked sessions had their tabs extracted and re-matched)
          if (existingSession.locked) {
            // Append new tabs to the beginning of locked session, avoiding duplicates by URL
            const existingUrls = new Set((existingSession.tabs || []).map(t => t.url));
            const uniqueNewTabs = newTabs.filter(t => !existingUrls.has(t.url));
            debug(`[Run Filters] Appending ${uniqueNewTabs.length} new tabs to locked session "${sessionName}" (${newTabs.length - uniqueNewTabs.length} duplicates skipped)`);
            existingSession.tabs = [...uniqueNewTabs, ...(existingSession.tabs || [])];
          } else {
            debug(`[Run Filters] Replacing tabs in unlocked filter session "${sessionName}": ${existingSession.tabs.length} → ${newTabs.length} tabs`);
            existingSession.tabs = newTabs;
          }
          existingSession.timestamp = new Date(Date.now() + timestampOffset++).toISOString();

          // Apply action properties to existing session (only if not already set by user)
          if (action.primaryAction === 'tabGroup' && action.sessionProperties) {
            action.sessionProperties.forEach(prop => {
              switch (prop.type) {
                case 'color':
                  // Don't reset color - allow user's manual color override to persist
                  if (!existingSession.color) {
                    existingSession.color = prop.value;
                  }
                  break;
                case 'lock':
                  if (!existingSession.locked) {
                    existingSession.locked = true;
                  }
                  break;
                case 'pin':
                  if (!existingSession.pinned) {
                    existingSession.pinned = true;
                    existingSession.pinnedAt = Date.now();
                  }
                  break;
              }
            });
          }

          // If Smart Group has autoPin enabled and session is not already pinned, pin it
          if (group.autoPin && !existingSession.pinned) {
            existingSession.pinned = true;
            existingSession.pinnedAt = Date.now();
          }
        } else {
          // Create new session for this Smart Group
          const newSession = {
            timestamp: new Date(Date.now() + timestampOffset++).toISOString(),
            customName: sessionName,
            tabs: newTabs,
            smartGroupId: group.id,
            locked: false,
            color: group.color || null
          };

          // Apply action properties to new session
          if (action.primaryAction === 'tabGroup' && action.sessionProperties) {
            action.sessionProperties.forEach(prop => {
              switch (prop.type) {
                case 'color':
                  newSession.color = prop.value;
                  break;
                case 'lock':
                  newSession.locked = true;
                  break;
                case 'pin':
                  newSession.pinned = true;
                  newSession.pinnedAt = Date.now();
                  break;
              }
            });
          }

          // If Smart Group has autoPin enabled, pin the new session
          if (group.autoPin) {
            newSession.pinned = true;
            newSession.pinnedAt = Date.now();
          }

          // Insert at specific position to maintain order
          debug(`[Run Filters] Creating new filter session "${sessionName}" with ${newTabs.length} tabs at position ${insertPosition}`);
          sessions.splice(insertPosition++, 0, newSession);
        }
      });

      debug('[Run Filters] Final session count:', sessions.length);
      debug('[Run Filters] Deleted sessions:', deletedCount);

      // Save all sessions
      chrome.storage.local.set({ savedSessions: sessions }, () => {
        // Save undo snapshot
        chrome.storage.local.set({ undoRunFilters: undoSnapshot }, () => {
          const matchedCount = totalTabs - remainingTabs.length;

          // Notify list.html
          chrome.tabs.query({}, (tabs) => {
            const listUrl = chrome.runtime.getURL('list.html');
            tabs.forEach(tab => {
              if (tab.url && tab.url.startsWith(listUrl)) {
                chrome.tabs.sendMessage(tab.id, {
                  action: "runFiltersComplete",
                  stats: {
                    totalSessions,
                    totalTabs,
                    matchedCount,
                    deletedCount
                  }
                });
              }
            });
          });

          if (callback) {
            callback({
              success: true,
              stats: {
                totalSessions,
                totalTabs,
                matchedCount,
                deletedCount
              }
            });
          }
        });
      });
    })();
    });
  });
}

// =============================
// Move/Copy Search Results
// =============================

/**
 * Move search results to a new session
 * Removes tabs from their original sessions and creates a new session
 */
async function moveSearchResultsToNewSession(searchResults, sessionTitle) {
  return new Promise((resolve) => {
    chrome.storage.local.get(['savedSessions'], (result) => {
      let sessions = result.savedSessions || [];
      const tabsToMove = [];
      const sessionsToDelete = new Set();

      // Group results by session and collect tabs
      const resultsBySession = new Map();
      searchResults.forEach(searchResult => {
        // Skip if from locked session
        const session = sessions[searchResult.sessionIndex];
        if (session && session.locked) {
          return;
        }

        if (!resultsBySession.has(searchResult.sessionIndex)) {
          resultsBySession.set(searchResult.sessionIndex, []);
        }
        resultsBySession.get(searchResult.sessionIndex).push(searchResult);
        tabsToMove.push({
          title: searchResult.title,
          url: searchResult.url,
          favicon: searchResult.favicon
        });
      });

      // Remove tabs from their original sessions (in reverse order to maintain indices)
      resultsBySession.forEach((results, sessionIndex) => {
        const session = sessions[sessionIndex];
        if (!session) return;

        // Sort by tabIndex descending to remove from end first
        const sortedResults = results.sort((a, b) => b.tabIndex - a.tabIndex);

        sortedResults.forEach(result => {
          session.tabs.splice(result.tabIndex, 1);
        });

        // Mark session for deletion if empty
        if (session.tabs.length === 0) {
          sessionsToDelete.add(sessionIndex);
        }
      });

      // Remove empty sessions (in reverse order)
      Array.from(sessionsToDelete).sort((a, b) => b - a).forEach(index => {
        sessions.splice(index, 1);
      });

      // Create new session with moved tabs
      if (tabsToMove.length > 0) {
        const now = new Date();
        const defaultTitle = buildDefaultSessionTitle();

        const newSession = {
          timestamp: now.toISOString(),
          defaultTitle: defaultTitle,
          title: sessionTitle || defaultTitle,
          customName: sessionTitle || "",
          tabs: tabsToMove,
          pendingTitle: false,
          pendingCategorization: false
        };

        sessions.unshift(newSession);

        // Save updated sessions
        chrome.storage.local.set({ savedSessions: sessions }, () => {
          debug('Moved', tabsToMove.length, 'tabs to new session');
          resolve({
            success: true,
            movedCount: tabsToMove.length,
            deletedEmptySessions: sessionsToDelete.size,
            newSessionTimestamp: newSession.timestamp
          });
        });
      } else {
        resolve({
          success: false,
          error: "No unlocked tabs to move"
        });
      }
    });
  });
}


// =============================
// Debug Logging Helper
// =============================

let DEBUG_MODE = false;
let PREFERRED_LANGUAGE = null;
let LOCALE_MESSAGES = {}; // Cache for loaded locale messages

// Load debug mode and language settings on startup
chrome.storage.local.get(['debugMode', 'preferredLanguage'], (result) => {
  DEBUG_MODE = !!result.debugMode;
  PREFERRED_LANGUAGE = result.preferredLanguage || null;
  // Load locale messages when language is set
  if (PREFERRED_LANGUAGE && PREFERRED_LANGUAGE !== 'auto') {
    loadLocaleMessages(PREFERRED_LANGUAGE);
  }
});

// Listen for setting changes
chrome.storage.onChanged.addListener((changes) => {
  if (changes.debugMode) {
    DEBUG_MODE = !!changes.debugMode.newValue;
    console.log('[Tabstract] Debug mode:', DEBUG_MODE ? 'enabled' : 'disabled');
  }
  if (changes.preferredLanguage) {
    PREFERRED_LANGUAGE = changes.preferredLanguage.newValue || null;
    debug('[Tabstract] Language preference changed to:', PREFERRED_LANGUAGE);
    // Reload locale messages when language changes
    if (PREFERRED_LANGUAGE && PREFERRED_LANGUAGE !== 'auto') {
      loadLocaleMessages(PREFERRED_LANGUAGE);
    } else {
      LOCALE_MESSAGES = {}; // Clear cache if set to auto
    }
  }
});

/**
 * Serialize a value with object keys in sorted order.
 *
 * JSON.stringify emits keys in insertion order, so two records holding identical
 * data produce different text if their keys were assigned in a different order.
 * Records that round-trip through sync are rebuilt as { ...payload, _syncModifiedAt }
 * and come back with a different key order than the locally-created originals, so a
 * plain JSON.stringify comparison reports every record as changed.
 *
 * Confirmed 2026-08-21: deleting one session marked all 101 untouched trashed links
 * dirty (0 recognised as unchanged) and pushed 107 records instead of 6. Array order
 * is preserved — it is meaningful — only object keys are sorted.
 */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(v => {
      const s = stableStringify(v);
      return s === undefined ? 'null' : s;
    }).join(',') + ']';
  }
  const parts = [];
  for (const key of Object.keys(value).sort()) {
    const s = stableStringify(value[key]);
    if (s !== undefined) parts.push(JSON.stringify(key) + ':' + s);
  }
  return '{' + parts.join(',') + '}';
}

// Sync: detect storage changes to synced keys (catches edits from list.js)
// No blanket _syncMergeInProgress guard here — per-record _syncMergedRecordNames
// checks inside each loop skip records from the current merge while allowing
// legitimate user edits to non-merged records through.
chrome.storage.onChanged.addListener((changes) => {
  // Detect template changes
  if (changes.savedTemplates && changes.savedTemplates.newValue) {
    const oldTemplates = changes.savedTemplates.oldValue || [];
    const newTemplates = changes.savedTemplates.newValue || [];
    for (const t of newTemplates) {
      if (classifyRecord(t.id, t) !== 'Template') continue;
      if (_syncMergedRecordNames.has(t.id)) continue;
      const old = oldTemplates.find(o => o.id === t.id);
      if (!old || stableStringify(old) !== stableStringify(t)) {
        markSyncDirty('Template', t.id, t);
      }
    }
    for (const o of oldTemplates) {
      if (classifyRecord(o.id, o) !== 'Template') continue;
      if (_syncMergedRecordNames.has(o.id)) continue;
      if (!newTemplates.find(t => t.id === o.id)) {
        markSyncDeleted('Template', o.id);
      }
    }
  }

  // Detect smart group changes
  if (changes.smartGroups && changes.smartGroups.newValue) {
    const oldGroups = changes.smartGroups.oldValue || [];
    const newGroups = changes.smartGroups.newValue || [];
    for (const g of newGroups) {
      if (classifyRecord('smartgroup-' + g.id, g) !== 'SmartGroup') continue;
      if (_syncMergedRecordNames.has('smartgroup-' + g.id)) continue;
      const old = oldGroups.find(o => o.id === g.id);
      if (!old || stableStringify(old) !== stableStringify(g)) {
        markSyncDirty('SmartGroup', 'smartgroup-' + g.id, g);
      }
    }
    for (const o of oldGroups) {
      if (classifyRecord('smartgroup-' + o.id, o) !== 'SmartGroup') continue;
      if (_syncMergedRecordNames.has('smartgroup-' + o.id)) continue;
      if (!newGroups.find(g => g.id === o.id)) {
        markSyncDeleted('SmartGroup', 'smartgroup-' + o.id);
      }
    }
  }

  // Detect session edits from list.js (rename, color, pin, lock, etc.)
  if (changes.savedSessions && changes.savedSessions.newValue) {
    const oldSessions = changes.savedSessions.oldValue || [];
    const newSessions = changes.savedSessions.newValue || [];
    for (const s of newSessions) {
      if (classifyRecord('session-' + s.timestamp, s) !== 'Session') continue;
      if (_syncMergedRecordNames.has('session-' + s.timestamp)) continue;
      const old = oldSessions.find(o => o.timestamp === s.timestamp);
      if (!old || stableStringify(old) !== stableStringify(s)) {
        markSyncDirty('Session', 'session-' + s.timestamp, s);
      }
    }
    for (const o of oldSessions) {
      if (classifyRecord('session-' + o.timestamp, o) !== 'Session') continue;
      if (_syncMergedRecordNames.has('session-' + o.timestamp)) continue;
      if (!newSessions.find(s => s.timestamp === o.timestamp)) {
        markSyncDeleted('Session', 'session-' + o.timestamp);
      }
    }
  }

  // Detect trashed link changes
  if (changes.trashedLinks && changes.trashedLinks.newValue) {
    const oldLinks = changes.trashedLinks.oldValue || [];
    const newLinks = changes.trashedLinks.newValue || [];
    for (const l of newLinks) {
      if (classifyRecord('trash-' + l.id, l) !== 'TrashedLink') continue;
      if (_syncMergedRecordNames.has('trash-' + l.id)) continue;
      const old = oldLinks.find(o => o.id === l.id);
      if (!old || stableStringify(old) !== stableStringify(l)) {
        markSyncDirty('TrashedLink', 'trash-' + l.id, l);
      }
    }
    for (const o of oldLinks) {
      if (classifyRecord('trash-' + o.id, o) !== 'TrashedLink') continue;
      if (_syncMergedRecordNames.has('trash-' + o.id)) continue;
      if (!newLinks.find(l => l.id === o.id)) {
        markSyncDeleted('TrashedLink', 'trash-' + o.id);
      }
    }
  }
});

// Ring buffer of recent sync log lines, kept regardless of DEBUG_MODE so a
// tester can send diagnostics without enabling debug mode. In memory only.
const SYNC_LOG_RING_MAX = 200;
const _syncLogRing = [];

// Debug logging function
function debug(...args) {
  if (typeof args[0] === 'string' && args[0].startsWith('[Sync]')) {
    const line = new Date().toISOString() + ' ' + args.map(a =>
      typeof a === 'string' ? a : JSON.stringify(a)
    ).join(' ');
    _syncLogRing.push(line);
    if (_syncLogRing.length > SYNC_LOG_RING_MAX) _syncLogRing.shift();
  }
  if (DEBUG_MODE) {
    console.log('[Tabstract]', ...args);
    nativeDebugLog('log', 'background', args.map(a =>
      typeof a === 'string' ? a : JSON.stringify(a)
    ).join(' '));
  }
}

// Debug logging with message forwarding to list.html
function debugWithMessage(message, data) {
  if (!DEBUG_MODE) return;

  console.log(`[Tabstract BG] ${message}:`, data);
  nativeDebugLog('log', 'background', `${message}: ${JSON.stringify(data)}`);

  // Send debug info to list.html for visibility
  chrome.tabs.query({ url: chrome.runtime.getURL("list.html") }, (tabs) => {
    tabs.forEach(tab => {
      chrome.tabs.sendMessage(tab.id, {
        action: "debugLog",
        source: "background",
        message: message,
        data: data
      });
    });
  });
}

// Always log to list.html console (for troubleshooting)
function logToListConsole(message, data) {
  console.log(`[Tabstract BG] ${message}:`, data);

  // Send debug info to list.html for visibility
  chrome.tabs.query({ url: chrome.runtime.getURL("list.html") }, (tabs) => {
    tabs.forEach(tab => {
      chrome.tabs.sendMessage(tab.id, {
        action: "debugLog",
        source: "background",
        message: message,
        data: data
      });
    });
  });
}

// =============================
// Native Debug Logging Bridge
// =============================

// Send a debug log to the native Swift handler for file output
function nativeDebugLog(level, source, message) {
  if (!DEBUG_MODE) return;
  try {
    browser.runtime.sendNativeMessage("application.id", {
      action: "debugLog",
      level: level,
      source: source,
      message: String(message).substring(0, 10000) // Cap message size
    }).catch(() => {}); // Fire-and-forget, ignore errors
  } catch (e) {
    // Silently ignore — native messaging may not be available
  }
}

// Intercept console.error and console.warn in service worker to capture unexpected errors
const _originalConsoleError = console.error;
const _originalConsoleWarn = console.warn;

console.error = function(...args) {
  _originalConsoleError.apply(console, args);
  if (DEBUG_MODE) {
    nativeDebugLog('error', 'background', args.map(a =>
      typeof a === 'string' ? a : (a instanceof Error ? `${a.message}\n${a.stack}` : JSON.stringify(a))
    ).join(' '));
  }
};

console.warn = function(...args) {
  _originalConsoleWarn.apply(console, args);
  if (DEBUG_MODE) {
    nativeDebugLog('warn', 'background', args.map(a =>
      typeof a === 'string' ? a : JSON.stringify(a)
    ).join(' '));
  }
};

// Get the effective language (from storage or browser default)
function getEffectiveLanguage() {
  // Try reading from storage synchronously (cached value)
  const lang = PREFERRED_LANGUAGE && PREFERRED_LANGUAGE !== 'auto'
    ? PREFERRED_LANGUAGE
    : (chrome.i18n.getUILanguage() || 'en');

  debug('[Tabstract BG] getEffectiveLanguage:', {
    PREFERRED_LANGUAGE,
    uiLanguage: chrome.i18n.getUILanguage(),
    returning: lang
  });

  return lang;
}

// Expose debug controls to console (using self for service worker context)
self.Tabstract = {
  enableDebug: () => {
    chrome.storage.local.set({ debugMode: true });
    console.log('[Tabstract] Debug mode enabled');
  },
  disableDebug: () => {
    chrome.storage.local.set({ debugMode: false });
    console.log('[Tabstract] Debug mode disabled');
  },
  getDebugStatus: () => {
    chrome.storage.local.get(['debugMode'], (result) => {
      console.log('[Tabstract] Debug mode:', !!result.debugMode ? 'enabled' : 'disabled');
    });
  }
};

// =============================
// Trash System Helper Functions
// =============================

/**
 * Generate a unique ID for a link being moved to trash
 */
function generateLinkId(sessionTimestamp, url) {
  const urlHash = url.substring(0, 20).replace(/[^a-zA-Z0-9]/g, '');
  const randomId = Math.random().toString(36).substring(2, 8);
  return `${sessionTimestamp}-${urlHash}-${randomId}`;
}

/**
 * Move a link to the trash
 */
function moveToTrash(link, sessionName, sessionTimestamp) {
  const now = Date.now();
  const retentionMs = 30 * 24 * 60 * 60 * 1000; // 30 days in milliseconds

  const trashedLink = {
    id: generateLinkId(sessionTimestamp, link.url),
    url: link.url,
    title: link.title,
    originalSessionName: sessionName,
    trashedAt: now,
    expiresAt: now + retentionMs
  };
  // Record original saved time if available
  if (sessionTimestamp) {
    const parsed = Date.parse(sessionTimestamp);
    if (!isNaN(parsed)) trashedLink.originalSavedAt = parsed;
  }


  chrome.storage.local.get(['trashedLinks'], (result) => {
    let trashedLinks = result.trashedLinks || [];
    trashedLinks.push(trashedLink);

    // Enforce size limits
    trashedLinks = enforceTrashLimits(trashedLinks);

    chrome.storage.local.set({ trashedLinks }, () => {
      // Sync: mark trashed link dirty
      markSyncDirty('TrashedLink', 'trash-' + trashedLink.id, trashedLink);
      // Notify any open list.html tabs about the trash update
      updateListHtmlTrash(trashedLinks);
    });
  });
}

/**
 * Batch-move multiple tabs to trash in a single read-modify-write.
 * Avoids the race condition where concurrent moveToTrash calls overwrite each other.
 */
function batchMoveToTrash(tabs, sessionName, sessionTimestamp) {
  if (!tabs || tabs.length === 0) return;
  const now = Date.now();
  const retentionMs = 30 * 24 * 60 * 60 * 1000;
  const newTrashLinks = [];
  for (const tab of tabs) {
    const trashedLink = {
      id: generateLinkId(sessionTimestamp, tab.url),
      url: tab.url,
      title: tab.title,
      originalSessionName: sessionName,
      trashedAt: now,
      expiresAt: now + retentionMs
    };
    if (sessionTimestamp) {
      const parsed = Date.parse(sessionTimestamp);
      if (!isNaN(parsed)) trashedLink.originalSavedAt = parsed;
    }
    newTrashLinks.push(trashedLink);
  }
  chrome.storage.local.get(['trashedLinks'], (result) => {
    let trashedLinks = result.trashedLinks || [];
    trashedLinks.push(...newTrashLinks);
    trashedLinks = enforceTrashLimits(trashedLinks);
    chrome.storage.local.set({ trashedLinks }, () => {
      for (const link of newTrashLinks) {
        markSyncDirty('TrashedLink', 'trash-' + link.id, link);
      }
      updateListHtmlTrash(trashedLinks);
    });
  });
}

/**
 * Enforce trash size limits using LRU eviction
 */
function enforceTrashLimits(trashedLinks) {
  if (trashedLinks.length <= 1000) return trashedLinks;

  // Sort by trashedAt timestamp (oldest first)
  trashedLinks.sort((a, b) => a.trashedAt - b.trashedAt);

  // Keep only the most recent 1000 items
  return trashedLinks.slice(-1000);
}

/**
 * Clean up expired trash items
 */
function cleanupExpiredTrash() {
  chrome.storage.local.get(['trashedLinks'], (result) => {
    let trashedLinks = result.trashedLinks || [];
    const now = Date.now();
    const initialCount = trashedLinks.length;

    // Remove expired items
    trashedLinks = trashedLinks.filter(link => now < link.expiresAt);

    // Enforce size limits after expiry cleanup
    trashedLinks = enforceTrashLimits(trashedLinks);

    if (trashedLinks.length !== initialCount) {
      chrome.storage.local.set({ trashedLinks }, () => {
        const removedCount = initialCount - trashedLinks.length;
        // Notify any open list.html tabs about the trash update
        updateListHtmlTrash(trashedLinks);
      });
    }
  });
}

/**
 * Update all open list.html tabs with the latest trash data
 */
function updateListHtmlTrash(trashedLinks) {
  chrome.tabs.query({ url: chrome.runtime.getURL("list.html") }, (tabs) => {
    tabs.forEach(t => {
      chrome.tabs.sendMessage(t.id, {
        action: "updateTrash",
        trashedLinks: trashedLinks
      });
    });
  });
}

/**
 * Ensure that any keys missing in local storage are set to defaults.
 */
function ensureDefaultSettings(callback) {
  chrome.storage.local.get([...Object.keys(DEFAULT_SETTINGS), 'savedSessions'], (res) => {
    const toSet = {};
    for (const [key, defaultVal] of Object.entries(DEFAULT_SETTINGS)) {
      if (res[key] === undefined) {
        toSet[key] = defaultVal;
      }
    }

    // Set install date on first run or if legacy value was 0
    if (res.installDate === undefined || res.installDate === 0) {
      toSet.installDate = Date.now();
    }

    // Validate totalSessionsSaved against actual saved sessions count
    const savedSessions = res.savedSessions || [];
    const actualSessionCount = savedSessions.length;
    const storedSessionCount = res.totalSessionsSaved || 0;

    if (storedSessionCount < actualSessionCount) {
      toSet.totalSessionsSaved = actualSessionCount;
    }

    if (Object.keys(toSet).length > 0) {
      chrome.storage.local.set(toSet, () => {
        // Sync darkMode to localStorage for instant access
        if (toSet.darkMode !== undefined) {
          // Note: localStorage is not directly accessible in background scripts (service workers)
          // but this will be synced when the user first opens any extension page
        }
        if (typeof callback === "function") callback();
      });
    } else {
      if (typeof callback === "function") callback();
    }
  });
}

// On install/update or browser startup, ensure defaults are set
chrome.runtime.onInstalled.addListener(() => {
  ensureDefaultSettings(() => {
    initializeBadge();
    wireBadgeReactivity();
    primeUnsnoozeAlarm();
    scheduleTrashCleanup();
    scheduleBackupAlarm();
    initSyncOnStartup();
    updateBadge();
    // Clean up any stuck AI sessions shortly after install/update
    setTimeout(() => cleanupStuckCategorization(120000), 5000);
    // Clean up stale tracking keys from removed pin/recovery feature
    chrome.storage.local.remove(['_extensionTabActive', '_extensionTabPinned', '_extensionTabCount', '_extensionTabIds']);
  });
});
chrome.runtime.onStartup.addListener(() => {
  debug('[Tabstract BG] chrome.runtime.onStartup fired');
  ensureDefaultSettings(() => {
    debug('[Tabstract BG] ensureDefaultSettings complete');
    initializeBadge();
    wireBadgeReactivity();
    primeUnsnoozeAlarm();
    scheduleTrashCleanup();
    scheduleBackupAlarm();
    initSyncOnStartup();
    updateBadge();
    // Periodic cleanup for stuck AI runs
    setTimeout(() => cleanupStuckCategorization(120000), 8000);
    try { setInterval(() => cleanupStuckCategorization(120000), 60000); } catch (e) {}
    // Save all open tabs at startup if enabled (once per browser session)
    chrome.storage.local.get(['saveTabsOnStartup'], (res) => {
      debug(`[Tabstract BG] saveTabsOnStartup setting: ${res.saveTabsOnStartup}`);
      if (res.saveTabsOnStartup) {
        debug('[Tabstract BG] Calling performStartupSaveOnce');
        performStartupSaveOnce();
      } else {
        debug('[Tabstract BG] saveTabsOnStartup is disabled, skipping');
      }
    });
    // Launch Tabstract at browser startup if user enabled it
    chrome.storage.local.get(['launchOnStartup'], (res) => {
      if (res.launchOnStartup && !startupLaunchFired) {
        // Mark first to avoid any race with fallbacks
        markStartupLaunched(() => {
          openOnStartup();
          removeStartupFallbacks();
        });
      }
    });
    // Template schedules are handled by the interval-based checker (startTemplateScheduleChecker)
  });
});

// Register alarm/badge listeners on every service worker evaluation, not just from
// onInstalled/onStartup. Safari suspends the service worker mid-session, and a wake
// caused by an alarm firing does not re-fire onStartup — so without this the
// onAlarm listener is absent exactly when an alarm needs it and the backup is
// dropped. wireBadgeReactivity is idempotent.
wireBadgeReactivity();

// Re-register the hourly backup alarm on every service worker wake.
// onInstalled/onStartup only fire once; Safari may drop alarms when the
// service worker is terminated, so we check on every wake and recreate if missing.
ensureBackupAlarm();

// Helper function for processing pasted sessions with Smart Groups
function processPastedSessionWithSmartGroups(timestamp, originalTabs, remainingTabs, matchedTabsByGroup, aiTitleEnabled, aiCategorizationEnabled) {
  // Log Smart Groups matching results
  if (matchedTabsByGroup.size > 0) {
    let totalMatched = 0;
    matchedTabsByGroup.forEach(tabs => totalMatched += tabs.length);
    debug(`[Smart Groups] Matched ${totalMatched} pasted tabs across ${matchedTabsByGroup.size} group(s)`);
    debug(`[Smart Groups] Continuing with ${remainingTabs.length} unmatched pasted tabs`);
  }

  // If all tabs were matched to Smart Groups, delete the pasted session
  if (remainingTabs.length === 0) {
    debug('[Smart Groups] All pasted tabs matched to Smart Groups, deleting pasted session');
    chrome.storage.local.get(["savedSessions"], (result) => {
      const sessions = (result.savedSessions || []).filter(s => s.timestamp !== timestamp);
      chrome.storage.local.set({ savedSessions: sessions }, () => {
        updateListHtmlTabs(sessions);
        refreshBadge();
      });
    });
    return;
  }

  // Update the pasted session to only include remaining tabs
  if (matchedTabsByGroup.size > 0) {
    chrome.storage.local.get(["savedSessions"], (result) => {
      const sessions = result.savedSessions || [];
      const sessionIndex = sessions.findIndex(s => s.timestamp === timestamp);
      if (sessionIndex !== -1) {
        sessions[sessionIndex].tabs = remainingTabs;
        chrome.storage.local.set({ savedSessions: sessions }, () => {
          updateListHtmlTabs(sessions);
        });
      }
    });
  }

  // Continue with remaining tabs through AI processing
  const hasEnoughTabsForCategorization = remainingTabs.length >= 6;
  const hasAnyTabs = remainingTabs.length > 0;
  const wantsCategorize = aiCategorizationEnabled && hasEnoughTabsForCategorization;
  const wantsTitle = aiTitleEnabled && hasAnyTabs && !wantsCategorize;
  const aiOperational = lastKnownAIAvailability !== false;
  const shouldCategorize = aiOperational && wantsCategorize;
  const shouldGenerateTitle = aiOperational && wantsTitle;

  // Both categorization and title generation work with URLs/domains, so proceed immediately
  if (shouldCategorize) {
    // Guard: prevent duplicate concurrent calls
    if (activeCategorizationTimestamps.has(timestamp)) {
      debugWithMessage(`Categorization already in progress for ${timestamp}, ignoring duplicate`);
    } else {
      activeCategorizationTimestamps.add(timestamp);
      categorizationInBackground(timestamp, remainingTabs);
    }
  } else if (shouldGenerateTitle) {
    // Guard: prevent duplicate concurrent calls
    if (activeTitleTimestamps.has(timestamp)) {
      debugWithMessage(`Title generation already in progress for ${timestamp}, ignoring duplicate`);
    } else {
      activeTitleTimestamps.add(timestamp);
      generateAITitleInBackground(timestamp, remainingTabs);
    }
  }
}

// Actions that write to synced storage keys and should be deferred during merge
const SYNC_GATED_ACTIONS = new Set([
  'deleteSession', 'undoDeleteSession', 'restoreSessionFromTrash',
  'restoreTabFromTrash', 'restoreFromTrash', 'permanentlyDeleteFromTrash',
  'emptyTrash', 'moveSessionToTrash', 'openSingleTab', 'reopenTabs',
  'runFiltersOnSessions'
]);

function handleRuntimeMessage(message, sender, sendResponse) {
  // Gate synced-key writes during merge to prevent data loss
  if (_syncMergeInProgress && SYNC_GATED_ACTIONS.has(message.action)) {
    _syncDeferredWrites.push(() => {
      // Replay after the merge completes by calling this handler directly.
      // A page never receives its own runtime.sendMessage (verified in
      // Safari 2026-09-28), so re-sending the message would drop the action.
      handleRuntimeMessage(message, sender, () => {});
    });
    sendResponse({ success: true, deferred: true });
    return false;
  }

  if (message.action === "requestSnapshot") {
    // Request a debug snapshot from a specific extension page (debug only)
    if (!DEBUG_MODE) return false;
    const target = message.source; // "list", "popup", "settings"
    const targetUrl = chrome.runtime.getURL(target + ".html");
    chrome.tabs.query({ url: targetUrl }, (tabs) => {
      tabs.forEach(tab => {
        chrome.tabs.sendMessage(tab.id, { action: "captureDebugSnapshot" });
      });
    });
    return false;
  } else if (message.action === "ensureDefaultSettings") {
    ensureDefaultSettings(() => {
      if (typeof sendResponse === "function") {
        sendResponse({ success: true });
      }
    });
    return true;
  } else if (message.action === "pageMetadata") {
    // Cache metadata proactively sent from content scripts
    const { url, metadata } = message;
    if (url && metadata && metadata.ogDescription) {
      const cacheEntry = {
        ogDescription: metadata.ogDescription,
        timestamp: Date.now()
      };
      pageMetadataCache.set(url, cacheEntry);

      // Persist to storage (debounced via simple check)
      persistMetadataCache();
    }
    return false; // No response needed
  } else if (message.action === "checkAIStatus") {
    browser.runtime.sendNativeMessage("application.id", { action: "checkAvailability" })
      .then((response) => {
        const available = response?.available === true;
        const supported = response?.supported !== false;
        const reason = response?.reason || null;

        lastKnownAIAvailability = available;
        lastAICheckDetails = {
          available,
          supported,
          reason,
          response
        };

        if (!available) {
          clearAllPendingAIWork('ai-unavailable');
        }

        sendResponse({
          available,
          supported,
          reason
        });
      })
      .catch((error) => {
        const reason = String(error);
        lastKnownAIAvailability = false;
        lastAICheckDetails = {
          available: false,
          supported: null,
          reason
        };
        clearAllPendingAIWork('ai-unavailable');
        sendResponse({
          available: false,
          supported: null,
          reason
        });
      });
    return true;
  } else if (message.action === "cancelCategorization") {
    // Manual cancel from UI: remove pending flag
    const { timestamp } = message;
    if (!timestamp) return;
    chrome.storage.local.get(["savedSessions"], (result) => {
      let sessions = result.savedSessions || [];
      const s = sessions.find(x => x.timestamp === timestamp);
      if (s && s.pendingCategorization) {
        delete s.pendingCategorization;
        delete s.pendingCategorizationStartedAt;
        chrome.storage.local.set({ savedSessions: sessions }, () => {
          // Refresh UI
          chrome.tabs.query({ url: chrome.runtime.getURL("list.html") }, (tabs) => {
            tabs.forEach(tab => chrome.tabs.sendMessage(tab.id, { action: "refreshSessions" }));
          });
        });
      }
    });
    return true;

  } else if (message.action === "createManualBackup") {
    createBackup('manual', message.label || null, (success, filename) => {
      sendResponse({ success, filename });
    });
    return true;

  } else if (message.action === "createPreRestoreBackup") {
    createBackup('pre-restore', null, (success, filename) => {
      sendResponse({ success, filename });
    });
    return true;

  } else if (message.action === "listBackups") {
    browser.runtime.sendNativeMessage("application.id", { action: "listBackups" })
      .then((response) => sendResponse(response))
      .catch((error) => sendResponse({ success: false, error: String(error) }));
    return true;

  } else if (message.action === "readBackup") {
    browser.runtime.sendNativeMessage("application.id", { action: "readBackup", filename: message.filename })
      .then((response) => sendResponse(response))
      .catch((error) => sendResponse({ success: false, error: String(error) }));
    return true;

  } else if (message.action === "showBackupInFinder") {
    browser.runtime.sendNativeMessage("application.id", { action: "showBackupInFinder", filename: message.filename })
      .then((response) => sendResponse(response))
      .catch((error) => sendResponse({ success: false, error: String(error) }));
    return true;

  } else if (message.action === "deleteBackup") {
    browser.runtime.sendNativeMessage("application.id", { action: "deleteBackup", filename: message.filename })
      .then((response) => sendResponse(response))
      .catch((error) => sendResponse({ success: false, error: String(error) }));
    return true;

  } else if (message.action === "restoreFromBackup") {
    const { backupData, mode } = message;
    if (!backupData) {
      sendResponse({ success: false, error: "No backup data provided" });
      return true;
    }
    // Create a pre-restore backup first
    createBackup('pre-restore', null, (success) => {
      if (!success) {
        sendResponse({ success: false, error: "Failed to create pre-restore backup" });
        return;
      }
      if (mode === 'tabsMerge') {
        // Merge: append backup sessions to existing ones
        chrome.storage.local.get(['savedSessions'], (result) => {
          const existing = result.savedSessions || [];
          const incoming = (backupData.savedSessions || []).map(session => {
            const copy = Object.assign({}, session);
            const name = copy.customName || copy.defaultTitle || '';
            copy.customName = name ? name + ' (Restored)' : '(Restored)';
            return copy;
          });
          const merged = existing.concat(incoming);
          chrome.storage.local.set({ savedSessions: merged }, () => {
            sendResponse({ success: true });
          });
        });
      } else if (mode === 'tabsOnly') {
        // Only restore saved sessions
        chrome.storage.local.set({ savedSessions: backupData.savedSessions || [] }, () => {
          sendResponse({ success: true });
        });
      } else {
        // Restore everything — set backup data first, then remove stale keys
        chrome.storage.local.get(null, (currentData) => {
          const keysToRemove = Object.keys(currentData).filter(k => !(k in backupData));
          chrome.storage.local.set(backupData, () => {
            if (keysToRemove.length > 0) {
              chrome.storage.local.remove(keysToRemove, () => {
                sendResponse({ success: true });
              });
            } else {
              sendResponse({ success: true });
            }
          });
        });
      }
    });
    return true;

  } else if (message.action === "enableSync") {
    browser.runtime.sendNativeMessage("application.id", { action: "syncEnable" })
      .then((response) => {
        if (response && response.success) {
          chrome.storage.local.set({
            icloudSyncEnabled: true,
            icloudSyncDeviceID: response.deviceID
          }, () => {
            scheduleSyncAlarm();
            // Respond immediately so the UI doesn't hang on "Connecting..."
            // The push/pull chain runs in the background.
            sendResponse({ success: true, deviceID: response.deviceID });
            debug('[Sync] enableSync: starting background chain (stamp → push → pull)');
            stampAllLocalRecords(() => {
              performFullPush(() => {
                executeSyncPull();
              });
            });
          });
        } else {
          sendResponse({ success: false, error: response?.error || 'unknown' });
        }
      })
      .catch((error) => {
        sendResponse({ success: false, error: String(error) });
      });
    return true;

  } else if (message.action === "disableSync") {
    browser.runtime.sendNativeMessage("application.id", { action: "syncDisable" })
      .then(() => {
        chrome.storage.local.set({
          icloudSyncEnabled: false,
          icloudSyncLastTime: null,
          icloudSyncDeviceID: null
        }, () => {
          clearSyncAlarm();
          _syncDirtyRecords.clear();
          if (_syncPushTimeout) { clearTimeout(_syncPushTimeout); _syncPushTimeout = null; }
          sendResponse({ success: true });
        });
      })
      .catch((error) => {
        sendResponse({ success: false, error: String(error) });
      });
    return true;

  } else if (message.action === "getSyncStatus") {
    browser.runtime.sendNativeMessage("application.id", { action: "syncStatus" })
      .then((response) => sendResponse(response))
      .catch((error) => sendResponse({ success: false, error: String(error) }));
    return true;

  } else if (message.action === "getSyncDiagnostics") {
    // Plain-text report a tester can paste into an email. No debug mode needed.
    chrome.storage.local.get(['savedSessions', 'savedTemplates', 'smartGroups', 'trashedLinks',
      'icloudSyncEnabled', 'icloudSyncDeviceID', 'icloudSyncLastTime', '_syncDirtyRecords'], (data) => {
      browser.runtime.sendNativeMessage("application.id", { action: "syncStatus" })
        .catch((error) => ({ error: String(error) }))
        .then((status) => {
          const manifest = chrome.runtime.getManifest();
          const lines = [
            'Tabstract sync diagnostics',
            'Generated: ' + new Date().toISOString(),
            'Version: ' + manifest.version,
            'Platform: ' + (message.platform || navigator.platform),
            'User agent: ' + navigator.userAgent,
            '',
            'Sync enabled: ' + !!data.icloudSyncEnabled,
            'Device ID: ' + (data.icloudSyncDeviceID || 'none'),
            'Last sync (JS): ' + (data.icloudSyncLastTime || 'never'),
            'Last sync (native): ' + (status && status.lastSyncTime || 'never'),
            'Account status: ' + (status && status.accountStatus || 'unknown'),
            'Last error: ' + (status && (status.lastError || status.error) || 'none'),
            '',
            'Groups: ' + (data.savedSessions || []).length,
            'Routines: ' + (data.savedTemplates || []).length,
            'Filters: ' + (data.smartGroups || []).length,
            'Trash: ' + (data.trashedLinks || []).length,
            'Pending (persisted): ' + Object.keys(data._syncDirtyRecords || {}).length,
            'Pending (memory): ' + _syncDirtyRecords.size,
            'In flight: ' + _syncInFlightRecordNames.size,
            '',
            'Recent sync log (' + _syncLogRing.length + ' lines):',
            ..._syncLogRing
          ];
          sendResponse({ success: true, text: lines.join('\n') });
        });
    });
    return true;

  } else if (message.action === "triggerSync") {
    executeSyncPull((pullOk) => {
      executeSyncPush();
      sendResponse({ success: pullOk });
    });
    return true;

  } else if (message.action === "syncPullIfEnabled") {
    chrome.storage.local.get(['icloudSyncEnabled'], (result) => {
      if (result.icloudSyncEnabled) {
        executeSyncPull();
      }
    });
    return false; // No async response needed

  } else if (message.action === "syncFlushAndPush") {
    flushSyncDirtyAndPush();
    return false;

  } else if (message.action === "suppressStartupLaunch") {
    // User toggled setting during a live session; do not auto-open again this session
    markStartupLaunched(() => {
      removeStartupFallbacks();
      if (typeof sendResponse === 'function') sendResponse({ ok: true });
    });
    return true;

  } else if (message.action === "getDefaultSessionTitle") {
    sendResponse(buildDefaultSessionTitle());
    return;

  } else if (message.action === "runFiltersOnSessions") {
    runFiltersOnExistingSessions((result) => {
      sendResponse(result);
    });
    return true; // Will respond asynchronously

  } else if (message.action === "saveTabs") {
    handleSaveTabs();
    // Ensure badge is refreshed after popup action
    setTimeout(() => refreshBadge(), 100);

  } else if (message.action === "saveActiveTabAndClose") {
    saveActiveTabExplicit(true);
    setTimeout(() => refreshBadge(), 100);

  } else if (message.action === "saveActiveTabNoClose") {
    saveActiveTabExplicit(false);
    setTimeout(() => refreshBadge(), 100);

  } else if (message.action === "saveTabsNoClose") {
    handleSaveTabsNoClose();
    setTimeout(() => refreshBadge(), 100);

  } else if (message.action === "saveAndCloseIOS") {
    handleSaveAndCloseIOS();
    setTimeout(() => refreshBadge(), 100);

  } else if (message.action === "saveAndClose") {
    handleSaveAndClose();
    // Ensure badge is refreshed after popup action
    setTimeout(() => refreshBadge(), 100);

  } else if (message.action === "saveSelectedTabs") {
    // Handle saving only selected tabs from Option+Click selection mode
    const { tabIds } = message;
    if (tabIds && Array.isArray(tabIds) && tabIds.length > 0) {
      handleSaveSelectedTabs(tabIds);
      setTimeout(() => refreshBadge(), 100);
    }

  } else if (message.action === "processPastedSession") {
    // Handle AI processing for pasted links - uses same logic as saveSession()
    const { timestamp, tabs, aiTitleEnabled, aiCategorizationEnabled } = message;
    if (!timestamp || !tabs || tabs.length === 0) return;

    // Process tabs through Smart Groups matching (before AI operations)
    processTabsThroughSmartGroups(tabs, (remainingTabs, matchedTabsByGroup) => {
      processPastedSessionWithSmartGroups(timestamp, tabs, remainingTabs, matchedTabsByGroup, aiTitleEnabled, aiCategorizationEnabled);
    });

  } else if (message.action === "categorizePastedSession") {
    // Direct categorization trigger (for deferred execution after pending flag was set)
    const { timestamp, tabs } = message;
    if (timestamp && tabs && tabs.length >= 6) {
      // Guard: prevent duplicate concurrent calls
      if (activeCategorizationTimestamps.has(timestamp)) {
        debugWithMessage(`Categorization already in progress for ${timestamp}, ignoring duplicate`);
      } else {
        activeCategorizationTimestamps.add(timestamp);
        categorizationInBackground(timestamp, tabs);
      }
    }

  } else if (message.action === "generateTitleForPastedSession") {
    // Direct title generation trigger (for deferred execution after pending flag was set)
    const { timestamp, tabs } = message;
    if (timestamp && tabs && tabs.length > 0) {
      // Guard: prevent duplicate concurrent calls
      if (activeTitleTimestamps.has(timestamp)) {
        debugWithMessage(`Title generation already in progress for ${timestamp}, ignoring duplicate`);
      } else {
        activeTitleTimestamps.add(timestamp);
        generateAITitleInBackground(timestamp, tabs);
      }
    }

  } else if (message.action === "clearTab") {
    chrome.storage.local.get(["savedSessions"], (result) => {
      let sessions = result.savedSessions || [];
      let removedTab = null;
      let sessionName = "";

      let sessionFound = false;
      sessions = sessions.map(session => {
        if (session.timestamp === message.timestamp) {
          sessionFound = true;
          if (!session.locked) {
            // Find the tab to be removed and move it to trash
            const tabIndex = session.tabs.findIndex(t => t.url === message.url);
            if (tabIndex !== -1) {
              removedTab = session.tabs[tabIndex];
              sessionName = session.customName || session.defaultTitle || "Untitled Session";

              // Move tab to trash before removing from session
              moveToTrash(removedTab, sessionName, session.timestamp);
            }

            session.tabs = session.tabs.filter(t => t.url !== message.url);
          }
        }
        return session;
      }).filter(s => s.tabs.length > 0);

      chrome.storage.local.set({ savedSessions: sessions }, () => {
        // Sync: mark modified session dirty (or deleted if it was removed)
        if (sessionFound) {
          const updated = sessions.find(s => s.timestamp === message.timestamp);
          if (updated) {
            markSyncDirty('Session', 'session-' + message.timestamp, updated);
          } else {
            markSyncDeleted('Session', 'session-' + message.timestamp);
          }
        }
        updateListHtmlTabs(sessions);
        refreshBadge();
      });
    });

  } else if (message.action === "deleteSession") {
    const { timestamp } = message;
    chrome.storage.local.get(["savedSessions", "trashedLinks"], (result) => {
      if (chrome.runtime.lastError) {
        return;
      }
      let sessions = result.savedSessions || [];
      let trashedLinks = result.trashedLinks || [];

      const idx = sessions.findIndex(s => s.timestamp === timestamp);
      if (idx === -1) {
        return;
      }
      const [deleted] = sessions.splice(idx, 1);

      // Move all session tabs to trash in a single batch (avoids read-modify-write race)
      const sessionName = deleted.customName || deleted.defaultTitle || "Untitled Session";
      const now = Date.now();
      const retentionMs = 30 * 24 * 60 * 60 * 1000;
      const newTrashLinks = [];
      for (const tab of deleted.tabs) {
        const trashedLink = {
          id: generateLinkId(deleted.timestamp, tab.url),
          url: tab.url,
          title: tab.title,
          originalSessionName: sessionName,
          trashedAt: now,
          expiresAt: now + retentionMs
        };
        if (deleted.timestamp) {
          const parsed = Date.parse(deleted.timestamp);
          if (!isNaN(parsed)) trashedLink.originalSavedAt = parsed;
        }
        trashedLinks.push(trashedLink);
        newTrashLinks.push(trashedLink);
      }
      trashedLinks = enforceTrashLimits(trashedLinks);

      const deleteId = generateDeleteId();
      deletedSessionsMap[deleteId] = { session: deleted, index: idx };
      chrome.storage.local.set({ savedSessions: sessions, trashedLinks }, () => {
        // Sync: mark session deleted and each trash link dirty
        markSyncDeleted('Session', 'session-' + timestamp);
        for (const link of newTrashLinks) {
          markSyncDirty('TrashedLink', 'trash-' + link.id, link);
        }
        updateListHtmlTrash(trashedLinks);
        sendResponse({ deleteId });
        setTimeout(() => {
          updateListHtmlTabs(sessions);
          notifySessionDeleted(deleteId, deleted);
          refreshBadge();
        }, 400);
      });
    });
    return true; // async sendResponse

  } else if (message.action === "undoDeleteSession") {
    const { deleteId } = message;
    const info = deletedSessionsMap[deleteId];
    if (!info) return;
    chrome.storage.local.get(["savedSessions"], (result) => {
      let sessions = result.savedSessions || [];
      const { session, index } = info;
      sessions.splice(Math.min(index, sessions.length), 0, session);
      delete deletedSessionsMap[deleteId];
      chrome.storage.local.set({ savedSessions: sessions }, () => {
        // Sync: re-add undone session
        markSyncDirty('Session', 'session-' + session.timestamp, session);
        notifySessionRestored(deleteId);
        refreshBadge();
      });
    });

  } else if (message.action === "openSingleTab") {
    // SHIFT CLICK => invert delete
    chrome.storage.local.get(["deleteAfterRestore", "opentabsBackground"], (res) => {
      let effectiveDelete = !!res.deleteAfterRestore;
      if (message.invertDelete) {
        effectiveDelete = !effectiveDelete;
      }

      // Decide if we open in background or not
      let openInBg = (res.opentabsBackground !== false);
      // If the user asked to invert
      if (message.invertBackground) {
        openInBg = !openInBg;
      }

      // Now open the requested URL
      chrome.tabs.create({
        url: message.url,
        active: !openInBg
      });

      // If we must delete it from local storage, do so
      if (effectiveDelete && message.timestamp) {
        chrome.storage.local.get(["savedSessions"], (result) => {
          let sessions = result.savedSessions || [];
          sessions = sessions.map((session) => {
            if (session.timestamp === message.timestamp && !session.locked) {
              session.tabs = session.tabs.filter((t) => t.url !== message.url);
            }
            return session;
          }).filter((s) => s.tabs.length > 0);

          chrome.storage.local.set({ savedSessions: sessions }, () => {
            // Sync: session modified or deleted
            const updated = sessions.find(s => s.timestamp === message.timestamp);
            if (updated) {
              markSyncDirty('Session', 'session-' + message.timestamp, updated);
            } else {
              markSyncDeleted('Session', 'session-' + message.timestamp);
            }
            updateListHtmlTabs(sessions);
            refreshBadge();
          });
        });
      }
    });

  } else if (message.action === "reopenTabs") {
    const sessionTimestamp = message.timestamp;
    chrome.storage.local.get(["deleteAfterRestore", "opentabsBackground", "savedSessions", "closeHomeTabOnOpen", "restoreTabsTo"], (result) => {
      let effectiveDelete = !!result.deleteAfterRestore;
      if (message.invertDelete) {
        effectiveDelete = !effectiveDelete;
      }
      if (typeof result.closeHomeTabOnOpen !== 'boolean') {
        result.closeHomeTabOnOpen = true;
      }

      let openInBg = (result.opentabsBackground !== false);
      if (message.invertBackground) {
        openInBg = !openInBg;
      }

      const restoreLocation = result.restoreTabsTo || "current";
      const extensionPageUrls = getExtensionPageUrls();

      // Determine where to restore tabs
      const restoreTabs = (useNewWindow) => {
        if (useNewWindow && chrome.windows?.create) {
          // Create new window with all tabs
          // Always focus new windows (ignore openInBg setting for new windows)
          const urls = message.tabList.map(tab => tab.url);
          chrome.windows.create({
            url: urls,
            focused: true
          });
        } else {
          // Open each tab in current window
          message.tabList.forEach(tab => {
            chrome.tabs.create({
              url: tab.url,
              active: !openInBg
            });
          });
        }
      };

      // Decide whether to use new window based on restoreLocation setting
      if (restoreLocation === "new") {
        // Create new window, unless Tabstract is the only tab (then use current)
        chrome.tabs.query({ currentWindow: true }, (tabs) => {
          const nonExtensionTabs = tabs.filter(tab =>
            !extensionPageUrls.some(url => tab.url && tab.url.startsWith(url))
          );
          const useNewWindow = nonExtensionTabs.length > 0;
          restoreTabs(useNewWindow);
        });
      } else {
        // Default: always use current window
        restoreTabs(false);
      }

      let sessions = result.savedSessions || [];
      if (effectiveDelete) {
        const idx = sessions.findIndex(s => s.timestamp === sessionTimestamp);
        if (idx >= 0) {
          if (!sessions[idx].locked) {
            sessions.splice(idx, 1);
            markSyncDeleted('Session', 'session-' + sessionTimestamp);
          }
          chrome.storage.local.set({ savedSessions: sessions }, () => {
            updateListHtmlTabs(sessions);
            refreshBadge();
          });
        }
      }
      if (result.closeHomeTabOnOpen) {
        chrome.tabs.query({}, (allTabs) => {
          // Find any tabs that match our extension pages
          const extensionTabs = allTabs.filter(tab =>
            extensionPageUrls.some(url => tab.url && tab.url.startsWith(url))
          );
          extensionTabs.forEach(t => chrome.tabs.remove(t.id));
        });
      }
    });

  } else if (message.action === "snoozeBadge") {
    const hours = (typeof message.hours === 'number') ? message.hours : 24;
    const now = Date.now();
    let snoozeUntil = now;
    if (hours > 0) {
      snoozeUntil = now + hours * 3600 * 1000;
    }
    chrome.storage.local.set({ badgeSnoozeUntil: snoozeUntil }, () => {
      scheduleUnsnoozeAlarm(snoozeUntil);
      refreshBadge();
    });

  } else if (message.action === "refreshBadge") {
    refreshBadge();

  } else if (message.action === "updateAccentColor") {
    // Update badge background color when accent color changes
    updateBadgeColor(message.color);

  } else if (message.action === "save-active-tab") {
    saveActiveTab();

  } else if (message.action === "openList") {
    handleOpenList();

  } else if (message.action === "restoreSessionFromTrash") {
    // New action to restore all tabs from a deleted session
    const { sessionTimestamp, sessionData } = message;

    chrome.storage.local.get(['trashedLinks', 'savedSessions'], (result) => {
      let trashedLinks = result.trashedLinks || [];
      let sessions = result.savedSessions || [];

      // Find all trashed links from this session
      const sessionTrash = trashedLinks.filter(link =>
        link.originalSessionName === (sessionData.customName || sessionData.defaultTitle || "Untitled Session")
      );

      if (sessionTrash.length === 0) {
        return;
      }

      // Restore the session with the trashed tabs
      const restoredSession = {
        ...sessionData,
        tabs: sessionTrash.map(trashItem => ({
          url: trashItem.url,
          title: trashItem.title
        }))
      };

      // Insert session back at its original position or at the end
      sessions.push(restoredSession);

      // Remove restored items from trash
      trashedLinks = trashedLinks.filter(link =>
        !sessionTrash.some(restored => restored.id === link.id)
      );

      // Save both updates
      chrome.storage.local.set({ savedSessions: sessions, trashedLinks }, () => {
        // Sync: mark restored session dirty and removed trash links deleted
        markSyncDirty('Session', 'session-' + restoredSession.timestamp, restoredSession);
        for (const item of sessionTrash) {
          markSyncDeleted('TrashedLink', 'trash-' + item.id);
        }
        updateListHtmlTabs(sessions);
        updateListHtmlTrash(trashedLinks);
        refreshBadge();
      });
    });

  } else if (message.action === "restoreTabFromTrash") {
    // New action to restore a single tab from trash back to its original session
    const { sessionTimestamp, tabUrl } = message;

    chrome.storage.local.get(['trashedLinks', 'savedSessions'], (result) => {
      let trashedLinks = result.trashedLinks || [];
      let sessions = result.savedSessions || [];

      // Find the trashed link
      const trashIndex = trashedLinks.findIndex(link => link.url === tabUrl);
      if (trashIndex === -1) {
        return;
      }

      const trashedLink = trashedLinks[trashIndex];
      trashedLinks.splice(trashIndex, 1);

      // Find or recreate the session
      let targetSession = sessions.find(s => s.timestamp === sessionTimestamp);
      if (!targetSession) {
        // Session doesn't exist anymore, create a minimal one
        const locale = getEffectiveLocale();
        targetSession = {
          timestamp: sessionTimestamp,
          defaultTitle: `Restored: ${new Date(sessionTimestamp).toLocaleString(locale)}`,
          tabs: []
        };
        sessions.push(targetSession);
      }

      // Add the tab back to the session
      targetSession.tabs.push({
        url: trashedLink.url,
        title: trashedLink.title
      });

      chrome.storage.local.set({ savedSessions: sessions, trashedLinks }, () => {
        // Sync: mark modified session dirty and removed trash link deleted
        markSyncDirty('Session', 'session-' + targetSession.timestamp, targetSession);
        markSyncDeleted('TrashedLink', 'trash-' + trashedLink.id);
        updateListHtmlTabs(sessions);
        updateListHtmlTrash(trashedLinks);
        refreshBadge();
      });
    });

  } else if (message.action === "restoreFromTrash") {
    const { linkId } = message;
    chrome.storage.local.get(['trashedLinks', 'savedSessions'], (result) => {
      let trashedLinks = result.trashedLinks || [];
      let sessions = result.savedSessions || [];

      // Find the trashed link
      const linkIndex = trashedLinks.findIndex(link => link.id === linkId);
      if (linkIndex === -1) return;

      const restoredLink = trashedLinks[linkIndex];

      // Create a new session with the restored link
      const newSession = {
        timestamp: new Date().toISOString(),
        defaultTitle: buildDefaultSessionTitle(),
        customName: chrome.i18n.getMessage("restoredLinkSessionName") || "Restored Link",
        tabs: [{
          url: restoredLink.url,
          title: restoredLink.title
        }]
      };

      // Remove from trash and add new session
      trashedLinks.splice(linkIndex, 1);
      sessions.unshift(newSession);

      chrome.storage.local.set({ trashedLinks, savedSessions: sessions }, () => {
        // Sync: new session + removed trash item
        markSyncDirty('Session', 'session-' + newSession.timestamp, newSession);
        markSyncDeleted('TrashedLink', 'trash-' + linkId);
        updateListHtmlTabs(sessions);
        updateListHtmlTrash(trashedLinks);
        refreshBadge();
      });
    });

  } else if (message.action === "permanentlyDeleteFromTrash") {
    const { linkId } = message;
    chrome.storage.local.get(['trashedLinks'], (result) => {
      let trashedLinks = result.trashedLinks || [];
      trashedLinks = trashedLinks.filter(link => link.id !== linkId);

      chrome.storage.local.set({ trashedLinks }, () => {
        markSyncDeleted('TrashedLink', 'trash-' + linkId);
        updateListHtmlTrash(trashedLinks);
      });
    });

  } else if (message.action === "emptyTrash") {
    // Sync: mark all trash items as deleted before clearing
    chrome.storage.local.get(['trashedLinks'], (trashResult) => {
      (trashResult.trashedLinks || []).forEach(link => {
        markSyncDeleted('TrashedLink', 'trash-' + link.id);
      });
    });
    chrome.storage.local.set({ trashedLinks: [] }, () => {
      updateListHtmlTrash([]);
    });

  } else if (message.action === "moveTabToTrash") {
    // New action to move a single tab directly to trash
    const { tab, sessionName, sessionTimestamp } = message;
    moveToTrash(tab, sessionName, sessionTimestamp);

  } else if (message.action === "moveSessionToTrash") {
    // New action to move session tabs directly to trash
    const { sessionName, sessionTimestamp, tabs } = message;

    // Move all tabs to trash in a single operation to avoid race conditions
    const now = Date.now();
    const retentionMs = 30 * 24 * 60 * 60 * 1000; // 30 days in milliseconds

    chrome.storage.local.get(['trashedLinks'], (result) => {
      let trashedLinks = result.trashedLinks || [];

      // Add all tabs to trash at once
      const newTrashLinks = [];
      tabs.forEach(tab => {
        const trashedLink = {
          id: generateLinkId(sessionTimestamp, tab.url),
          url: tab.url,
          title: tab.title,
          originalSessionName: sessionName,
          trashedAt: now,
          expiresAt: now + retentionMs
        };
        // Record original saved time if available
        if (sessionTimestamp) {
          const parsed = Date.parse(sessionTimestamp);
          if (!isNaN(parsed)) trashedLink.originalSavedAt = parsed;
        }
        trashedLinks.push(trashedLink);
        newTrashLinks.push(trashedLink);
      });

      // Enforce size limits
      trashedLinks = enforceTrashLimits(trashedLinks);

      // Save all changes in one operation
      chrome.storage.local.set({ trashedLinks }, () => {
        // Sync: mark each created trash link dirty
        for (const link of newTrashLinks) {
          markSyncDirty('TrashedLink', 'trash-' + link.id, link);
        }
        // Notify any open list.html tabs about the trash update
        updateListHtmlTrash(trashedLinks);
      });
    });

  } else if (message.action === "getTrashData") {
    chrome.storage.local.get(['trashedLinks'], (result) => {
      let trashedLinks = result.trashedLinks || [];

      const now = Date.now();
      const retentionMs = 30 * 24 * 60 * 60 * 1000; // 30 days

      // Normalize items: ensure expiresAt exists; coerce trashedAt to number if needed
      let changed = false;
      trashedLinks = trashedLinks.map(link => {
        const normalized = { ...link };
        let trashedAtNum = normalized.trashedAt;
        if (typeof trashedAtNum !== 'number') {
          if (trashedAtNum) {
            const parsed = Date.parse(trashedAtNum);
            trashedAtNum = isNaN(parsed) ? now : parsed;
          } else {
            trashedAtNum = now;
          }
          if (normalized.trashedAt !== trashedAtNum) changed = true;
          normalized.trashedAt = trashedAtNum;
        }
        if (!normalized.expiresAt) {
          normalized.expiresAt = trashedAtNum + retentionMs;
          changed = true;
        }
        // Also backfill originalSessionName for consistency if sessionName exists
        if (!normalized.originalSessionName && normalized.sessionName) {
          normalized.originalSessionName = normalized.sessionName;
          changed = true;
        }
        // Backfill originalSavedAt if we have a sessionTimestamp string
        if (!normalized.originalSavedAt && normalized.sessionTimestamp) {
          const p = Date.parse(normalized.sessionTimestamp);
          if (!isNaN(p)) {
            normalized.originalSavedAt = p;
            changed = true;
          }
        }
        return normalized;
      });

      // Prune expired and enforce limits
      const beforeCount = trashedLinks.length;
      trashedLinks = trashedLinks.filter(link => now < link.expiresAt);
      trashedLinks = enforceTrashLimits(trashedLinks);
      if (trashedLinks.length !== beforeCount) changed = true;

      if (changed) {
        chrome.storage.local.set({ trashedLinks }, () => {
          updateListHtmlTrash(trashedLinks);
          sendResponse({ trashedLinks });
        });
      } else {
        sendResponse({ trashedLinks });
      }
    });
    return true; // Indicates we will send a response asynchronously

  } else if (message.action === "regenerateSessionTitle") {
    const { timestamp } = message;
    if (!timestamp) return;
    chrome.storage.local.get(["savedSessions"], (res) => {
      const sessions = res.savedSessions || [];
      const aiAvailable = lastKnownAIAvailability !== false;
      const idx = sessions.findIndex(s => s.timestamp === timestamp);
      if (!aiAvailable || idx === -1) {
        // Notify UI to clear loading state
        chrome.tabs.query({ url: chrome.runtime.getURL("list.html") }, (tabs) => {
          tabs.forEach(tab => {
            chrome.tabs.sendMessage(tab.id, {
              action: "titleRegenerated",
              timestamp,
              error: !aiAvailable ? 'ai-unavailable' : 'notfound'
            });
          });
        });
        return;
      }
      const session = sessions[idx];
      const tabList = session.tabs || [];
      // Reuse existing background title generation
      generateAITitleInBackground(timestamp, tabList);
    });
    return true;
  } else if (message.action === "moveSearchResultsToNewSession") {
    // Move search results to new session
    (async () => {
      try {
        const result = await moveSearchResultsToNewSession(message.searchResults, message.sessionTitle);
        sendResponse(result);
      } catch (error) {
        sendResponse({ success: false, error: error.message });
      }
    })();
    return true;
  } else if (message.action === "testTemplateAlarm") {
    // DEBUG: Manually trigger a template alarm for testing
    const { templateId } = message;
    debug(`[Template Alarm] 🧪 Manual test trigger for ${templateId}`);
    debugWithMessage(`[Template Alarm] 🧪 Manual test trigger for ${templateId}`);
    handleTemplateAlarm(templateId);
    return false;
  } else if (message.action === "checkSchedulesNow") {
    checkTemplateSchedules();
    return false;
  }
}
chrome.runtime.onMessage.addListener(handleRuntimeMessage);

// ============================================================================
// Template Scheduling - Interval-based (Safari-compatible)
// ============================================================================
// Note: Safari's chrome.alarms API is unreliable in service workers.
// We use setInterval polling instead for reliable scheduling.

/**
 * Calculate the next time an alarm should fire based on schedule
 */
function calculateNextAlarmTime(schedule) {
  const now = new Date();
  let nextTime = new Date();

  switch (schedule.type) {
    case 'hourly':
      // Next hour on the hour
      nextTime.setMinutes(0, 0, 0);
      nextTime.setHours(nextTime.getHours() + 1);
      break;

    case 'daily':
      // Today or tomorrow at the specified time
      nextTime.setHours(schedule.hour, schedule.minute, 0, 0);
      if (nextTime <= now) {
        nextTime.setDate(nextTime.getDate() + 1);
      }
      break;

    case 'weekly':
      // Find next matching day of week
      if (!schedule.daysOfWeek || schedule.daysOfWeek.length === 0) {
        return null;
      }

      nextTime.setHours(schedule.hour, schedule.minute, 0, 0);
      const currentDay = now.getDay();
      let daysToAdd = null;

      // Sort days and find the next one
      const sortedDays = [...schedule.daysOfWeek].sort((a, b) => a - b);

      // Check if any day is today or later this week
      for (const day of sortedDays) {
        if (day > currentDay) {
          daysToAdd = day - currentDay;
          break;
        } else if (day === currentDay && nextTime > now) {
          daysToAdd = 0;
          break;
        }
      }

      // If no day found this week, wrap to next week
      if (daysToAdd === null) {
        daysToAdd = 7 - currentDay + sortedDays[0];
      }

      nextTime.setDate(nextTime.getDate() + daysToAdd);
      break;

    case 'monthly':
      // This month or next month on the specified day
      const dayOfMonth = schedule.dayOfMonth || 1;
      nextTime.setDate(dayOfMonth);
      nextTime.setHours(schedule.hour, schedule.minute, 0, 0);

      if (nextTime <= now) {
        nextTime.setMonth(nextTime.getMonth() + 1);
        nextTime.setDate(dayOfMonth);
      }

      // Handle case where day doesn't exist in month (e.g., Feb 31)
      if (nextTime.getDate() !== dayOfMonth) {
        // Set to last day of previous month
        nextTime.setDate(0);
      }
      break;

    default:
      return null;
  }

  return nextTime;
}

/**
 * Handle when a template alarm fires
 */
async function handleTemplateAlarm(templateId) {
  debug(`[Template Alarm] 🔥 Firing for template ${templateId}`);
  debugWithMessage(`[Template Alarm] 🔥 Firing for template ${templateId}`);

  // Get the template
  const result = await new Promise(resolve => {
    chrome.storage.local.get(["savedTemplates"], resolve);
  });

  const templates = result.savedTemplates || [];
  const template = templates.find(t => t.id === templateId);

  if (!template) {
    debug(`[Template Alarm] ❌ Template ${templateId} not found`);
    debugWithMessage(`[Template Alarm] ❌ Template ${templateId} not found`);
    return;
  }

  debug(`[Template Alarm] Found template: "${template.name}"`);
  debugWithMessage(`[Template Alarm] Found template: "${template.name}"`);

  if (!template.schedule || !template.schedule.enabled) {
    debug(`[Template Alarm] ⚠️ Template ${templateId} no longer has active schedule`);
    debugWithMessage(`[Template Alarm] ⚠️ Template ${templateId} no longer has active schedule`);
    return;
  }

  // Spawn session from template
  const newSession = {
    timestamp: new Date().toISOString(),
    customName: template.name,
    tabs: template.tabs.map(tab => ({ ...tab })),
    color: template.color || null,
    pinned: template.pinned || false,
    scheduledTemplate: true // Mark as created from scheduled template
  };

  // If template has pinned status, set pinnedAt timestamp
  if (newSession.pinned) {
    newSession.pinnedAt = Date.now();
  }

  debug(`[Template Alarm] Creating session with ${newSession.tabs.length} tabs`);
  debugWithMessage(`[Template Alarm] Creating session with ${newSession.tabs.length} tabs`);

  // Atomically add session and update template lastExecuted in one operation
  // Re-read fresh data right before writing to avoid race conditions
  const freshData = await new Promise(resolve => {
    chrome.storage.local.get(["savedSessions", "savedTemplates"], resolve);
  });

  let sessions = freshData.savedSessions || [];
  sessions.unshift(newSession);

  // Update lastExecuted on the fresh template data
  const freshTemplates = freshData.savedTemplates || [];
  const freshTemplate = freshTemplates.find(t => t.id === templateId);
  if (freshTemplate && freshTemplate.schedule) {
    freshTemplate.schedule.lastExecuted = new Date().toISOString();
  }

  // Save both in one operation to minimize race window
  await new Promise(resolve => {
    chrome.storage.local.set({
      savedSessions: sessions,
      savedTemplates: freshTemplates
    }, resolve);
  });

  // Sync: mark new session and updated template dirty
  markSyncDirty('Session', 'session-' + newSession.timestamp, newSession);
  if (freshTemplate) {
    markSyncDirty('Template', freshTemplate.id, freshTemplate);
  }

  debug(`[Template Alarm] ✅ Spawned session from template ${templateId}`);
  debugWithMessage(`[Template Alarm] ✅ Spawned session "${template.name}" from template`);

  debug(`[Template Alarm] Updated lastExecuted to ${freshTemplate?.schedule?.lastExecuted}`);

  // Refresh UI if list.html is open
  chrome.tabs.query({ url: chrome.runtime.getURL("list.html") }, (tabs) => {
    if (tabs.length > 0) {
      debug(`[Template Alarm] Refreshing ${tabs.length} open list.html tabs`);
    }
    tabs.forEach(tab => chrome.tabs.sendMessage(tab.id, {
      action: "refreshSessions",
      newSessionTimestamp: newSession.timestamp,
      fromScheduledTemplate: true
    }));
  });

  // Note: Interval checker handles scheduling automatically
}

// ============================================================================
// Interval-based Template Schedule Checker (Safari-compatible workaround)
// ============================================================================

let templateScheduleCheckInterval = null;

/**
 * Check if a template schedule is currently due to execute
 */
function isTemplateDue(template) {
  if (!template.schedule || !template.schedule.enabled) {
    return false;
  }

  const now = new Date();
  const schedule = template.schedule;
  const lastExecuted = schedule.lastExecuted ? new Date(schedule.lastExecuted) : null;

  // If we've never executed, check if we're past the scheduled time today
  if (!lastExecuted) {
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    const scheduledMinutes = schedule.hour * 60 + schedule.minute;
    const minutesDiff = currentMinutes - scheduledMinutes;

    // For never-executed templates, trigger if we're past the scheduled time (no upper limit)
    const isDue = minutesDiff >= 0;
    return isDue;
  }

  // Check if enough time has passed since last execution
  const timeSinceLastExecution = now - lastExecuted;
  const minutesSinceLastExecution = Math.floor(timeSinceLastExecution / 1000 / 60);

  // Check if we're past the scheduled time
  const scheduledTimeToday = new Date(now);
  scheduledTimeToday.setHours(schedule.hour, schedule.minute, 0, 0);

  switch (schedule.type) {
    case 'hourly':
      // Should run every hour at the top of the hour
      // Allow a 2-minute window to account for checking interval
      const isTopOfHour = now.getMinutes() <= 1;
      const hourPassed = timeSinceLastExecution >= 60 * 60 * 1000;
      return hourPassed && isTopOfHour;

    case 'daily':
      // Should run once per day at the specified time
      // Must be at least 23 hours since last execution
      if (timeSinceLastExecution < 23 * 60 * 60 * 1000) {
        return false;
      }

      // Check if we're past the scheduled time today (no upper limit - catch up whenever browser opens)
      const currentMinutes = now.getHours() * 60 + now.getMinutes();
      const scheduledMinutes = schedule.hour * 60 + schedule.minute;
      const minutesDiff = currentMinutes - scheduledMinutes;

      // Trigger if we're past the scheduled time
      const isDailyDue = minutesDiff >= 0;
      return isDailyDue;

    case 'weekly':
      // Should run on specified days of the week
      if (timeSinceLastExecution < 6 * 24 * 60 * 60 * 1000) {
        return false;
      }
      const currentDay = now.getDay();
      if (!schedule.daysOfWeek || !schedule.daysOfWeek.includes(currentDay)) {
        return false;
      }

      // Check if we're past the scheduled time (no upper limit - catch up whenever browser opens)
      const currentWeeklyMinutes = now.getHours() * 60 + now.getMinutes();
      const scheduledWeeklyMinutes = schedule.hour * 60 + schedule.minute;
      const weeklyMinutesDiff = currentWeeklyMinutes - scheduledWeeklyMinutes;
      const isWeeklyDue = weeklyMinutesDiff >= 0;
      return isWeeklyDue;

    case 'monthly':
      // Should run on specified day of month
      if (timeSinceLastExecution < 28 * 24 * 60 * 60 * 1000) {
        return false;
      }
      const dayOfMonth = schedule.dayOfMonth || 1;
      const isRightDay = now.getDate() === dayOfMonth;
      if (!isRightDay) {
        return false;
      }

      // Check if we're past the scheduled time (no upper limit - catch up whenever browser opens)
      const currentMonthlyMinutes = now.getHours() * 60 + now.getMinutes();
      const scheduledMonthlyMinutes = schedule.hour * 60 + schedule.minute;
      const monthlyMinutesDiff = currentMonthlyMinutes - scheduledMonthlyMinutes;
      const isMonthlyDue = monthlyMinutesDiff >= 0;
      return isMonthlyDue;

    default:
      return false;
  }
}

/**
 * Lock to prevent concurrent schedule checks
 */
let isCheckingSchedules = false;

/**
 * Check all templates and execute any that are due
 */
async function checkTemplateSchedules() {
  // Prevent concurrent execution
  if (isCheckingSchedules) {
    debug('[Template Scheduler] Already checking schedules, skipping');
    return;
  }

  isCheckingSchedules = true;

  try {
    const result = await new Promise(resolve => {
      chrome.storage.local.get(["savedTemplates"], resolve);
    });

    const templates = result.savedTemplates || [];
    const scheduledTemplates = templates.filter(t => t.schedule && t.schedule.enabled);

    if (scheduledTemplates.length === 0) {
      return;
    }

    for (const template of scheduledTemplates) {
      const isDue = isTemplateDue(template);
      if (isDue) {
        await handleTemplateAlarm(template.id);
      }
    }
  } finally {
    isCheckingSchedules = false;
  }
}

/**
 * Start checking schedules on service worker wake
 * Note: Safari suspends service workers, so we can't rely on setInterval here.
 * Instead, we check on various events and let list.html handle periodic checks.
 */
function checkSchedulesOnWake() {
  checkTemplateSchedules();
}

// Check schedules when the extension loads
checkSchedulesOnWake();

// Check schedules on various events to catch missed schedules
chrome.tabs.onActivated.addListener(() => {
  checkTemplateSchedules();
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) {
    checkTemplateSchedules();
  }
});

// Check when extension icon is clicked (popup opens)
chrome.action.onClicked.addListener(() => {
  checkTemplateSchedules();
});

// For "undo delete session"
const deletedSessionsMap = {};

function generateDeleteId() {
  return 'del-' + Math.random().toString(36).substring(2, 10);
}

/**
 * Get the effective locale for date/time formatting
 */
function getEffectiveLocale() {
  if (PREFERRED_LANGUAGE && PREFERRED_LANGUAGE !== 'auto') {
    return PREFERRED_LANGUAGE;
  }
  return chrome.i18n.getUILanguage() || navigator.language;
}

/**
 * Load locale messages from the _locales directory
 */
async function loadLocaleMessages(locale) {
  try {
    const url = chrome.runtime.getURL(`_locales/${locale}/messages.json`);
    const response = await fetch(url);
    if (response.ok) {
      const messages = await response.json();
      LOCALE_MESSAGES = messages;
      debug('[Tabstract] Loaded locale messages for:', locale);
    } else {
      debug('[Tabstract] Failed to load locale messages for:', locale);
      LOCALE_MESSAGES = {};
    }
  } catch (error) {
    debug('[Tabstract] Error loading locale messages:', error);
    LOCALE_MESSAGES = {};
  }
}

/**
 * Get a localized message that respects PREFERRED_LANGUAGE setting
 * Falls back to chrome.i18n.getMessage if message not found in loaded locale
 */
function getLocalizedMessage(key) {
  // If we have loaded messages and the key exists, use it
  if (LOCALE_MESSAGES[key] && LOCALE_MESSAGES[key].message) {
    return LOCALE_MESSAGES[key].message;
  }

  // Otherwise use standard chrome.i18n
  return chrome.i18n.getMessage(key);
}

/**
 * Build a default session title using the user's locale
 * Format example: Tuesday, March 25 7:31 PM
 * (No seconds, full weekday & month, localized time format)
 */
function buildDefaultSessionTitle() {
  const now = new Date();
  const locale = getEffectiveLocale();

  const formattedDate = now.toLocaleDateString(locale, {
    weekday: chrome.i18n.getMessage("weekdayFormat") || 'long',
    month: chrome.i18n.getMessage("monthFormat") || 'long',
    day: chrome.i18n.getMessage("dayFormat") || 'numeric'
  });

  const formattedTime = now.toLocaleTimeString(locale, {
    hour: chrome.i18n.getMessage("hourFormat") || 'numeric',
    minute: chrome.i18n.getMessage("minuteFormat") || 'numeric'
  });

  return `${formattedDate} ${formattedTime}`;
}

/**
 * Query the current window's tabs, filter out ineligible ones,
 * optionally skip pinned tabs, handle duplicates if user wants to.
 */
function getTabList(callback) {
  chrome.storage.local.get(["pinnedTabs", "avoidDuplicates"], (res) => {
    const skipPinned = !!res.pinnedTabs;
    const avoidDupes = res.avoidDuplicates !== false; // default = true

    chrome.tabs.query({ currentWindow: true }, (tabs) => {
      let rawList = tabs
        .filter(tab => {
          if (!tab.url) return false;
          if (tab.url.startsWith("safari-web-extension://")) return false;
          if (tab.url.startsWith("favorites://")) return false;
          if (tab.url === "about:blank") return false;
          if (skipPinned && tab.pinned) return false;
          return true;
        })
        .map(tab => {
          let status;
          try {
            const rec = mainFrameStatusByTab.get(tab.id);
            if (rec) status = rec.status;
          } catch (e) {}
          const hints = computeWorkHints(tab.url, tab.title, status);
          return {
            id: tab.id,
            url: tab.url,
            title: tab.title,
            status,
            hints
          };
        });

      // Extract og:description from each tab in parallel
      const failureReasons = [];
      const cacheHits = [];
      const metadataPromises = rawList.map(tab => {
        return new Promise((resolve) => {
          // Check cache first (survives content script termination)
          const cached = pageMetadataCache.get(tab.url);
          if (cached && (Date.now() - cached.timestamp) < METADATA_CACHE_TTL) {
            cacheHits.push({ title: tab.title?.substring(0, 40), url: tab.url });
            resolve({ ...tab, ogDescription: cached.ogDescription });
            return;
          }

          // Cache miss or expired - try content script
          let timedOut = false;

          // Set timeout to avoid hanging on unresponsive tabs
          const timeout = setTimeout(() => {
            timedOut = true;
            failureReasons.push({ title: tab.title?.substring(0, 40), reason: 'timeout' });
            resolve({ ...tab, ogDescription: null });
          }, 1000); // 1000ms timeout per tab

          chrome.tabs.sendMessage(tab.id, { action: "getMetadata" }, (response) => {
            if (timedOut) return; // Already resolved via timeout

            clearTimeout(timeout);
            if (chrome.runtime.lastError) {
              failureReasons.push({
                title: tab.title?.substring(0, 40),
                reason: 'error',
                message: chrome.runtime.lastError.message
              });
              resolve({ ...tab, ogDescription: null });
            } else if (!response) {
              failureReasons.push({ title: tab.title?.substring(0, 40), reason: 'no response' });
              resolve({ ...tab, ogDescription: null });
            } else {
              // Cache the result for future use
              if (response.ogDescription) {
                pageMetadataCache.set(tab.url, {
                  ogDescription: response.ogDescription,
                  timestamp: Date.now()
                });
                persistMetadataCache();
              }
              resolve({ ...tab, ogDescription: response.ogDescription });
            }
          });
        });
      });

      // Wait for all metadata to be collected
      Promise.all(metadataPromises).then(enrichedList => {
        // Debug: Log description capture stats
        const withDesc = enrichedList.filter(t => t.ogDescription).length;
        const total = enrichedList.length;
        const cached = cacheHits.length;
        debugWithMessage(`Page descriptions captured for ${withDesc} of ${total} tabs (${cached} from cache)`, { withDesc, total, cached });

        // Log first few examples for verification
        if (withDesc > 0) {
          const examples = enrichedList
            .filter(t => t.ogDescription)
            .slice(0, 3)
            .map(t => ({
              title: t.title?.substring(0, 40) + '...',
              url: new URL(t.url).hostname,
              desc: t.ogDescription?.substring(0, 60) + '...'
            }));
          debugWithMessage('Description examples', examples);
        }

        // Log failure reasons (show first 5)
        if (failureReasons.length > 0) {
          debugWithMessage(`Description capture failures (${failureReasons.length} tabs)`, failureReasons.slice(0, 5));
        }

        // If user wants to avoid duplicates, merge them
        if (avoidDupes) {
          enrichedList = mergeDuplicates(enrichedList);
        }
        callback(enrichedList);
      });
    });
  });
}

/**
 * If multiple tabs share the same URL, keep just one item but store all relevant tab IDs.
 */
function mergeDuplicates(tabList) {
  const mapByUrl = new Map();
  for (const entry of tabList) {
    const { id, url, title, status, hints, ogDescription } = entry;
    if (!mapByUrl.has(url)) {
      mapByUrl.set(url, { url, title, status, hints, ogDescription, allIds: [id] });
    } else {
      const existing = mapByUrl.get(url);
      existing.allIds.push(id);
      // preserve an existing status/hints/ogDescription; if missing, backfill from new
      if (existing.status === undefined && status !== undefined) existing.status = status;
      if (!existing.hints && hints) existing.hints = hints;
      if (!existing.ogDescription && ogDescription) existing.ogDescription = ogDescription;
    }
  }
  return Array.from(mapByUrl.values());
}

// Heuristics to detect work-related tabs
function computeWorkHints(url, title, status) {
  // Keep this intentionally minimal to reduce maintenance; lean on the model.
  try {
    const u = new URL(url);
    const host = (u.host || '').toLowerCase();
    const path = (u.pathname || '').toLowerCase();
    const t = (title || '').toLowerCase();

    const hints = [];
    const add = (s) => { if (s && !hints.includes(s)) hints.push(s); };

    // Authentication/protection signals
    if (status === 401) add('status-401');
    if (status === 403) add('status-403');

    // Generic keywords only (no vendor lists)
    const keywords = ['login', 'signin', 'sso', 'portal', 'intranet', 'internal', 'admin', 'dashboard'];
    if (keywords.some(k => host.includes(k) || path.includes(k) || t.includes(k))) {
      add('keyword');
    }

    return hints.length ? hints.join(',') : undefined;
  } catch (e) {
    return undefined;
  }
}

// =============================
// AI Helper Functions
// =============================

/**
 * Clear all pending AI workflow flags and notify list views so UI can recover
 */
function clearAllPendingAIWork(reason = 'cancelled') {
  lastKnownAIAvailability = false;
  chrome.storage.local.get(["savedSessions"], (result) => {
    const sessions = result.savedSessions || [];
    let changed = false;
    const titleTimestamps = [];

    const updatedSessions = sessions.map((session) => {
      if (!session) return session;

      let modified = false;
      const updated = { ...session };

      if (session.pendingCategorization) {
        delete updated.pendingCategorization;
        delete updated.pendingCategorizationStartedAt;
        modified = true;
      }

      if (session.pendingTitle) {
        delete updated.pendingTitle;
        delete updated.pendingTitleStartedAt;
        titleTimestamps.push(session.timestamp);
        modified = true;
      }

      if (modified) {
        changed = true;
        return updated;
      }
      return session;
    });

    if (!changed) return;

    chrome.storage.local.set({ savedSessions: updatedSessions }, () => {
      chrome.tabs.query({ url: chrome.runtime.getURL("list.html") }, (tabs) => {
        tabs.forEach((tab) => {
          chrome.tabs.sendMessage(tab.id, { action: "refreshSessions" });
          titleTimestamps.forEach((timestamp) => {
            chrome.tabs.sendMessage(tab.id, {
              action: "titleRegenerated",
              timestamp,
              error: reason
            });
          });
        });
      });
    });
  });
}

/**
 * Check if AI features are available
 * @returns {Promise<boolean>}
 */
async function isAIAvailable() {
  try {
    const response = await browser.runtime.sendNativeMessage(
      "application.id",
      { action: "ping" }
    );
    const available = response?.available === true;
    const reason = response?.reason || null;
    const supported = reason === "macOS 26.0 or later required" ? false : true;
    lastAICheckDetails = {
      available,
      supported,
      reason,
      response
    };
    lastKnownAIAvailability = available;
    debug('[Tabstract BG] AI availability check:', { available, response });

    // Send to list.html for visibility
    chrome.tabs.query({ url: chrome.runtime.getURL("list.html") }, (tabs) => {
      tabs.forEach(tab => {
        chrome.tabs.sendMessage(tab.id, {
          action: "debugLog",
          source: "background",
          message: "AI availability check",
          data: { available, response }
        });
      });
    });

    if (!available) {
      clearAllPendingAIWork('ai-unavailable');
    }

    return available;
  } catch (error) {
    debug("[Tabstract BG] AI not available:", error);
    lastKnownAIAvailability = false;
    lastAICheckDetails = {
      available: false,
      supported: null,
      reason: String(error)
    };

    // Send to list.html for visibility
    chrome.tabs.query({ url: chrome.runtime.getURL("list.html") }, (tabs) => {
      tabs.forEach(tab => {
        chrome.tabs.sendMessage(tab.id, {
          action: "debugLog",
          source: "background",
          message: "AI availability check failed",
          data: { error: String(error) }
        });
      });
    });

    clearAllPendingAIWork('ai-unavailable');
    return false;
  }
}

/**
 * Generate an AI title for a tab collection
 * @param {Array} tabs - Array of tab objects with title and url
 * @returns {Promise<string|null>} Generated title or null if failed
 */
async function generateAITitle(tabs) {
  try {
    // Check if Apple Intelligence is available first
    const aiAvailable = await isAIAvailable();
    if (!aiAvailable) {
      debug('[Tabstract BG] generateAITitle: AI not available');
      chrome.tabs.query({ url: chrome.runtime.getURL("list.html") }, (tabs) => {
        tabs.forEach(tab => {
          chrome.tabs.sendMessage(tab.id, {
            action: "debugLog",
            source: "background",
            message: "generateAITitle: AI not available",
            data: { reason: 'Apple Intelligence not available' }
          });
        });
      });
      return null;
    }

    const tabData = tabs.slice(0, 20).map(tab => ({
      title: tab.title || 'Untitled',
      url: tab.url,
      status: tab.status,
      hints: tab.hints
    }));

    // Get user's language for localized AI prompts
    const userLanguage = getEffectiveLanguage();
    debugWithMessage('generateAITitle: Using language', { language: userLanguage });

    // Use polling architecture (same as categorization)
    const requestId = `ai-title-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    const response = await pollForAIResult(requestId, tabData, 15000, "generateTitle", { language: userLanguage });

    if (!response) {
      debug('[Tabstract BG] generateAITitle: no response from poll (AI may not be working)');

      // Immediately clear all pending AI states
      chrome.storage.local.get(["savedSessions"], (result) => {
        let sessions = result.savedSessions || [];
        let changed = false;

        sessions = sessions.map(session => {
          if (session.pendingCategorization || session.pendingTitle) {
            changed = true;
            const updated = { ...session };
            delete updated.pendingCategorization;
            delete updated.pendingCategorizationStartedAt;
            delete updated.pendingTitle;
            delete updated.pendingTitleStartedAt;
            return updated;
          }
          return session;
        });

        if (changed) {
          chrome.storage.local.set({ savedSessions: sessions }, () => {
            chrome.tabs.query({ url: chrome.runtime.getURL("list.html") }, (tabs) => {
              tabs.forEach(tab => {
                chrome.tabs.sendMessage(tab.id, { action: "refreshSessions" });
              });
            });
          });
        }
      });

      chrome.tabs.query({ url: chrome.runtime.getURL("list.html") }, (tabs) => {
        tabs.forEach(tab => {
          chrome.tabs.sendMessage(tab.id, {
            action: "debugLog",
            source: "background",
            message: "generateAITitle: AI not available",
            data: { reason: 'No response from Apple Intelligence' }
          });
        });
      });
      return null;
    }

    if (response?.error) {
      debug('[Tabstract BG] generateAITitle: response has error:', response.error);

      // Immediately clear all pending AI states
      chrome.storage.local.get(["savedSessions"], (result) => {
        let sessions = result.savedSessions || [];
        let changed = false;

        sessions = sessions.map(session => {
          if (session.pendingCategorization || session.pendingTitle) {
            changed = true;
            const updated = { ...session };
            delete updated.pendingCategorization;
            delete updated.pendingCategorizationStartedAt;
            delete updated.pendingTitle;
            delete updated.pendingTitleStartedAt;
            return updated;
          }
          return session;
        });

        if (changed) {
          chrome.storage.local.set({ savedSessions: sessions }, () => {
            chrome.tabs.query({ url: chrome.runtime.getURL("list.html") }, (tabs) => {
              tabs.forEach(tab => {
                chrome.tabs.sendMessage(tab.id, { action: "refreshSessions" });
              });
            });
          });
        }
      });

      chrome.tabs.query({ url: chrome.runtime.getURL("list.html") }, (tabs) => {
        tabs.forEach(tab => {
          chrome.tabs.sendMessage(tab.id, {
            action: "debugLog",
            source: "background",
            message: "generateAITitle: AI not available",
            data: { reason: `Apple Intelligence error: ${response.error}` }
          });
        });
      });
      return null;
    }

    if (response?.title) {
      return response.title;
    }

    debug('[Tabstract BG] generateAITitle: no title in response (AI may not be working)');

    // Immediately clear all pending AI states
    chrome.storage.local.get(["savedSessions"], (result) => {
      let sessions = result.savedSessions || [];
      let changed = false;

      sessions = sessions.map(session => {
        if (session.pendingCategorization || session.pendingTitle) {
          changed = true;
          const updated = { ...session };
          delete updated.pendingCategorization;
          delete updated.pendingCategorizationStartedAt;
          delete updated.pendingTitle;
          delete updated.pendingTitleStartedAt;
          return updated;
        }
        return session;
      });

      if (changed) {
        chrome.storage.local.set({ savedSessions: sessions }, () => {
          chrome.tabs.query({ url: chrome.runtime.getURL("list.html") }, (tabs) => {
            tabs.forEach(tab => {
              chrome.tabs.sendMessage(tab.id, { action: "refreshSessions" });
            });
          });
        });
      }
    });

    chrome.tabs.query({ url: chrome.runtime.getURL("list.html") }, (tabs) => {
      tabs.forEach(tab => {
        chrome.tabs.sendMessage(tab.id, {
          action: "debugLog",
          source: "background",
          message: "generateAITitle: AI not available",
          data: { reason: 'Apple Intelligence returned no title - may be misconfigured' }
        });
      });
    });
    return null;
  } catch (error) {
    debug('[Tabstract BG] generateAITitle exception:', error);
    chrome.tabs.query({ url: chrome.runtime.getURL("list.html") }, (tabs) => {
      tabs.forEach(tab => {
        chrome.tabs.sendMessage(tab.id, {
          action: "debugLog",
          source: "background",
          message: "generateAITitle: AI not available",
          data: { reason: `Exception: ${String(error)}` }
        });
      });
    });
    return null;
  }
}

/**
 * Categorize tabs into thematic groups
 * @param {Array} tabs - Array of tab objects with title and url
 * @returns {Promise<Object|null>} Object with categories array and hasMore flag, or null if failed
 */
async function categorizeAITabs(tabs) {
  // Two-phase approach: extract themes, then assign all tabs to themes
  try {
    const themes = await extractAIThemes(tabs);
    if (!themes || !Array.isArray(themes) || themes.length === 0) {
      // Fallback to single-call categorization for compatibility
      return await categorizeAITabsSingle(tabs);
    }

    const categories = await assignAITabsToThemes(tabs, themes);
    if (categories && Array.isArray(categories) && categories.length > 0) {
      return { categories, hasMore: false, processedCount: tabs.length };
    }

    // Final fallback
    return await categorizeAITabsSingle(tabs);
  } catch (error) {
    return await categorizeAITabsSingle(tabs);
  }
}

// Extract themes using the native host
async function extractAIThemes(tabs) {
  try {
    const tabData = tabs.map(tab => ({ title: tab.title || 'Untitled', url: tab.url, status: tab.status, hints: tab.hints, ogDescription: tab.ogDescription }));

    // Get user's language for localized AI prompts
    const userLanguage = getEffectiveLanguage();

    // Use polling with tabs data in first poll
    const requestId = `ai-themes-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    const response = await pollForAIResult(requestId, tabData, 15000, "extractThemes", { language: userLanguage });

    if (response?.error) {
      return null;
    }
    return response?.themes || null;
  } catch (e) {
    return null;
  }
}

// Assign tabs to provided themes using the native host
async function assignAITabsToThemes(tabs, themes) {
  try {
    const tabData = tabs.map(tab => ({ title: tab.title || 'Untitled', url: tab.url, status: tab.status, hints: tab.hints, ogDescription: tab.ogDescription }));

    // Get user's language for localized AI prompts
    const userLanguage = getEffectiveLanguage();

    // Use polling with tabs data in first poll, themes in extraData
    const requestId = `ai-assign-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    const response = await pollForAIResult(requestId, tabData, 15000, "assignTabsToThemes", { themes, language: userLanguage });

    if (response?.error) {
      return null;
    }
    return response?.categories || null;
  } catch (e) {
    return null;
  }
}

/**
 * Poll Swift handler for AI result
 * First poll sends tabs data for immediate processing
 */
async function pollForAIResult(requestId, tabData, maxWaitMs, action = "pollResult", extraData = {}) {
  const pollInterval = 300; // Check every 300ms
  const maxAttempts = Math.floor(maxWaitMs / pollInterval);
  let firstError = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      // First poll sends data for processing
      const pollMessage = {
        action: action,
        requestId: requestId,
        ...extraData
      };

      // Include tabs on first poll only
      if (attempt === 0 && tabData) {
        pollMessage.tabs = tabData;

        // Debug: Log how many tabs have descriptions
        const tabsWithDesc = tabData.filter(t => t.ogDescription).length;
        debugWithMessage(`Sending ${tabData.length} tabs to AI, ${tabsWithDesc} have descriptions`, {
          total: tabData.length,
          withDesc: tabsWithDesc,
          examples: tabData.filter(t => t.ogDescription).slice(0, 3).map(t => ({
            title: t.title?.substring(0, 30),
            desc: t.ogDescription?.substring(0, 50)
          }))
        });
      }

      const pollResponse = await browser.runtime.sendNativeMessage("application.id", pollMessage);

      // Log first poll response for debugging
      if (attempt === 0) {
        debug('[Tabstract BG] pollForAIResult first poll response:', {
          action,
          requestId,
          hasResponse: !!pollResponse,
          isPending: pollResponse?.pending,
          hasError: !!pollResponse?.error,
          error: pollResponse?.error
        });
      }

      if (pollResponse && !pollResponse.pending) {
        // Log if we got an error response
        if (pollResponse.error) {
          debug('[Tabstract BG] pollForAIResult error response:', {
            action,
            requestId,
            attempt,
            error: pollResponse.error
          });
        }
        return pollResponse;
      }

      // Still pending, wait and try again
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    } catch (error) {
      // Log first error encountered
      if (!firstError) {
        firstError = error;
        debug('[Tabstract BG] pollForAIResult caught exception:', {
          action,
          requestId,
          attempt,
          error: String(error),
          message: error.message
        });
      }
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }
  }

  // Log timeout
  debug('[Tabstract BG] pollForAIResult timed out:', {
    action,
    requestId,
    maxWaitMs,
    attempts: maxAttempts,
    firstError: firstError ? String(firstError) : null
  });

  return null;
}

/**
 * Batch process large tab sets (50+ tabs)
 */
async function batchCategorizeTabs(tabs, batchSize) {
  const batches = [];
  for (let i = 0; i < tabs.length; i += batchSize) {
    batches.push(tabs.slice(i, i + batchSize));
  }

  // Get user's language for localized AI prompts
  const userLanguage = getEffectiveLanguage();
  debugWithMessage('batchCategorizeTabs: Using language', { language: userLanguage });

  const allCategories = [];
  let processedCount = 0;

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    const batch = batches[batchIndex];
    const batchOffset = batchIndex * batchSize;

    const tabData = batch.map(tab => ({ title: tab.title || 'Untitled', url: tab.url, status: tab.status, hints: tab.hints, ogDescription: tab.ogDescription }));
    const requestId = `ai-categorize-batch${batchIndex}-${Date.now()}-${Math.random().toString(36).substring(7)}`;

    try {
      const response = await pollForAIResult(requestId, tabData, 15000, "pollResult", { language: userLanguage });

      if (response?.categories && Array.isArray(response.categories)) {
        // Adjust tab indices to account for batch offset, filtering out invalid indices
        const adjustedCategories = response.categories.map(cat => ({
          name: cat.name,
          tabIndices: (cat.tabIndices || [])
            .filter(idx => typeof idx === 'number' && idx >= 0 && idx < batch.length)
            .map(idx => idx + batchOffset)
        }));

        allCategories.push(...adjustedCategories);
        processedCount += batch.length;
      }
    } catch (error) {
      // Continue with next batch
    }
  }

  if (allCategories.length === 0) {
    return null;
  }

  return { categories: allCategories, hasMore: false, processedCount: tabs.length };
}

// Backward-compatible single-call categorization
async function categorizeAITabsSingle(tabs) {
  try {
    // Check if Apple Intelligence is available first
    const aiAvailable = await isAIAvailable();
    if (!aiAvailable) {
      const debugInfoNoAI = { reason: 'Apple Intelligence not available' };
      debug('[Tabstract BG] categorizeAITabsSingle: AI not available', debugInfoNoAI);
      chrome.tabs.query({ url: chrome.runtime.getURL("list.html") }, (tabs) => {
        tabs.forEach(tab => {
          chrome.tabs.sendMessage(tab.id, {
            action: "debugLog",
            source: "background",
            message: "categorizeAITabsSingle: AI not available",
            data: debugInfoNoAI
          });
        });
      });
      return null;
    }

    const MAX_TABS = 50;
    const hasMoreTabs = tabs.length > MAX_TABS;

    // If more than 50 tabs, batch process them
    if (hasMoreTabs) {
      return await batchCategorizeTabs(tabs, MAX_TABS);
    }

    const tabData = tabs.slice(0, MAX_TABS).map(tab => ({ title: tab.title || 'Untitled', url: tab.url, status: tab.status, hints: tab.hints, ogDescription: tab.ogDescription }));

    // Get user's language for localized AI prompts
    const userLanguage = getEffectiveLanguage();
    debugWithMessage('categorizeAITabsSingle: Using language', { language: userLanguage });

    // Generate unique request ID
    const requestId = `ai-categorize-${Date.now()}-${Math.random().toString(36).substring(7)}`;

    const debugInfo1 = { requestId, tabCount: tabData.length };
    debug('[Tabstract BG] categorizeAITabsSingle starting poll:', debugInfo1);
    chrome.tabs.query({ url: chrome.runtime.getURL("list.html") }, (tabs) => {
      tabs.forEach(tab => {
        chrome.tabs.sendMessage(tab.id, {
          action: "debugLog",
          source: "background",
          message: "categorizeAITabsSingle starting poll",
          data: debugInfo1
        });
      });
    });

    let response;
    try {
      response = await pollForAIResult(requestId, tabData, 15000, "pollResult", { language: userLanguage });
      const debugInfo2 = { hasResponse: !!response, response: response };
      debug('[Tabstract BG] categorizeAITabsSingle poll response:', debugInfo2);
      chrome.tabs.query({ url: chrome.runtime.getURL("list.html") }, (tabs) => {
        tabs.forEach(tab => {
          chrome.tabs.sendMessage(tab.id, {
            action: "debugLog",
            source: "background",
            message: "categorizeAITabsSingle poll response",
            data: debugInfo2
          });
        });
      });
    } catch (pollError) {
      const debugInfo3 = { error: String(pollError) };
      debug('[Tabstract BG] categorizeAITabsSingle poll error:', debugInfo3);
      chrome.tabs.query({ url: chrome.runtime.getURL("list.html") }, (tabs) => {
        tabs.forEach(tab => {
          chrome.tabs.sendMessage(tab.id, {
            action: "debugLog",
            source: "background",
            message: "categorizeAITabsSingle poll error",
            data: debugInfo3
          });
        });
      });
      return null;
    }

    if (!response) {
      debug('[Tabstract BG] categorizeAITabsSingle: no response from poll (AI may not be working)');

      // Immediately clear all pending AI states since AI isn't working
      chrome.storage.local.get(["savedSessions"], (result) => {
        let sessions = result.savedSessions || [];
        let changed = false;

        sessions = sessions.map(session => {
          if (session.pendingCategorization || session.pendingTitle) {
            changed = true;
            const updated = { ...session };
            delete updated.pendingCategorization;
            delete updated.pendingCategorizationStartedAt;
            delete updated.pendingTitle;
            delete updated.pendingTitleStartedAt;
            return updated;
          }
          return session;
        });

        if (changed) {
          chrome.storage.local.set({ savedSessions: sessions }, () => {
            chrome.tabs.query({ url: chrome.runtime.getURL("list.html") }, (tabs) => {
              tabs.forEach(tab => {
                chrome.tabs.sendMessage(tab.id, { action: "refreshSessions" });
              });
            });
          });
        }
      });

      chrome.tabs.query({ url: chrome.runtime.getURL("list.html") }, (tabs) => {
        tabs.forEach(tab => {
          chrome.tabs.sendMessage(tab.id, {
            action: "debugLog",
            source: "background",
            message: "categorizeAITabsSingle: no response from poll",
            data: { hint: 'AI may be configured incorrectly or unavailable' }
          });
          // Show user notification that AI isn't working
          chrome.tabs.sendMessage(tab.id, {
            action: "debugLog",
            source: "background",
            message: "categorizeAITabsSingle: AI not available",
            data: { reason: 'No response from Apple Intelligence' }
          });
        });
      });
      return null;
    }

    if (response.error) {
      const debugInfo4 = { error: response.error };
      debug('[Tabstract BG] categorizeAITabsSingle: response has error:', debugInfo4);

      // Immediately clear all pending AI states since AI returned an error
      chrome.storage.local.get(["savedSessions"], (result) => {
        let sessions = result.savedSessions || [];
        let changed = false;

        sessions = sessions.map(session => {
          if (session.pendingCategorization || session.pendingTitle) {
            changed = true;
            const updated = { ...session };
            delete updated.pendingCategorization;
            delete updated.pendingCategorizationStartedAt;
            delete updated.pendingTitle;
            delete updated.pendingTitleStartedAt;
            return updated;
          }
          return session;
        });

        if (changed) {
          chrome.storage.local.set({ savedSessions: sessions }, () => {
            chrome.tabs.query({ url: chrome.runtime.getURL("list.html") }, (tabs) => {
              tabs.forEach(tab => {
                chrome.tabs.sendMessage(tab.id, { action: "refreshSessions" });
              });
            });
          });
        }
      });

      chrome.tabs.query({ url: chrome.runtime.getURL("list.html") }, (tabs) => {
        tabs.forEach(tab => {
          chrome.tabs.sendMessage(tab.id, {
            action: "debugLog",
            source: "background",
            message: "categorizeAITabsSingle: response has error",
            data: debugInfo4
          });
          // Show user notification that AI had an error
          chrome.tabs.sendMessage(tab.id, {
            action: "debugLog",
            source: "background",
            message: "categorizeAITabsSingle: AI not available",
            data: { reason: `Apple Intelligence error: ${response.error}` }
          });
        });
      });
      return null;
    }

    if (response.categories && Array.isArray(response.categories) && response.categories.length > 0) {
      const debugInfo5 = { categoryCount: response.categories.length };
      debug('[Tabstract BG] categorizeAITabsSingle: success with', debugInfo5);
      chrome.tabs.query({ url: chrome.runtime.getURL("list.html") }, (tabs) => {
        tabs.forEach(tab => {
          chrome.tabs.sendMessage(tab.id, {
            action: "debugLog",
            source: "background",
            message: "categorizeAITabsSingle: success",
            data: debugInfo5
          });
        });
      });
      return { categories: response.categories, hasMore: hasMoreTabs, processedCount: MAX_TABS };
    }

    const debugInfo6 = { hasCategories: !!response.categories, isArray: Array.isArray(response.categories), length: response.categories?.length };
    debug('[Tabstract BG] categorizeAITabsSingle: no valid categories in response (AI may not be working)', debugInfo6);

    // Immediately clear all pending AI states since AI returned no categories
    chrome.storage.local.get(["savedSessions"], (result) => {
      let sessions = result.savedSessions || [];
      let changed = false;

      sessions = sessions.map(session => {
        if (session.pendingCategorization || session.pendingTitle) {
          changed = true;
          const updated = { ...session };
          delete updated.pendingCategorization;
          delete updated.pendingCategorizationStartedAt;
          delete updated.pendingTitle;
          delete updated.pendingTitleStartedAt;
          return updated;
        }
        return session;
      });

      if (changed) {
        chrome.storage.local.set({ savedSessions: sessions }, () => {
          chrome.tabs.query({ url: chrome.runtime.getURL("list.html") }, (tabs) => {
            tabs.forEach(tab => {
              chrome.tabs.sendMessage(tab.id, { action: "refreshSessions" });
            });
          });
        });
      }
    });

    chrome.tabs.query({ url: chrome.runtime.getURL("list.html") }, (tabs) => {
      tabs.forEach(tab => {
        chrome.tabs.sendMessage(tab.id, {
          action: "debugLog",
          source: "background",
          message: "categorizeAITabsSingle: no valid categories in response",
          data: debugInfo6
        });
        // Show user notification that AI returned empty results
        chrome.tabs.sendMessage(tab.id, {
          action: "debugLog",
          source: "background",
          message: "categorizeAITabsSingle: AI not available",
          data: { reason: 'Apple Intelligence returned no categories - may be misconfigured' }
        });
      });
    });
    return null;
  } catch (e) {
    const debugInfo7 = { exception: String(e), stack: e.stack };
    debug('[Tabstract BG] categorizeAITabsSingle exception:', debugInfo7);
    chrome.tabs.query({ url: chrome.runtime.getURL("list.html") }, (tabs) => {
      tabs.forEach(tab => {
        chrome.tabs.sendMessage(tab.id, {
          action: "debugLog",
          source: "background",
          message: "categorizeAITabsSingle exception",
          data: debugInfo7
        });
      });
    });
    return null;
  }
}

/**
 * Save the given tabList as a new session, then invoke callback.
 * Optionally generates AI titles or categorizes tabs if features are enabled.
 */
function saveSession(tabList, callback) {
  // Process tabs through Smart Groups matching (before AI operations)
  processTabsThroughSmartGroups(tabList, (remainingTabs, matchedTabsByGroup) => {
    continueWithSaveSession(remainingTabs, matchedTabsByGroup, callback);
  });
}

/**
 * Continue with session saving after Smart Groups processing
 */
function continueWithSaveSession(remainingTabs, matchedTabsByGroup, callback) {
    // Log Smart Groups matching results
    if (matchedTabsByGroup.size > 0) {
      let totalMatched = 0;
      matchedTabsByGroup.forEach(tabs => totalMatched += tabs.length);
      debug(`[Smart Groups] Matched ${totalMatched} tabs across ${matchedTabsByGroup.size} group(s)`);
      debug(`[Smart Groups] Continuing with ${remainingTabs.length} unmatched tabs`);
    }

    // If all tabs were matched to Smart Groups, don't create a new session
    if (remainingTabs.length === 0) {
      debug('[Smart Groups] All tabs matched to Smart Groups, not creating new session');
      chrome.storage.local.get(["savedSessions"], (result) => {
        if (callback) callback(result.savedSessions || []);
      });
      return;
    }

    // Continue with remaining tabs through normal session creation flow
    chrome.storage.local.get(["savedSessions", "aiTitleSuggestions", "aiSmartCategorization"], (result) => {
      let sessions = result.savedSessions || [];
      const aiTitleEnabled = !!result.aiTitleSuggestions;
      const aiCategorizationEnabled = !!result.aiSmartCategorization;
      const hasEnoughTabsForCategorization = Array.isArray(remainingTabs) && remainingTabs.length >= 6;
      const hasAnyTabs = Array.isArray(remainingTabs) && remainingTabs.length > 0;
      const wantsCategorize = aiCategorizationEnabled && hasEnoughTabsForCategorization;
      const wantsTitle = aiTitleEnabled && hasAnyTabs && !wantsCategorize;
      const aiOperational = lastKnownAIAvailability !== false;
      const shouldCategorize = aiOperational && wantsCategorize;
      const shouldGenerateTitle = aiOperational && wantsTitle;

      // Save temporary session immediately for instant feedback
      const now = Date.now();
      // Add offset to timestamp so remainder session sorts AFTER smart group sessions
      // Smart groups use offsets 0, 1, 2, etc., so use matchedTabsByGroup.size for remainder
      const timestampOffset = matchedTabsByGroup.size;
      const newSession = {
        timestamp: new Date(now + timestampOffset).toISOString(),
        defaultTitle: buildDefaultSessionTitle(),
        tabs: remainingTabs
      };
      if (shouldCategorize) {
        newSession.pendingCategorization = true;
        newSession.pendingCategorizationStartedAt = now;
      }
      if (shouldGenerateTitle) {
        newSession.pendingTitle = true;
        newSession.pendingTitleStartedAt = now;
      }

      debugWithMessage(`Creating session with ${remainingTabs.length} tabs (categorize: ${shouldCategorize}, title: ${shouldGenerateTitle})`);

      // Insert remainder session at position matchedTabsByGroup.size (after all smart group sessions)
      // Smart group sessions occupy positions 0 through (size - 1), so remainder goes at position size
      sessions.splice(matchedTabsByGroup.size, 0, newSession);

    chrome.storage.local.set({ savedSessions: sessions }, () => {
      if (chrome.runtime.lastError) {
        debug("Error saving session:", chrome.runtime.lastError);
        if (callback) callback(null);
        return;
      }

      // Sync: mark new session dirty
      markSyncDirty('Session', 'session-' + newSession.timestamp, newSession);

      // Increment cumulative session counter for review prompt
      chrome.storage.local.get(["totalSessionsSaved"], (result) => {
        const newCount = (result.totalSessionsSaved || 0) + 1;
        chrome.storage.local.set({ totalSessionsSaved: newCount });
      });

      // Update badge immediately when session is saved
      refreshBadge();

      // Schedule a backup after save
      scheduleBackupAfterSave();

      // Both categorization and title generation work with URLs/domains, so proceed immediately
      // If categorization is enabled and we have 6+ tabs, categorize and split
      // For 1-5 tabs, only run title generation (not enough tabs to categorize meaningfully)
      if (wantsCategorize) {
        // Guard: prevent duplicate concurrent calls
        if (activeCategorizationTimestamps.has(newSession.timestamp)) {
          debugWithMessage(`Categorization already in progress for ${newSession.timestamp}, ignoring duplicate`);
        } else {
          activeCategorizationTimestamps.add(newSession.timestamp);
          // Start categorization immediately
          categorizationInBackground(newSession.timestamp, remainingTabs);
        }
      } else if (wantsTitle) {
        // Guard: prevent duplicate concurrent calls
        if (activeTitleTimestamps.has(newSession.timestamp)) {
          debugWithMessage(`Title generation already in progress for ${newSession.timestamp}, ignoring duplicate`);
        } else {
          activeTitleTimestamps.add(newSession.timestamp);
          // Generate AI title in background if enabled (non-blocking)
          generateAITitleInBackground(newSession.timestamp, remainingTabs);
        }
      }

      if (callback) callback(sessions);
    });
  });
}

/**
 * Categorize tabs in background and replace temporary session with categorized sessions
 */
async function categorizationInBackground(placeholderTimestamp, tabList, isRetry = false) {
  debugWithMessage(`categorizationInBackground called for ${tabList.length} tabs${isRetry ? ' (retry)' : ''}`);

  try {
    // Simple single-pass categorization with 20-second timeout
    const timeoutPromise = new Promise((resolve) =>
      setTimeout(() => resolve({ timeout: true }), 20000)
    );

    const categoriesResult = await Promise.race([
      categorizeAITabsSingle(tabList),  // Back to single-pass - two-phase caused duplication
      timeoutPromise
    ]);

    if (categoriesResult?.timeout) {
      debugWithMessage("categorizationInBackground timed out");
    } else {
      debugWithMessage(`categorizationInBackground got ${categoriesResult?.categories?.length || 0} categories`);
    }

    if (categoriesResult?.timeout) {
      debug('[Tabstract BG] Categorization timed out, generating single title');
      activeCategorizationTimestamps.delete(placeholderTimestamp);
      generateAITitleInBackground(placeholderTimestamp, tabList);
      return;
    }

    if (!categoriesResult || !categoriesResult.categories || categoriesResult.categories.length === 0) {
      debug('[Tabstract BG] Categorization failed or returned no categories, generating single title');
      activeCategorizationTimestamps.delete(placeholderTimestamp);
      generateAITitleInBackground(placeholderTimestamp, tabList);
      return;
    }

    let { categories, hasMore } = categoriesResult;

    // Debug: Log category count from AI
    debugWithMessage(`AI returned ${categories.length} categories for ${tabList.length} tabs`);

    // Retry logic: if 6+ tabs returned 0 or 1 categories, retry once
    if (!isRetry && tabList.length >= 6 && categories.length <= 1) {
      debugWithMessage(`Poor categorization result (${categories.length} categories for ${tabList.length} tabs), retrying once`);
      return await categorizationInBackground(placeholderTimestamp, tabList, true);
    }

    // Validate no duplicate tab indices across categories
    const allIndices = [];
    categories.forEach(cat => {
      if (cat.tabIndices) {
        allIndices.push(...cat.tabIndices);
      }
    });
    // Process categories with simplified limit enforcement
    const originalCount = categories.length;
    categories = enforceCategoryLimits(categories, tabList);
    if (categories.length !== originalCount) {
      debugWithMessage(`Category limit enforcement reduced ${originalCount} to ${categories.length}`);
    }

    // Simple validation: if we end up with 1 category, use it as the title
    if (categories.length === 1 && !hasMore) {
      const singleTitle = categories[0].name;
      debugWithMessage(`Only 1 category (${categories[0].tabIndices?.length}/${tabList.length} tabs), using as title instead`);
      activeCategorizationTimestamps.delete(placeholderTimestamp);
      replacePlaceholderWithTitledSession(placeholderTimestamp, singleTitle);
      return;
    }

    // Multiple categories - replace placeholder with categorized sessions
    chrome.storage.local.get(["savedSessions"], (result) => {
      let sessions = result.savedSessions || [];

      // Find the placeholder session
      const placeholderIndex = sessions.findIndex(s => s.timestamp === placeholderTimestamp);

      if (placeholderIndex === -1) {
        debugWithMessage("Placeholder session not found, aborting categorization");
        activeCategorizationTimestamps.delete(placeholderTimestamp);
        return;
      }

      // Remove placeholder
      sessions.splice(placeholderIndex, 1);

      // Track which tabs have been assigned
      const assignedIndices = new Set();

      // Create categorized sessions
      const timestamp = placeholderTimestamp;
      const newSessions = [];

      for (let i = 0; i < categories.length; i++) {
        const category = categories[i];

        const categoryTabs = (category.tabIndices || [])
          .filter(index => {
            // Skip invalid indices (not a number, negative, or out of bounds)
            if (typeof index !== 'number' || index < 0 || index >= tabList.length) {
              return false;
            }
            // Skip if already assigned (prevent duplication)
            if (assignedIndices.has(index)) {
              return false;
            }
            assignedIndices.add(index);
            return true;
          })
          .map(index => tabList[index])
          .filter(Boolean);

        if (categoryTabs.length > 0) {
          const newSession = {
            timestamp: new Date(Date.parse(timestamp) + i).toISOString(), // Slightly offset timestamps
            defaultTitle: buildDefaultSessionTitle(),
            customName: category.name,
            aiGenerated: true,
            tabs: categoryTabs
          };

          newSessions.push(newSession);
        }
      }

      // Check for unassigned tabs (either not categorized by AI or beyond limit)
      // Also filter out any null/undefined entries that might exist in tabList (defensive)
      const unassignedTabs = tabList.filter((tab, index) => tab != null && !assignedIndices.has(index));
      if (unassignedTabs.length > 0) {
        const totalTabs = tabList.length;
        const unassignedCount = unassignedTabs.length;
        const unassignedRatio = unassignedCount / totalTabs;

        // ABORT categorization only if AI truly failed (couldn't categorize majority of tabs)
        if (unassignedRatio >= 0.5) {
          debugWithMessage(`Too many unassigned tabs (${unassignedCount}/${totalTabs}), aborting categorization`);
          activeCategorizationTimestamps.delete(placeholderTimestamp);
          generateAITitleInBackground(placeholderTimestamp, tabList);
          return;
        }

        // AI succeeded at categorizing most tabs, but some are unassigned
        // NEVER drop tabs - always save them in a Miscellaneous session
        const label = hasMore ? "Overflow" : "Miscellaneous";
        const sessionTimestamp = new Date(Date.parse(timestamp) + newSessions.length);

        // Format datetime as "Mon Oct 13 10:44 PM" for Miscellaneous sessions
        const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
        const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
        const dayOfWeek = dayNames[sessionTimestamp.getDay()];
        const month = monthNames[sessionTimestamp.getMonth()];
        const day = sessionTimestamp.getDate();
        let hours = sessionTimestamp.getHours();
        const ampm = hours >= 12 ? 'PM' : 'AM';
        hours = hours % 12 || 12;
        const minutes = sessionTimestamp.getMinutes().toString().padStart(2, '0');
        const dateTimeStr = `${dayOfWeek} ${month} ${day} ${hours}:${minutes} ${ampm}`;

        const uncategorizedSession = {
          timestamp: sessionTimestamp.toISOString(),
          defaultTitle: buildDefaultSessionTitle(),
          customName: `${label} - ${dateTimeStr}`,
          aiGenerated: false,
          tabs: unassignedTabs
        };
        newSessions.push(uncategorizedSession);
        debug('[Tabstract BG] Created', label, 'session for', unassignedCount, 'unassigned tabs');
      }

      // Insert categorized sessions where placeholder was
      sessions.splice(placeholderIndex, 0, ...newSessions);

      debugWithMessage(`Saving ${newSessions.length} categorized sessions`);

      chrome.storage.local.set({ savedSessions: sessions }, () => {
        // Cleanup and notify
        activeCategorizationTimestamps.delete(placeholderTimestamp);

        // Notify list.html to refresh with animation
        chrome.tabs.query({ url: chrome.runtime.getURL("list.html") }, (tabs) => {
          tabs.forEach(tab => {
            chrome.tabs.sendMessage(tab.id, {
              action: "categorizationComplete",
              placeholderTimestamp: placeholderTimestamp,
              newTimestamps: newSessions.map(s => s.timestamp)
            });
          });
        });
      });
    });

  } catch (error) {
    debug('[Tabstract BG] Categorization exception, generating single title:', error);
    activeCategorizationTimestamps.delete(placeholderTimestamp);
    generateAITitleInBackground(placeholderTimestamp, tabList);
  }
}

// Sizing heuristic: limit category count based on total tabs
function suggestMaxGroups(total) {
  if (total <= 3) return 1;
  if (total <= 6) return 2;
  if (total <= 10) return 3;
  return 4;
}

// Simplified category limit enforcement - trust AI's categorization more
function enforceCategoryLimits(categories, tabList) {
  try {
    const total = tabList.length;
    if (!Array.isArray(categories) || categories.length === 0) return categories;

    // Only intervene if we have an excessive number of categories (>10)
    // This rarely happens with the improved prompts
    if (categories.length <= 10) {
      return categories;
    }

    // Too many categories: keep the 8 largest, let unassigned tabs logic handle the rest
    const sorted = categories.slice().sort((a, b) => (b.tabIndices?.length||0) - (a.tabIndices?.length||0));
    return sorted.slice(0, 8);
  } catch (e) {
    return categories;
  }
}

// Remove pending flags that have been stuck too long
function cleanupStuckCategorization(maxAgeMs = 120000) { // 2 minutes
  chrome.storage.local.get(["savedSessions"], (result) => {
    let sessions = result.savedSessions || [];
    let changed = false;
    const now = Date.now();
    sessions.forEach(s => {
      if (s.pendingCategorization) {
        const started = typeof s.pendingCategorizationStartedAt === 'number' ? s.pendingCategorizationStartedAt : 0;
        if (!started || (now - started) > maxAgeMs) {
          delete s.pendingCategorization;
          delete s.pendingCategorizationStartedAt;
          changed = true;
        }
      }
    });
    if (changed) {
      chrome.storage.local.set({ savedSessions: sessions }, () => {
        // Notify list.html to refresh
        chrome.tabs.query({ url: chrome.runtime.getURL("list.html") }, (tabs) => {
          tabs.forEach(tab => chrome.tabs.sendMessage(tab.id, { action: "refreshSessions" }));
        });
      });
    }
  });
}

/**
 * Remove pending categorization flag from a session
 */
function removePendingCategorizationFlag(timestamp) {
  chrome.storage.local.get(["savedSessions"], (result) => {
    let sessions = result.savedSessions || [];
    const session = sessions.find(s => s.timestamp === timestamp);

    if (session && session.pendingCategorization) {
      delete session.pendingCategorization;
      delete session.pendingCategorizationStartedAt;
      chrome.storage.local.set({ savedSessions: sessions }, () => {
        // Notify list.html to refresh (remove pulse animation)
        chrome.tabs.query({ url: chrome.runtime.getURL("list.html") }, (tabs) => {
          tabs.forEach(tab => {
            chrome.tabs.sendMessage(tab.id, {
              action: "refreshSessions"
            });
          });
        });
      });
    }
  });
}

/**
 * Replace placeholder with a single titled session (when only 1 category)
 */
function replacePlaceholderWithTitledSession(timestamp, title) {
  chrome.storage.local.get(["savedSessions"], (result) => {
    let sessions = result.savedSessions || [];
    const session = sessions.find(s => s.timestamp === timestamp);

    if (session) {
      session.customName = title;
      session.aiGenerated = true;
      delete session.pendingCategorization;
      delete session.pendingCategorizationStartedAt;

      chrome.storage.local.set({ savedSessions: sessions }, () => {
        // Notify list.html to refresh
        chrome.tabs.query({ url: chrome.runtime.getURL("list.html") }, (tabs) => {
          tabs.forEach(tab => {
            chrome.tabs.sendMessage(tab.id, {
              action: "refreshSessions"
            });
          });
        });
      });
    }
  });
}


/**
 * Process queued title updates sequentially to prevent race conditions
 */
function processNextTitleUpdate() {
  if (titleUpdateProcessing || titleUpdateQueue.length === 0) {
    return;
  }

  titleUpdateProcessing = true;
  const { sessionTimestamp, aiTitle } = titleUpdateQueue.shift();

  debugWithMessage("processNextTitleUpdate processing", { timestamp: sessionTimestamp, title: aiTitle, queueLength: titleUpdateQueue.length });

  chrome.storage.local.get(["savedSessions"], (result) => {
    let sessions = result.savedSessions || [];
    const sessionIndex = sessions.findIndex(s => s.timestamp === sessionTimestamp);

    debugWithMessage("processNextTitleUpdate found session", {
      timestamp: sessionTimestamp,
      sessionIndex,
      foundSession: sessionIndex !== -1,
      sessionDefaultTitle: sessionIndex !== -1 ? sessions[sessionIndex].defaultTitle : null
    });

    if (sessionIndex !== -1) {
      sessions[sessionIndex].customName = aiTitle;
      sessions[sessionIndex].aiGenerated = true;
      delete sessions[sessionIndex].pendingCategorization;
      delete sessions[sessionIndex].pendingCategorizationStartedAt;
      delete sessions[sessionIndex].pendingTitle;
      delete sessions[sessionIndex].pendingTitleStartedAt;

      debugWithMessage("processNextTitleUpdate saving", { timestamp: sessionTimestamp, title: aiTitle, sessionIndex });

      chrome.storage.local.set({ savedSessions: sessions }, () => {
        // Cleanup and notify
        activeTitleTimestamps.delete(sessionTimestamp);

        // Notify UI with specific session update
        chrome.tabs.query({ url: chrome.runtime.getURL("list.html") }, (tabs) => {
          tabs.forEach(tab => {
            chrome.tabs.sendMessage(tab.id, {
              action: "titleRegenerated",
              timestamp: sessionTimestamp,
              title: aiTitle
            });
          });
        });

        // Process next update in queue
        titleUpdateProcessing = false;
        processNextTitleUpdate();
      });
    } else {
      // Session not found, skip and process next
      titleUpdateProcessing = false;
      processNextTitleUpdate();
    }
  });
}

/**
 * Queue a title update to be processed sequentially
 */
function queueTitleUpdate(sessionTimestamp, aiTitle) {
  debugWithMessage("queueTitleUpdate called", { timestamp: sessionTimestamp, title: aiTitle });
  titleUpdateQueue.push({ sessionTimestamp, aiTitle });
  processNextTitleUpdate();
}

/**
 * Generate AI title in background and update the session when ready
 * (Used when manually regenerating titles, not during initial save)
 */
async function generateAITitleInBackground(sessionTimestamp, tabList) {
  const debugInfo1 = {
    timestamp: sessionTimestamp,
    tabCount: tabList.length,
    firstTabTitle: tabList[0]?.title,
    firstTabUrl: tabList[0]?.url
  };
  debugWithMessage("generateAITitleInBackground called", debugInfo1);

  try {
    const aiAvailableNow = await isAIAvailable();
    if (!aiAvailableNow) {
      debug('[Tabstract BG] Title generation aborted - AI unavailable');
      activeTitleTimestamps.delete(sessionTimestamp);
      clearPendingTitleFlag(sessionTimestamp);
      chrome.tabs.query({ url: chrome.runtime.getURL("list.html") }, (tabs) => {
        tabs.forEach(tab => {
          chrome.tabs.sendMessage(tab.id, {
            action: "titleRegenerated",
            timestamp: sessionTimestamp,
            error: 'ai-unavailable'
          });
        });
      });
      return;
    }

    setPendingTitleFlag(sessionTimestamp);
    notifyTitleGenerationState(sessionTimestamp, 'started');
    const aiTitle = await generateAITitle(tabList);

    const debugInfo2 = {
      success: !!aiTitle,
      title: aiTitle
    };
    debugWithMessage("generateAITitle result", debugInfo2);

    if (aiTitle) {
      // Queue the update to prevent race conditions when multiple titles are being generated
      queueTitleUpdate(sessionTimestamp, aiTitle);
    } else {
      activeTitleTimestamps.delete(sessionTimestamp);
      clearPendingTitleFlag(sessionTimestamp);
      // Notify UI to stop spinner
      chrome.tabs.query({ url: chrome.runtime.getURL("list.html") }, (tabs) => {
        tabs.forEach(tab => {
          chrome.tabs.sendMessage(tab.id, {
            action: "titleRegenerated",
            timestamp: sessionTimestamp,
            error: 'failed'
          });
        });
      });
    }
  } catch (error) {
    activeTitleTimestamps.delete(sessionTimestamp);
    clearPendingTitleFlag(sessionTimestamp);
    // Notify UI to stop spinner
    chrome.tabs.query({ url: chrome.runtime.getURL("list.html") }, (tabs) => {
      tabs.forEach(tab => {
        chrome.tabs.sendMessage(tab.id, {
          action: "titleRegenerated",
          timestamp: sessionTimestamp,
          error: 'exception'
        });
      });
    });
  }
}

function notifyTitleGenerationState(sessionTimestamp, state) {
  if (!sessionTimestamp) return;
  chrome.tabs.query({ url: chrome.runtime.getURL("list.html") }, (tabs) => {
    tabs.forEach(tab => {
      chrome.tabs.sendMessage(tab.id, {
        action: "titleGenerationState",
        timestamp: sessionTimestamp,
        state
      });
    });
  });
}

function setPendingTitleFlag(sessionTimestamp) {
  if (!sessionTimestamp || lastKnownAIAvailability === false) return;
  chrome.storage.local.get(["savedSessions"], (result) => {
    let sessions = result.savedSessions || [];
    const sessionIndex = sessions.findIndex(s => s.timestamp === sessionTimestamp);
    if (sessionIndex === -1) return;
    if (sessions[sessionIndex].pendingTitle) return;
    sessions[sessionIndex].pendingTitle = true;
    sessions[sessionIndex].pendingTitleStartedAt = Date.now();
    chrome.storage.local.set({ savedSessions: sessions }, () => {});
  });
}

function clearPendingTitleFlag(sessionTimestamp) {
  if (!sessionTimestamp) return;
  chrome.storage.local.get(["savedSessions"], (result) => {
    let sessions = result.savedSessions || [];
    const sessionIndex = sessions.findIndex(s => s.timestamp === sessionTimestamp);
    if (sessionIndex === -1) return;
    if (!sessions[sessionIndex].pendingTitle) return;
    delete sessions[sessionIndex].pendingTitle;
    delete sessions[sessionIndex].pendingTitleStartedAt;
    chrome.storage.local.set({ savedSessions: sessions }, () => {});
  });
}

/**
 * Re-use an existing list.html if open; otherwise create new, then update with the new sessions.
 * If a second argument (tabList) is provided, close the original tabs after updating.
 * If closeAllWindows is true, closes tabs across all windows instead of just current window.
 */
function openOrFocusListTab(sessions, tabList, closeAllWindows = false) {
  chrome.tabs.query({ url: chrome.runtime.getURL("list.html") }, (tabs) => {
    if (tabs && tabs.length > 0) {
      const existingTab = tabs[0];
      chrome.tabs.update(existingTab.id, { active: true }, () => {
        chrome.tabs.sendMessage(existingTab.id, {
          action: "setTabList",
          savedSessions: sessions
        });
        if (tabList) {
          setTimeout(() => {
            closeOriginalTabs(existingTab.id, tabList, closeAllWindows);
          }, 100);
        }
      });
    } else {
      openListTab(sessions, tabList, closeAllWindows);
    }
  });
}

/**
 * Create a new list.html tab and update it with sessions.
 * If tabList is provided, close the original tabs after updating.
 * If closeAllWindows is true, closes tabs across all windows instead of just current window.
 */
function openListTab(sessions, tabList, closeAllWindows = false) {
  chrome.tabs.create({ url: chrome.runtime.getURL("list.html") }, (newTab) => {
    chrome.tabs.onUpdated.addListener(function listener(tabId, changeInfo) {
      if (tabId === newTab.id && changeInfo.status === "complete") {
        chrome.tabs.sendMessage(newTab.id, { action: "setTabList", savedSessions: sessions });
        if (tabList) {
          setTimeout(() => {
            closeOriginalTabs(newTab.id, tabList, closeAllWindows);
          }, 100);
        }
        chrome.tabs.onUpdated.removeListener(listener);
      }
    });
  });
}

/**
 * Close the original tabs (except the newly opened list.html).
 * If closeAllWindows is true, closes tabs across all windows instead of just current window.
 */
function closeOriginalTabs(newTabId, savedTabList, closeAllWindows = false) {
  chrome.storage.local.get(["pinnedTabs"], (res) => {
    const skipPinned = !!res.pinnedTabs;

    const savedIds = new Set();
    for (const item of savedTabList) {
      if (Array.isArray(item.allIds)) {
        item.allIds.forEach((tabId) => savedIds.add(tabId));
      } else if (typeof item.id === 'number') {
        savedIds.add(item.id);
      }
    }

    debugWithMessage("closeOriginalTabs", {
      newTabId,
      closeAllWindows,
      savedTabListCount: savedTabList.length,
      savedIdsCount: savedIds.size,
      savedIds: Array.from(savedIds)
    });

    // Query all windows if closeAllWindows is true, otherwise just current window
    const queryOptions = closeAllWindows ? {} : { currentWindow: true };

    chrome.tabs.query(queryOptions, (tabs) => {
      const tabsToClose = [];

      debugWithMessage("closeOriginalTabs - found tabs", {
        totalTabs: tabs.length,
        tabDetails: tabs.map(t => ({ id: t.id, url: t.url, pinned: t.pinned }))
      });

      tabs.forEach(t => {
        if (t.id === newTabId) return;
        if (skipPinned && t.pinned) return;
        if (savedIds.has(t.id)) {
          tabsToClose.push(t.id);
        }
      });

      debugWithMessage("closeOriginalTabs - will close", {
        tabsToCloseCount: tabsToClose.length,
        tabsToClose
      });

      if (tabsToClose.length > 0) {
        chrome.tabs.remove(tabsToClose, () => {
          // Add delay to ensure Safari fully removes tabs before cleanup runs
          // The callback fires when API accepts the removal, not when tabs are gone
          setTimeout(() => {
            cleanupEmptyWindows();
          }, 500);
        });
      } else {
        // Still run cleanup even if no tabs to close (might have empty windows)
        cleanupEmptyWindows();
      }
    });
  });
}

/**
 * Clean up empty windows after save operations
 * Rules:
 * 1. If window has no tabs left AND Tabstract is not open → close window
 * 2. If window has only Tabstract tabs AND Tabstract is also open elsewhere → close all but one
 */
function cleanupEmptyWindows() {
  chrome.windows.getAll({ populate: true }, (windows) => {
    const extensionPageUrls = getExtensionPageUrls();

    debugWithMessage("cleanupEmptyWindows checking windows", {
      totalWindows: windows.length,
      windowDetails: windows.map(w => ({
        id: w.id,
        focused: w.focused,
        tabCount: w.tabs?.length || 0,
        tabs: w.tabs?.map(t => ({ url: t.url }))
      }))
    });

    // Categorize windows
    const windowsWithOnlyTabstract = [];
    const emptyWindows = [];

    windows.forEach(win => {
      if (!win.tabs || win.tabs.length === 0) {
        emptyWindows.push(win.id);
        return;
      }

      const hasTabstractTab = win.tabs.some(tab =>
        extensionPageUrls.some(url => tab.url && tab.url.startsWith(url))
      );

      const hasNonTabstractTabs = win.tabs.some(tab =>
        !extensionPageUrls.some(url => tab.url && tab.url.startsWith(url))
      );

      // Window has only Tabstract pages
      if (hasTabstractTab && !hasNonTabstractTabs) {
        windowsWithOnlyTabstract.push(win);
      }
      // Window is empty (no tabs at all)
      else if (!hasTabstractTab && !hasNonTabstractTabs) {
        emptyWindows.push(win.id);
      }
    });

    debugWithMessage("cleanupEmptyWindows categorized", {
      emptyWindows: emptyWindows.length,
      windowsWithOnlyTabstract: windowsWithOnlyTabstract.length,
      windowsWithOnlyTabstractIds: windowsWithOnlyTabstract.map(w => ({ id: w.id, focused: w.focused }))
    });

    // Close all empty windows
    emptyWindows.forEach(winId => {
      debugWithMessage("Closing empty window", { winId });
      chrome.windows.remove(winId);
    });

    // If multiple windows have only Tabstract, close all but one (keep the focused one, or first)
    if (windowsWithOnlyTabstract.length > 1) {
      // Find focused window or use first one
      const focusedWin = windowsWithOnlyTabstract.find(w => w.focused);
      const keepWindow = focusedWin || windowsWithOnlyTabstract[0];

      debugWithMessage("Multiple Tabstract-only windows found", {
        total: windowsWithOnlyTabstract.length,
        keeping: keepWindow.id,
        keepingIsFocused: keepWindow.focused
      });

      windowsWithOnlyTabstract.forEach(win => {
        if (win.id !== keepWindow.id) {
          debugWithMessage("Closing extra Tabstract-only window", { winId: win.id });
          chrome.windows.remove(win.id);
        }
      });
    }
  });
}

/**
 * Update all open list.html tabs with the latest sessions.
 */
function updateListHtmlTabs(sessions) {
  chrome.tabs.query({ url: chrome.runtime.getURL("list.html") }, (tabs) => {
    tabs.forEach(t => {
      chrome.tabs.sendMessage(t.id, {
        action: "setTabList",
        savedSessions: sessions
      });
    });
  });
}

/**
 * Notify open list pages that a session was deleted.
 */
function notifySessionDeleted(deleteId, deletedSession) {
  chrome.tabs.query({ url: chrome.runtime.getURL("list.html") }, (tabs) => {
    tabs.forEach(t => {
      chrome.tabs.sendMessage(t.id, {
        action: "sessionDeleted",
        deleteId,
        deletedSession
      });
    });
  });
}

/**
 * Notify open list pages that a session was restored.
 */
function notifySessionRestored(deleteId) {
  chrome.tabs.query({ url: chrome.runtime.getURL("list.html") }, (tabs) => {
    tabs.forEach(t => {
      chrome.tabs.sendMessage(t.id, {
        action: "sessionRestored",
        deleteId
      });
    });
  });
}

/**
 * Initialize badge appearance settings
 */
function initializeBadge() {
  try {
    // Load accent color from storage and apply to badge
    chrome.storage.local.get(['accentColor'], (result) => {
      const color = result.accentColor || '#007AFF';
      chrome.action.setBadgeBackgroundColor({ color: color });
      if (chrome.action.setBadgeTextColor) {
        chrome.action.setBadgeTextColor({ color: '#FFFFFF' });
      }
    });
  } catch (e) {
  }
}

/**
 * Update the badge background color
 */
function updateBadgeColor(color) {
  try {
    chrome.action.setBadgeBackgroundColor({ color: color || '#007AFF' });
  } catch (e) {
  }
}

/**
 * Update the toolbar badge text based on user settings & stored sessions.
 */
function updateBadge() {
  chrome.storage.local.get(["savedSessions", "badgeSnoozeUntil", "enableBadge"], (result) => {
    const sessions = (result.savedSessions || []).filter(s => s.tabs && s.tabs.length > 0);
    const snoozeUntil = result.badgeSnoozeUntil || 0;
    const now = Date.now();
    const enableBadge = (typeof result.enableBadge === "boolean") ? result.enableBadge : true;
    if (!enableBadge || now < snoozeUntil) {
      chrome.action.setBadgeText({ text: "" });
      return;
    }
    const badgeText = sessions.length > 0 ? String(sessions.length) : "";
    chrome.action.setBadgeText({ text: badgeText });
  });
}

let badgeUpdateTimeout = null;

function refreshBadge() {
  // Debounce badge updates to prevent race conditions
  if (badgeUpdateTimeout) {
    clearTimeout(badgeUpdateTimeout);
  }
  badgeUpdateTimeout = setTimeout(() => {
    updateBadge();
    badgeUpdateTimeout = null;
  }, 50);
}

// ---------- Badge robustness helpers ----------
function wireBadgeReactivity() {
  if (wireBadgeReactivity._wired) return; // idempotent
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.savedSessions || changes.badgeSnoozeUntil || changes.enableBadge) {
      updateBadge();
    } else {
    }
  });
  // Fallback: when user activates a tab or focuses a window, re-check snooze expiry
  chrome.tabs.onActivated.addListener(() => maybeCheckUnsnooze());
  chrome.windows.onFocusChanged.addListener(() => maybeCheckUnsnooze());
  // Wake the badge when snooze expires
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm && alarm.name === 'badgeUnsnooze') {
      updateBadge();
    } else if (alarm && alarm.name === 'trashCleanup') {
      cleanupExpiredTrash();
    } else if (alarm && alarm.name === 'hourlyBackup') {
      createBackup('scheduled');
    } else if (alarm && alarm.name === 'catchUpBackup') {
      createBackup('scheduled');
    } else if (alarm && alarm.name === SYNC_ALARM_NAME) {
      executeSyncPull(() => executeSyncPush());
    } else if (alarm && alarm.name === SYNC_PUSH_DEBOUNCE_ALARM) {
      executeSyncPush();
    } else if (alarm && alarm.name === 'syncStartupPull') {
      chrome.storage.local.get(['icloudSyncEnabled'], (r) => {
        if (r.icloudSyncEnabled) executeSyncPull();
      });
    }
  });
  wireBadgeReactivity._wired = true;
}

function scheduleUnsnoozeAlarm(snoozeUntil) {
  try { chrome.alarms.clear('badgeUnsnooze'); } catch (e) {}
  const now = Date.now();
  if (snoozeUntil && snoozeUntil > now) {
    chrome.alarms.create('badgeUnsnooze', { when: snoozeUntil });
  }
}

function primeUnsnoozeAlarm() {
  chrome.storage.local.get(['badgeSnoozeUntil'], (res) => {
    scheduleUnsnoozeAlarm(res.badgeSnoozeUntil || 0);
  });
}

/**
 * Schedule the trash cleanup alarm to run daily
 */
function scheduleTrashCleanup() {
  try { chrome.alarms.clear('trashCleanup'); } catch (e) {}
  chrome.alarms.create('trashCleanup', {
    delayInMinutes: 1,           // Run soon after startup
    periodInMinutes: 24 * 60     // Then every 24 hours
  });
}

function maybeCheckUnsnooze() {
  chrome.storage.local.get(['badgeSnoozeUntil', 'enableBadge'], (res) => {
    const enableBadge = (typeof res.enableBadge === 'boolean') ? res.enableBadge : true;
    if (!enableBadge) return;
    const snoozeUntil = res.badgeSnoozeUntil || 0;
    if (snoozeUntil && Date.now() >= snoozeUntil) {
      // Clear snooze and refresh badge immediately
      chrome.storage.local.set({ badgeSnoozeUntil: 0 }, () => {
        try { chrome.alarms.clear('badgeUnsnooze'); } catch (e) {}
        updateBadge();
      });
    }
  });
}

// =============================
// iCloud Sync System
// =============================

/**
 * Run a storage operation, deferring it if a sync merge is in progress.
 * Returns true if the operation was deferred.
 */
function runOrDeferSyncWrite(operation) {
  if (_syncMergeInProgress) {
    _syncDeferredWrites.push(operation);
    return true;
  }
  operation();
  return false;
}

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

/**
 * Get the best-known local modification time for LWW comparison.
 * Checks the dirty map first (which has the actual edit timestamp),
 * then falls back to _syncModifiedAt on the stored record.
 * This prevents stale _syncModifiedAt from causing remote to incorrectly
 * win LWW against records that were locally edited but not yet pushed.
 */
function getLocalModifiedMs(local, recordName) {
  const dirtyEntry = _syncDirtyRecords.get(recordName);
  if (dirtyEntry && dirtyEntry.modifiedAt) {
    return normalizeSyncTimestamp(dirtyEntry.modifiedAt);
  }
  return normalizeSyncTimestamp(local._syncModifiedAt || local.timestamp);
}

/**
 * Check if a local record should get a conflict copy when remote wins LWW.
 * Only create conflict copies for records actually modified locally.
 */
function shouldCreateConflictCopy(local, recordName) {
  if (local._syncConflict) return false;
  // Only create conflict copy if the record has pending local changes not yet pushed
  if (_syncDirtyRecords.has(recordName)) return true;
  return false;
}

/**
 * Classify a sync record by its canonical type.
 * Primary: recordName prefix (set by our code, trustworthy).
 * Secondary: payload shape catches misrouted edge cases.
 * Returns 'Session' | 'Template' | 'SmartGroup' | 'TrashedLink' | null.
 */
function classifyRecord(recordName, payload) {
  if (!recordName || typeof recordName !== 'string') return null;
  if (recordName.startsWith('session-')) {
    // A session-prefixed record that's structurally a trashed link (no tabs, has trashedAt)
    if (payload && !Array.isArray(payload.tabs) &&
        (payload.trashedAt || payload.expiresAt)) {
      return 'TrashedLink';
    }
    // A session-prefixed record that's structurally a template (has template id or name field)
    if (payload && typeof payload.id === 'string' && payload.id.startsWith('template-')) {
      return 'Template';
    }
    return 'Session';
  }
  if (recordName.startsWith('template-')) {
    // Real templates must have a tabs array
    if (payload && !Array.isArray(payload.tabs)) return null;
    return 'Template';
  }
  if (recordName.startsWith('smartgroup-')) {
    // Shape-first: reject records that are structurally a different type
    if (payload) {
      if (!Array.isArray(payload.tabs) && (payload.trashedAt || payload.expiresAt)) return 'TrashedLink';
      if (typeof payload.id === 'string' && payload.id.startsWith('template-')) return 'Template';
      if (payload.timestamp && Array.isArray(payload.tabs) && !payload.patterns) return 'Session';
    }
    return 'SmartGroup';
  }
  if (recordName.startsWith('trash-'))      return 'TrashedLink';
  return null;
}

/**
 * Mark a record as dirty for sync push.
 * Per-record _syncMergedRecordNames guard prevents merge→dirty→push→pull loops.
 * The onChanged listener has the same guard; this one catches explicit calls
 * from action handlers during the post-merge window.
 */
let _syncDirtyPersistTimeout = null;
function markSyncDirty(recordType, recordName, payload, isDeleted = false) {
  if (_syncMergedRecordNames.has(recordName)) {
    return; // Record was just written by merge — don't re-dirty
  }
  chrome.storage.local.get(['icloudSyncEnabled'], (result) => {
    if (!result.icloudSyncEnabled) return;
    _syncDirtyRecords.set(recordName, {
      recordType,
      recordName,
      payload: isDeleted ? {} : payload,
      modifiedAt: new Date().toISOString(),
      isDeleted
    });
    // Debounce persistence — don't write the full map on every single dirty mark
    if (!_syncDirtyPersistTimeout) {
      _syncDirtyPersistTimeout = setTimeout(() => {
        _syncDirtyPersistTimeout = null;
        chrome.storage.local.set({ _syncDirtyRecords: Object.fromEntries(_syncDirtyRecords) });
      }, 1000);
    }
    scheduleSyncPush();
  });
}

/**
 * Mark a record as deleted (tombstone) for sync push.
 */
function markSyncDeleted(recordType, recordName) {
  markSyncDirty(recordType, recordName, {}, true);
}

/**
 * Immediately flush dirty records to storage and schedule a sync push.
 * Called by UI pages (popup, list) after storage writes to ensure pending
 * changes survive service-worker suspension — critical on iOS.
 */
function flushSyncDirtyAndPush() {
  if (_syncDirtyPersistTimeout) {
    clearTimeout(_syncDirtyPersistTimeout);
    _syncDirtyPersistTimeout = null;
  }
  if (_syncDirtyRecords.size > 0) {
    chrome.storage.local.set({ _syncDirtyRecords: Object.fromEntries(_syncDirtyRecords) });
  }
  scheduleSyncPush();
}

/**
 * Schedule a debounced sync push.
 */
function scheduleSyncPush() {
  // In-memory debounce for responsiveness (2s)
  if (_syncPushTimeout) clearTimeout(_syncPushTimeout);
  _syncPushTimeout = setTimeout(() => {
    _syncPushTimeout = null;
    executeSyncPush();
  }, SYNC_DEBOUNCE_MS);
  // Alarm-based safety net in case page is killed before setTimeout fires
  try { chrome.alarms.clear(SYNC_PUSH_DEBOUNCE_ALARM); } catch (e) {}
  chrome.alarms.create(SYNC_PUSH_DEBOUNCE_ALARM, { delayInMinutes: 1 });
}

/**
 * Execute sync push: drain dirty map and send to CloudKit via native messaging.
 */
function broadcastSyncState(syncing) {
  chrome.runtime.sendMessage({ action: "syncStateChanged", syncing: syncing }).catch(() => {});
}

function executeSyncPush() {
  if (_syncPushInProgress) {
    // Break stale locks — if push has been "in progress" for over 30s, the
    // native message promise likely never resolved (crash, page suspension).
    if (Date.now() - _syncPushLockedAt > SYNC_LOCK_TIMEOUT_MS) {
      debug('[Sync] Push lock stale (held for', Date.now() - _syncPushLockedAt, 'ms), breaking');
      _syncPushInProgress = false;
    } else {
      if (_syncDirtyRecords.size > 0) _syncPushDeferred = true;
      return;
    }
  }
  if (_syncDirtyRecords.size === 0) return;
  _syncPushInProgress = true;
  _syncPushLockedAt = Date.now();

  const records = Array.from(_syncDirtyRecords.values());
  // Clear in-memory map so new edits during push go to a fresh map,
  // but keep storage copy until push succeeds (survives page termination).
  // Remember what is in flight: until the response arrives these records are
  // in neither the dirty map nor on the server, and the merge must still
  // treat them as pending (see own-device adoption in mergeRemoteChanges).
  _syncDirtyRecords.clear();
  for (const r of records) _syncInFlightRecordNames.add(r.recordName);
  try { chrome.alarms.clear(SYNC_PUSH_DEBOUNCE_ALARM); } catch (e) {}

  browser.runtime.sendNativeMessage("application.id", {
    action: "syncPush",
    records: records
  }).then((response) => {
    _syncPushInProgress = false;
    for (const r of records) _syncInFlightRecordNames.delete(r.recordName);
    if (response && response.success) {
      const failedCount = (response.failedRecordNames || []).length;
      if (response.pushed > 0 || failedCount === 0) {
        debug('[Sync] Push succeeded:', response.pushed, 'records', failedCount ? `(${failedCount} failed: ${response.failureError})` : '');
      } else {
        debug('[Sync] Push failed for all', failedCount, 'records:', response.failureError);
      }
      // Push confirmed — now safe to clear persisted dirty records.
      // Persist current map (may have new edits added during push).
      if (_syncDirtyRecords.size > 0) {
        chrome.storage.local.set({ _syncDirtyRecords: Object.fromEntries(_syncDirtyRecords) });
      } else {
        chrome.storage.local.remove('_syncDirtyRecords');
      }
      if (response.pushed > 0) {
        chrome.storage.local.set({ icloudSyncLastTime: new Date().toISOString() });
      }
      broadcastSyncState(false);
      // Re-queue non-conflict failures (network errors, etc.)
      if (response.failedRecordNames && response.failedRecordNames.length > 0) {
        for (const name of response.failedRecordNames) {
          const original = records.find(r => r.recordName === name);
          if (original && !_syncDirtyRecords.has(name)) {
            _syncDirtyRecords.set(name, original);
          }
        }
        // Persist re-queued failures
        chrome.storage.local.set({ _syncDirtyRecords: Object.fromEntries(_syncDirtyRecords) });
      }
      // Conflicts are resolved via the pull that follows
      if (response.hasConflicts) {
        debug('[Sync] Conflicts detected, will resolve via pull');
      }
      // Pull after push to catch concurrent changes (and resolve conflicts)
      executeSyncPull();
    } else {
      debug('[Sync] Push failed:', response?.error);
      if (response?.error === 'notAuthenticated') { suspendSyncAlarm(); }
      records.forEach(r => { if (!_syncDirtyRecords.has(r.recordName)) _syncDirtyRecords.set(r.recordName, r); });
      // Persist re-queued records (storage copy may be stale if new edits came in)
      chrome.storage.local.set({ _syncDirtyRecords: Object.fromEntries(_syncDirtyRecords) });
    }
    if (_syncPushDeferred) {
      _syncPushDeferred = false;
      executeSyncPush();
    }
  }).catch((error) => {
    _syncPushInProgress = false;
    for (const r of records) _syncInFlightRecordNames.delete(r.recordName);
    debug('[Sync] Push error:', String(error));
    records.forEach(r => { if (!_syncDirtyRecords.has(r.recordName)) _syncDirtyRecords.set(r.recordName, r); });
    // Persist re-queued records
    chrome.storage.local.set({ _syncDirtyRecords: Object.fromEntries(_syncDirtyRecords) });
    if (_syncPushDeferred) {
      _syncPushDeferred = false;
      executeSyncPush();
    }
  });
}

/**
 * Execute sync pull: fetch changes from CloudKit and merge locally.
 */
function executeSyncPull(callback, _tokenRetries) {
  if (_syncPullInProgress) {
    // Break stale locks — if pull has been "in progress" for over 30s, the
    // native message promise likely never resolved.
    if (Date.now() - _syncPullLockedAt > SYNC_LOCK_TIMEOUT_MS) {
      debug('[Sync] Pull lock stale (held for', Date.now() - _syncPullLockedAt, 'ms), breaking');
      _syncPullInProgress = false;
    } else {
      _syncPullDeferred = true;
      if (callback) callback(false);
      return;
    }
  }
  _syncPullInProgress = true;
  _syncPullLockedAt = Date.now();

  browser.runtime.sendNativeMessage("application.id", {
    action: "syncPull"
  }).then((response) => {
    if (response && response.success) {
      const changes = response.changes || [];
      const deletions = response.deletions || [];
      debug('[Sync] Pull succeeded:', changes.length, 'changes,', deletions.length, 'deletions');
      if (changes.length > 0 || deletions.length > 0) {
        mergeRemoteChanges(changes, deletions, (ok) => {
          _syncPullInProgress = false;
          broadcastSyncState(false);
          if (callback) callback(ok);
          if (_syncPullDeferred) {
            _syncPullDeferred = false;
            executeSyncPull();
          }
        });
      } else {
        _syncPullInProgress = false;
        chrome.storage.local.set({ icloudSyncLastTime: new Date().toISOString() });
        if (callback) callback(true);
        if (_syncPullDeferred) {
          _syncPullDeferred = false;
          executeSyncPull();
        }
      }
    } else if (response?.error === 'tokenExpired') {
      _syncPullInProgress = false;
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
    } else {
      _syncPullInProgress = false;
      debug('[Sync] Pull failed:', response?.error);
      if (response?.error === 'notAuthenticated') {
        suspendSyncAlarm();
      }
      if (callback) callback(false);
      if (_syncPullDeferred) {
        _syncPullDeferred = false;
        executeSyncPull();
      }
    }
  }).catch((error) => {
    _syncPullInProgress = false;
    debug('[Sync] Pull error:', String(error));
    if (callback) callback(false);
    if (_syncPullDeferred) {
      _syncPullDeferred = false;
      executeSyncPull();
    }
  });
}

/**
 * Merge remote changes into local storage.
 * Sets _syncMergeInProgress to prevent dirty-marking during merge.
 */
function mergeRemoteChanges(changes, deletions, callback) {
  _syncMergeInProgress = true;

  chrome.storage.local.get(['savedSessions', 'savedTemplates', 'smartGroups', 'trashedLinks', 'icloudSyncDeviceID'], (result) => {
    let sessions = result.savedSessions || [];
    let templates = result.savedTemplates || [];
    let smartGroups = result.smartGroups || [];
    let trashedLinks = result.trashedLinks || [];
    const localDeviceID = result.icloudSyncDeviceID || null;
    let modified = false;
    const addedSessionTimestamps = [];
    const removedSessionTimestamps = [];

    const CURRENT_SCHEMA_VERSION = 1;
    let skippedNewerVersion = false;
    const readoptedNames = new Set(); // own-device records adopted because they were missing locally

    debug('[Sync] Merge starting:', changes.length, 'changes,', deletions.length, 'deletions');
    debug('[Sync] Local state before cleanup: sessions=' + sessions.length, 'templates=' + templates.length, 'smartGroups=' + smartGroups.length, 'trashedLinks=' + trashedLinks.length);

    // Pre-merge cleanup: Safari's built-in iCloud extension storage sync can
    // inject contaminated data (all records in all arrays) between our writes
    // and this read. Filter each array to only contain correctly-typed records,
    // then deduplicate by primary key.
    const preS = sessions.length, preT = templates.length, preSG = smartGroups.length, preTL = trashedLinks.length;
    sessions = sessions.filter(s => classifyRecord('session-' + s.timestamp, s) === 'Session');
    templates = templates.filter(t => classifyRecord(t.id, t) === 'Template');
    smartGroups = smartGroups.filter(g => classifyRecord('smartgroup-' + g.id, g) === 'SmartGroup');
    trashedLinks = trashedLinks.filter(l => classifyRecord('trash-' + l.id, l) === 'TrashedLink');
    // Deduplicate by primary key (keep first occurrence)
    const seenS = new Set(); sessions = sessions.filter(s => { const k = String(s.timestamp); if (seenS.has(k)) return false; seenS.add(k); return true; });
    const seenT = new Set(); templates = templates.filter(t => { if (seenT.has(t.id)) return false; seenT.add(t.id); return true; });
    const seenSG = new Set(); smartGroups = smartGroups.filter(g => { if (seenSG.has(g.id)) return false; seenSG.add(g.id); return true; });
    const seenTL = new Set(); trashedLinks = trashedLinks.filter(l => { if (seenTL.has(l.id)) return false; seenTL.add(l.id); return true; });
    if (sessions.length !== preS || templates.length !== preT || smartGroups.length !== preSG || trashedLinks.length !== preTL) {
      debug('[Sync] Pre-merge cleanup: sessions', preS, '→', sessions.length, 'templates', preT, '→', templates.length, 'smartGroups', preSG, '→', smartGroups.length, 'trashedLinks', preTL, '→', trashedLinks.length);
      modified = true; // ensure cleaned arrays get written back
    }

    debug('[Sync] Local state before merge: sessions=' + sessions.length, 'templates=' + templates.length, 'smartGroups=' + smartGroups.length, 'trashedLinks=' + trashedLinks.length);

    // Process changes (upserts)
    for (const change of changes) {
      const { recordType, recordName, payload, isDeleted, modifiedAt } = change;

      // Skip records from a newer schema version we don't understand
      if (change.schemaVersion && change.schemaVersion > CURRENT_SCHEMA_VERSION) {
        debug('[Sync] Skipping record with schema version', change.schemaVersion, ':', recordName);
        skippedNewerVersion = true;
        continue;
      }

      // Skip own-device echoes — these are our own pushes coming back via the
      // pull (the push doesn't update the local change token, so the pull returns
      // our just-pushed records as "changes"). Processing them can overwrite
      // local edits made between push and pull — including re-applying a
      // tombstone after the user has undone the delete.
      if (localDeviceID && change.deviceID === localDeviceID) {
        // Exception: an own-device upsert for a record this device no longer
        // holds, with nothing pending for it, is not an echo — it is a record
        // this device lost (e.g. a full pull after re-enabling sync). Adopt it.
        // Deletion echoes are always skipped so an undone delete is never
        // re-applied.
        const ownType = isDeleted ? null : classifyRecord(recordName, payload);
        const existsLocally = ownType ? localRecordExists(ownType, recordName, sessions, templates, smartGroups, trashedLinks) : true;
        if (isDeleted || existsLocally || _syncDirtyRecords.has(recordName) || _syncInFlightRecordNames.has(recordName)) {
          debug('[Sync] Skipping own-device echo:', recordName, isDeleted ? '(deletion)' : '(upsert)');
          continue;
        }
        debug('[Sync] Adopting own-device record missing locally:', recordName);
        readoptedNames.add(recordName);
      }

      // Classify by recordName prefix (deletions have no payload)
      const deletionType = classifyRecord(recordName);
      if (isDeleted) {
        if (!deletionType) { debug('[Sync] Unclassifiable deletion, skipping:', recordName); continue; }
        if (deletionType === 'Session') {
          const ts = recordName.replace(/^session-/, '');
          if (sessions.some(s => String(s.timestamp) === ts)) removedSessionTimestamps.push(ts);
        }
        modified = applyDeletion(deletionType, recordName, sessions, templates, smartGroups, trashedLinks) || modified;
        continue;
      }

      if (!payload || typeof payload !== 'object') continue;

      // Classify with payload for structural validation
      const classifiedType = classifyRecord(recordName, payload);
      if (!classifiedType) {
        debug('[Sync] Unclassifiable record, skipping:', recordName);
        continue;
      }
      if (classifiedType !== recordType) {
        debug('[Sync] Reclassified: name=' + recordName + ' server=' + recordType + ' actual=' + classifiedType);
      }
      debug('[Sync] Routing record: name=' + recordName + ' type=' + classifiedType + ' server=' + recordType);

      switch (classifiedType) {
        case 'Session': {
          const idx = sessions.findIndex(s => 'session-' + s.timestamp === recordName);
          if (idx >= 0) {
            // Update existing: last-write-wins based on modifiedAt
            const local = sessions[idx];
            const localModMs = getLocalModifiedMs(local, recordName);
            const remoteModMs = normalizeSyncTimestamp(modifiedAt);
            if (!localModMs || remoteModMs > localModMs) {
              // Create conflict copy to preserve local version if it was modified locally
              if (shouldCreateConflictCopy(local, recordName)) {
                const conflictTimestamp = Date.now();
                const conflictCopy = {
                  ...local,
                  timestamp: conflictTimestamp,
                  customTitle: (local.customTitle || local.title || 'Session') + ' (sync conflict)',
                  _syncConflict: true,
                  _syncModifiedAt: new Date().toISOString()
                };
                sessions.splice(idx + 1, 0, conflictCopy);
                addedSessionTimestamps.push(String(conflictTimestamp));
                _syncPendingConflictCopies.push({
                  recordType: 'Session',
                  recordName: 'session-' + conflictTimestamp,
                  payload: conflictCopy
                });
                debug('[Sync] Created conflict copy for session:', local.customTitle || local.title);
              }
              sessions[idx] = { ...payload, _syncModifiedAt: modifiedAt };
              modified = true;
            }
          } else {
            // New record from remote
            sessions.unshift({ ...payload, _syncModifiedAt: modifiedAt });
            if (payload.timestamp) addedSessionTimestamps.push(String(payload.timestamp));
            modified = true;
          }
          break;
        }
        case 'Template': {
          const idx = templates.findIndex(t => t.id === recordName);
          if (idx >= 0) {
            const local = templates[idx];
            const localModMs = getLocalModifiedMs(local, recordName);
            const remoteModMs = normalizeSyncTimestamp(modifiedAt);
            if (!localModMs || remoteModMs > localModMs) {
              if (shouldCreateConflictCopy(local, recordName)) {
                const conflictId = recordName + '-conflict-' + Date.now();
                const conflictCopy = {
                  ...local,
                  id: conflictId,
                  name: (local.name || 'Routine') + ' (sync conflict)',
                  _syncConflict: true,
                  _syncModifiedAt: new Date().toISOString()
                };
                templates.push(conflictCopy);
                _syncPendingConflictCopies.push({
                  recordType: 'Template',
                  recordName: conflictId,
                  payload: conflictCopy
                });
                debug('[Sync] Created conflict copy for template:', local.name);
              }
              templates[idx] = { ...payload, _syncModifiedAt: modifiedAt };
              modified = true;
            }
          } else {
            templates.push({ ...payload, _syncModifiedAt: modifiedAt });
            modified = true;
          }
          break;
        }
        case 'SmartGroup': {
          const groupId = recordName.replace(/^smartgroup-/, '');
          const idx = smartGroups.findIndex(g => g.id === groupId);
          if (idx >= 0) {
            const local = smartGroups[idx];
            const localModMs = getLocalModifiedMs(local, 'smartgroup-' + local.id);
            const remoteModMs = normalizeSyncTimestamp(modifiedAt);
            if (!localModMs || remoteModMs > localModMs) {
              if (shouldCreateConflictCopy(local, 'smartgroup-' + local.id)) {
                const conflictId = local.id + '-conflict-' + Date.now();
                const conflictCopy = {
                  ...local,
                  id: conflictId,
                  name: (local.name || 'Filter') + ' (sync conflict)',
                  _syncConflict: true,
                  _syncModifiedAt: new Date().toISOString()
                };
                smartGroups.push(conflictCopy);
                _syncPendingConflictCopies.push({
                  recordType: 'SmartGroup',
                  recordName: 'smartgroup-' + conflictId,
                  payload: conflictCopy
                });
                debug('[Sync] Created conflict copy for smart group:', local.name);
              }
              smartGroups[idx] = { ...payload, _syncModifiedAt: modifiedAt };
              modified = true;
            }
          } else {
            smartGroups.push({ ...payload, _syncModifiedAt: modifiedAt });
            modified = true;
          }
          break;
        }
        case 'TrashedLink': {
          const linkId = recordName.replace(/^trash-/, '');
          const idx = trashedLinks.findIndex(l => l.id === linkId);
          if (idx >= 0) {
            const local = trashedLinks[idx];
            const localModMs = getLocalModifiedMs(local, 'trash-' + local.id);
            const remoteModMs = normalizeSyncTimestamp(modifiedAt);
            if (!localModMs || remoteModMs > localModMs) {
              trashedLinks[idx] = { ...payload, _syncModifiedAt: modifiedAt };
              modified = true;
            }
          } else {
            trashedLinks.push({ ...payload, _syncModifiedAt: modifiedAt });
            modified = true;
          }
          break;
        }
      }
    }

    // Post-merge safety: filter out any non-session objects from savedSessions
    const cleanSessions = sessions.filter(s => Array.isArray(s.tabs));
    if (cleanSessions.length !== sessions.length) {
      debug('[Sync] WARNING: Removed', sessions.length - cleanSessions.length, 'non-session items from savedSessions');
      sessions = cleanSessions;
      modified = true;
    }

    // Process server-side deletions
    for (const deletion of deletions) {
      const { recordType, recordName } = deletion;
      // Track removed session timestamps for animation
      if (recordType === 'Session') {
        const ts = recordName.replace(/^session-/, '');
        if (sessions.some(s => String(s.timestamp) === ts)) removedSessionTimestamps.push(ts);
      }
      modified = applyDeletion(recordType, recordName, sessions, templates, smartGroups, trashedLinks) || modified;
    }

    debug('[Sync] Merge complete: sessions=' + sessions.length, 'templates=' + templates.length, 'smartGroups=' + smartGroups.length, 'trashedLinks=' + trashedLinks.length, 'modified=' + modified);

    // Diagnostic: write merge routing summary to storage so iOS can be inspected
    if (changes.length > 0) {
      const routingSummary = changes.map(c => {
        const ct = classifyRecord(c.recordName, c.payload);
        return { name: c.recordName, serverType: c.recordType, classified: ct };
      });
      chrome.storage.local.set({ _debugMergeRouting: { time: new Date().toISOString(), records: routingSummary, result: { sessions: sessions.length, templates: templates.length, smartGroups: smartGroups.length, trashedLinks: trashedLinks.length } } });
    }

    if (skippedNewerVersion) {
      chrome.storage.local.set({ _syncNewerVersionAvailable: true });
    }

    // Track all merged record names to prevent onChanged from re-dirtying them.
    // Own-device echoes are skipped above and never written locally, so they
    // must not be guarded: guarding them silently dropped any local edit or
    // delete of a just-pushed record for 2s after each push→pull cycle.
    _syncMergedRecordNames.clear();
    for (const change of changes) {
      if (localDeviceID && change.deviceID === localDeviceID && !readoptedNames.has(change.recordName)) continue;
      _syncMergedRecordNames.add(change.recordName);
    }
    for (const deletion of deletions) {
      _syncMergedRecordNames.add(deletion.recordName);
    }

    if (modified) {
      const metaData = { icloudSyncLastTime: new Date().toISOString() };
      // Include animation data so storage.onChanged can animate sync additions/removals
      if (addedSessionTimestamps.length || removedSessionTimestamps.length) {
        metaData._syncAnimationData = {
          added: addedSessionTimestamps,
          removed: removedSessionTimestamps
        };
      }
      // Write each array key separately to avoid Safari iOS batch-write
      // cross-contamination, then write metadata last.
      chrome.storage.local.set({ savedSessions: sessions }, () => {
        chrome.storage.local.set({ savedTemplates: templates }, () => {
          chrome.storage.local.set({ smartGroups: smartGroups }, () => {
            chrome.storage.local.set({ trashedLinks: trashedLinks }, () => {
              chrome.storage.local.set(metaData, () => {
                // onChanged listeners fire before this callback — safe to clear flags now
                _syncMergeInProgress = false;
                // Increment generation — onChanged listeners that see a stale generation
                // will ignore their events without needing a fragile timeout
                const mergeGen = ++_syncMergeGeneration;
                // Drain deferred writes that were queued during merge
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
                // Clean up animation data after listeners have processed it
                if (metaData._syncAnimationData) {
                  setTimeout(() => chrome.storage.local.remove('_syncAnimationData'), 500);
                }
                // Refresh UI
                updateListHtmlTabs(sessions);
                updateListHtmlTrash(trashedLinks);
                refreshBadge();
                if (callback) callback(true);
              }); // metaData
            }); // trashedLinks
          }); // smartGroups
        }); // savedTemplates
      }); // savedSessions
    } else {
      chrome.storage.local.set({ icloudSyncLastTime: new Date().toISOString() });
      _syncMergeInProgress = false;
      const mergeGen = ++_syncMergeGeneration;
      // Drain deferred writes
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
      if (callback) callback(true);
    }
  });
}

/**
 * Check whether a record is present in the local arrays (same lookups as applyDeletion).
 */
function localRecordExists(recordType, recordName, sessions, templates, smartGroups, trashedLinks) {
  switch (recordType) {
    case 'Session':     return sessions.some(s => 'session-' + s.timestamp === recordName);
    case 'Template':    return templates.some(t => t.id === recordName);
    case 'SmartGroup':  return smartGroups.some(g => g.id === recordName.replace(/^smartgroup-/, ''));
    case 'TrashedLink': return trashedLinks.some(l => l.id === recordName.replace(/^trash-/, ''));
    default:            return false;
  }
}

/**
 * Apply a deletion to local arrays. Returns true if something was removed.
 */
function applyDeletion(recordType, recordName, sessions, templates, smartGroups, trashedLinks) {
  switch (recordType) {
    case 'Session': {
      const idx = sessions.findIndex(s => 'session-' + s.timestamp === recordName);
      if (idx >= 0) { sessions.splice(idx, 1); return true; }
      return false;
    }
    case 'Template': {
      const idx = templates.findIndex(t => t.id === recordName);
      if (idx >= 0) { templates.splice(idx, 1); return true; }
      return false;
    }
    case 'SmartGroup': {
      const groupId = recordName.replace(/^smartgroup-/, '');
      const idx = smartGroups.findIndex(g => g.id === groupId);
      if (idx >= 0) { smartGroups.splice(idx, 1); return true; }
      return false;
    }
    case 'TrashedLink': {
      const linkId = recordName.replace(/^trash-/, '');
      const idx = trashedLinks.findIndex(l => l.id === linkId);
      if (idx >= 0) { trashedLinks.splice(idx, 1); return true; }
      return false;
    }
    default:
      return false;
  }
}

/**
 * Perform a full push of all local data to CloudKit.
 */
async function performFullPush(callback) {
  const result = await chrome.storage.local.get(['savedSessions', 'savedTemplates', 'smartGroups', 'trashedLinks']);
  const records = [];
  const now = new Date().toISOString();

  // Build records array with classification validation at construction time
  (result.savedSessions || []).forEach(session => {
    const rn = 'session-' + session.timestamp;
    if (classifyRecord(rn, session) !== 'Session') return;
    records.push({ recordType: 'Session', recordName: rn, payload: session, modifiedAt: session._syncModifiedAt || now, isDeleted: false });
  });

  (result.savedTemplates || []).forEach(template => {
    if (classifyRecord(template.id, template) !== 'Template') {
      debug('[Sync] Full push: skipping non-template in savedTemplates:', template.id || '?');
      return;
    }
    records.push({ recordType: 'Template', recordName: template.id, payload: template, modifiedAt: template._syncModifiedAt || now, isDeleted: false });
  });

  (result.smartGroups || []).forEach(group => {
    const rn = 'smartgroup-' + group.id;
    if (classifyRecord(rn, group) !== 'SmartGroup') return;
    records.push({ recordType: 'SmartGroup', recordName: rn, payload: group, modifiedAt: group._syncModifiedAt || now, isDeleted: false });
  });

  (result.trashedLinks || []).forEach(link => {
    const rn = 'trash-' + link.id;
    if (classifyRecord(rn, link) !== 'TrashedLink') return;
    records.push({ recordType: 'TrashedLink', recordName: rn, payload: link, modifiedAt: link._syncModifiedAt || now, isDeleted: false });
  });

  if (records.length === 0) {
    if (callback) callback(true);
    return;
  }

  // Batch into chunks of 400 (matching Swift-side maxRecordsPerBatch)
  const BATCH_SIZE = 400;
  let totalPushed = 0;
  let lastError = null;

  debug('[Sync] Full push:', records.length, 'records in', Math.ceil(records.length / BATCH_SIZE), 'batches');

  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const batch = records.slice(i, i + BATCH_SIZE);
    try {
      const response = await browser.runtime.sendNativeMessage("application.id", {
        action: "syncFullPush",
        records: batch
      });
      if (response && response.success) {
        totalPushed += response.pushed || 0;
        // Re-queue per-record failures so the normal push cycle retries them
        if (response.failedRecordNames && response.failedRecordNames.length > 0) {
          for (const name of response.failedRecordNames) {
            const original = batch.find(r => r.recordName === name);
            if (original && !_syncDirtyRecords.has(name)) {
              _syncDirtyRecords.set(name, original);
            }
          }
        }
      } else {
        lastError = response?.error;
        debug('[Sync] Full push batch failed:', lastError, '- re-queuing', batch.length, 'records');
        requeueBatch(batch);
      }
    } catch (error) {
      lastError = String(error);
      debug('[Sync] Full push batch error:', lastError, '- re-queuing', batch.length, 'records');
      requeueBatch(batch);
    }
  }

  // A whole batch that failed (offline, rate limited, native messaging error)
  // goes back into the dirty map so the normal push cycle retries it.
  // Without this the records were only pushed again if each was edited.
  function requeueBatch(batch) {
    for (const r of batch) {
      if (!_syncDirtyRecords.has(r.recordName)) _syncDirtyRecords.set(r.recordName, r);
    }
  }

  if (totalPushed > 0) {
    debug('[Sync] Full push succeeded:', totalPushed, 'records');
    chrome.storage.local.set({ icloudSyncLastTime: new Date().toISOString() });
  }
  if (lastError) {
    debug('[Sync] Full push completed with errors:', lastError);
  }

  // If any records were re-queued from per-record failures, persist and schedule retry
  if (_syncDirtyRecords.size > 0) {
    chrome.storage.local.set({ _syncDirtyRecords: Object.fromEntries(_syncDirtyRecords) });
    scheduleSyncPush();
  }

  if (callback) callback(!lastError);
}

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

    debug('[Sync] stampAllLocalRecords: pre-stamp sessions=' + sessions.length,
          'templates=' + templates.length, 'smartGroups=' + smartGroups.length,
          'trashedLinks=' + trashedLinks.length);

    // Track stamped record names so onChanged doesn't re-dirty them
    const stampedNames = [];
    for (const s of sessions) { const n = 'session-' + s.timestamp; _syncMergedRecordNames.add(n); stampedNames.push(n); }
    for (const t of templates) { _syncMergedRecordNames.add(t.id); stampedNames.push(t.id); }
    for (const g of smartGroups) { const n = 'smartgroup-' + g.id; _syncMergedRecordNames.add(n); stampedNames.push(n); }
    for (const l of trashedLinks) { const n = 'trash-' + l.id; _syncMergedRecordNames.add(n); stampedNames.push(n); }

    // Write each key separately to avoid Safari iOS batch-write cross-contamination
    chrome.storage.local.set({ savedSessions: sessions }, () => {
      chrome.storage.local.set({ savedTemplates: templates }, () => {
        chrome.storage.local.set({ smartGroups: smartGroups }, () => {
          chrome.storage.local.set({ trashedLinks: trashedLinks }, () => {
            // Clear stamped names after onChanged listeners have fired
            setTimeout(() => {
              for (const n of stampedNames) _syncMergedRecordNames.delete(n);
            }, 2000);
            if (callback) callback();
          });
        });
      });
    });
  });
}

/**
 * Schedule the iCloud sync alarm (15-min period).
 */
function scheduleSyncAlarm() {
  try { chrome.alarms.clear(SYNC_ALARM_NAME); } catch (e) {}
  chrome.alarms.create(SYNC_ALARM_NAME, {
    delayInMinutes: SYNC_ALARM_MINUTES,
    periodInMinutes: SYNC_ALARM_MINUTES
  });
  debug('[Sync] Alarm scheduled every', SYNC_ALARM_MINUTES, 'minutes');
}

/**
 * Clear the sync alarm.
 */
function clearSyncAlarm() {
  try { chrome.alarms.clear(SYNC_ALARM_NAME); } catch (e) {}
}

let _syncAlarmSuspended = false;

function suspendSyncAlarm() {
  if (_syncAlarmSuspended) return;
  _syncAlarmSuspended = true;
  clearSyncAlarm();
  debug('[Sync] Alarm suspended (notAuthenticated)');
}

function resumeSyncAlarmIfAvailable() {
  if (!_syncAlarmSuspended) return;
  browser.runtime.sendNativeMessage("application.id", { action: "syncStatus" })
    .then((response) => {
      if (response && response.success && response.accountStatus === 'available') {
        _syncAlarmSuspended = false;
        scheduleSyncAlarm();
        debug('[Sync] Alarm resumed (account available)');
        executeSyncPull();
      }
    })
    .catch(() => {});
}

/**
 * Initialize sync on startup if enabled.
 */
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

  chrome.storage.local.get(['icloudSyncEnabled', 'icloudSyncDeviceID', '_syncDirtyRecords'], (result) => {
    // Restore dirty records FIRST, before any pull.
    // Validate each record: skip entries with malformed names (e.g. 'smartgroup-undefined')
    // or payloads that don't match their prefix (zombie contamination).
    const persisted = result._syncDirtyRecords;
    if (persisted && typeof persisted === 'object') {
      let count = 0;
      let skipped = 0;
      for (const [name, record] of Object.entries(persisted)) {
        if (name.includes('undefined') || name.includes('null')) { skipped++; continue; }
        if (!record.isDeleted && record.payload) {
          const ct = classifyRecord(name, record.payload);
          if (!ct || ct !== record.recordType) { skipped++; continue; }
        }
        if (!_syncDirtyRecords.has(name)) {
          _syncDirtyRecords.set(name, record);
          count++;
        }
      }
      if (skipped > 0) {
        debug('[Sync] Skipped', skipped, 'invalid persisted dirty records');
        chrome.storage.local.set({ _syncDirtyRecords: Object.fromEntries(_syncDirtyRecords) });
      }
      if (count > 0) {
        debug('[Sync] Restored', count, 'persisted dirty records');
        scheduleSyncPush();
      }
    }

    if (result.icloudSyncEnabled && result.icloudSyncDeviceID) {
      scheduleSyncAlarm();
      // Trigger initial pull after 3s delay — dirty map is already rehydrated
      setTimeout(() => executeSyncPull(), 3000);
      // Alarm safety net in case setTimeout doesn't fire
      chrome.alarms.create('syncStartupPull', { delayInMinutes: 1 });
    } else if (result.icloudSyncEnabled && !result.icloudSyncDeviceID) {
      debug('[Sync] initSyncOnStartup: icloudSyncEnabled=true but no deviceID — skipping (stale Safari sync or premature write)');
    }
  });

  // Startup cleanup: purge misrouted records + deduplicate all storage arrays
  chrome.storage.local.get(['savedSessions', 'savedTemplates', 'smartGroups', 'trashedLinks', 'icloudSyncEnabled'], (result) => {
    const updates = {};

    // Deduplication helper: keep first occurrence by primary key
    function dedup(arr, keyFn) {
      const seen = new Set();
      return arr.filter(item => {
        const k = keyFn(item);
        if (k == null || seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    }

    const sessions = result.savedSessions || [];
    let cleanSessions = sessions.filter(s => classifyRecord('session-' + s.timestamp, s) === 'Session');
    cleanSessions = dedup(cleanSessions, s => String(s.timestamp));
    if (cleanSessions.length !== sessions.length) {
      debug('[Sync] Startup cleanup: savedSessions', sessions.length, '→', cleanSessions.length, '(removed misrouted/duplicate)');
      updates.savedSessions = cleanSessions;
    }

    const templates = result.savedTemplates || [];
    let cleanTemplates = templates.filter(t => classifyRecord(t.id, t) === 'Template');
    cleanTemplates = dedup(cleanTemplates, t => t.id);
    if (cleanTemplates.length !== templates.length) {
      debug('[Sync] Startup cleanup: savedTemplates', templates.length, '→', cleanTemplates.length, '(removed misrouted/duplicate)');
      updates.savedTemplates = cleanTemplates;
    }

    const smartGroups = result.smartGroups || [];
    const purged = [];
    let cleanSmartGroups = smartGroups.filter(g => {
      if (classifyRecord('smartgroup-' + g.id, g) === 'SmartGroup') return true;
      purged.push(g);
      return false;
    });
    cleanSmartGroups = dedup(cleanSmartGroups, g => g.id);
    if (cleanSmartGroups.length !== smartGroups.length) {
      debug('[Sync] Startup cleanup: smartGroups', smartGroups.length, '→', cleanSmartGroups.length, '(removed misrouted/duplicate)');
      updates.smartGroups = cleanSmartGroups;
      if (result.icloudSyncEnabled && purged.length > 0) {
        for (const g of purged) {
          markSyncDeleted('SmartGroup', 'smartgroup-' + g.id);
        }
      }
    }

    const trashedLinks = result.trashedLinks || [];
    let cleanTrashedLinks = trashedLinks.filter(l => classifyRecord('trash-' + l.id, l) === 'TrashedLink');
    cleanTrashedLinks = dedup(cleanTrashedLinks, l => l.id);
    if (cleanTrashedLinks.length !== trashedLinks.length) {
      debug('[Sync] Startup cleanup: trashedLinks', trashedLinks.length, '→', cleanTrashedLinks.length, '(removed misrouted/duplicate)');
      updates.trashedLinks = cleanTrashedLinks;
    }

    if (Object.keys(updates).length > 0) {
      // Write each key separately to avoid Safari iOS batch-write cross-contamination
      const keys = Object.keys(updates);
      let i = 0;
      function writeNextCleanup() {
        if (i < keys.length) {
          const obj = {};
          obj[keys[i]] = updates[keys[i]];
          i++;
          chrome.storage.local.set(obj, writeNextCleanup);
        }
      }
      writeNextCleanup();
    }
  });
}

// Pull on window focus or tab activation — catches changes made on other devices
let _lastFocusPull = 0;
function maybeSyncPull() {
  const now = Date.now();
  // Debounce: at most once per 30 seconds
  if (now - _lastFocusPull < 30000) return;
  _lastFocusPull = now;
  chrome.storage.local.get(['icloudSyncEnabled'], (result) => {
    if (result.icloudSyncEnabled) {
      if (_syncAlarmSuspended) {
        resumeSyncAlarmIfAvailable();
      } else {
        executeSyncPull();
      }
    }
  });
}

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  maybeSyncPull();
});

// Also pull when user switches to a Tabstract tab (e.g. navigating back from another tab)
chrome.tabs.onActivated.addListener((activeInfo) => {
  chrome.tabs.get(activeInfo.tabId, (tab) => {
    if (chrome.runtime.lastError) return;
    if (tab && tab.url && tab.url.startsWith(chrome.runtime.getURL(''))) {
      maybeSyncPull();
    }
  });
});

// =============================
// Backup System
// =============================

/**
 * Creates a backup of all extension data via native messaging.
 * @param {string} trigger - 'auto', 'scheduled', 'manual', or 'pre-restore'
 * @param {string|null} label - Optional label for manual backups
 * @param {function} callback - Optional callback(success, filename)
 */
function createBackup(trigger, label, callback) {
  chrome.storage.local.get(null, (allData) => {
    if (chrome.runtime.lastError) {
      debug('[Backup] Storage read failed:', chrome.runtime.lastError.message);
      if (callback) callback(false, null);
      return;
    }
    const sessions = allData.savedSessions || [];
    const tabCount = sessions.reduce((sum, s) => sum + (s.tabs ? s.tabs.length : 0), 0);

    const backup = {
      backupVersion: 1,
      timestamp: new Date().toISOString(),
      trigger: trigger || 'auto',
      summary: {
        sessionCount: sessions.length,
        tabCount: tabCount
      },
      data: allData
    };

    if (label) {
      backup.label = label;
    }

    browser.runtime.sendNativeMessage("application.id", {
      action: "createBackup",
      backup: backup
    }).then((response) => {
      if (response && response.success) {
        chrome.storage.local.set({ lastBackupTimestamp: backup.timestamp });
        debug('[Backup] Created:', trigger, response.filename);
        if (callback) callback(true, response.filename);
      } else {
        debug('[Backup] Failed:', response?.error);
        if (callback) callback(false, null);
      }
    }).catch((error) => {
      debug('[Backup] Error:', String(error));
      if (callback) callback(false, null);
    });
  });
}

/**
 * Create a backup immediately after a tab save operation.
 * Debounces multiple rapid saves — only one backup per 60-second window.
 * Runs inline instead of deferring to an alarm, because Safari aggressively
 * suspends the service worker and may never fire a deferred alarm.
 */
let _lastSaveBackupTime = 0;
function scheduleBackupAfterSave() {
  const now = Date.now();
  if (now - _lastSaveBackupTime < 60000) {
    debug('[Backup] Skipping save-triggered backup (debounce, last was', Math.round((now - _lastSaveBackupTime) / 1000), 'sec ago)');
    return;
  }
  _lastSaveBackupTime = now;
  createBackup('auto');
}

/**
 * Schedule the hourly backup alarm.
 */
function scheduleBackupAlarm() {
  try { chrome.alarms.clear('hourlyBackup'); } catch (e) {}
  chrome.alarms.create('hourlyBackup', {
    delayInMinutes: 60,
    periodInMinutes: 60
  });
}

/**
 * Ensure the hourly backup alarm exists and isn't stale.
 * Called on every service worker wake because Safari may silently drop alarms
 * when the service worker is terminated, or keep stale alarms that never fire
 * after sleep/wake cycles. Recreates the alarm if missing or overdue, and
 * always checks whether a catch-up backup is needed.
 */
function ensureBackupAlarm() {
  chrome.alarms.get('hourlyBackup', (alarm) => {
    const now = Date.now();
    // Recreate alarm if missing or if its scheduled time is in the past
    if (!alarm) {
      debug('[Backup] Hourly alarm was missing — re-registering');
      scheduleBackupAlarm();
    } else if (alarm.scheduledTime && alarm.scheduledTime < now) {
      debug('[Backup] Hourly alarm is stale (was due', Math.round((now - alarm.scheduledTime) / 60000), 'min ago) — re-registering');
      scheduleBackupAlarm();
    }
    // Always check if we're overdue for a backup (e.g. after sleep).
    // Defer it rather than running it here: this function runs on every service
    // worker wake, including Safari launch, and a backup is the heaviest thing we
    // do. Running it inline made Safari unresponsive at startup for users with a
    // lot saved. An alarm also survives the service worker being suspended, which
    // setTimeout does not.
    chrome.storage.local.get(['lastBackupTimestamp'], (res) => {
      const last = res.lastBackupTimestamp ? new Date(res.lastBackupTimestamp).getTime() : 0;
      const elapsed = now - last;
      if (elapsed > 60 * 60 * 1000) {
        debug('[Backup] Last backup was', Math.round(elapsed / 60000), 'min ago — scheduling catch-up backup');
        chrome.alarms.get('catchUpBackup', (existing) => {
          if (!existing) {
            chrome.alarms.create('catchUpBackup', { delayInMinutes: 1 });
          }
        });
      }
    });
  });
}

/**
 * Quietly saves the active tab (if valid) when user does "save-active-tab".
 */
function saveActiveTab() {
  chrome.tabs.query({ currentWindow: true, active: true }, (tabs) => {
    chrome.storage.local.get(["popupBehavior", "pinnedTabs"], (res) => {
      const skipPinned = !!res.pinnedTabs;
      const validTabs = tabs.filter(tab => {
        if (!tab.url) return false;
        if (tab.url.startsWith("safari-web-extension://")) return false;
        if (tab.url.startsWith("favorites://")) return false;
        if (tab.url === "about:blank") return false;
        if (skipPinned && tab.pinned) return false;
        return true;
      });
      if (validTabs.length === 0) return;

      const activeTab = validTabs[0];
      const mode = res.popupBehavior || "saveAndClose";
      const tabList = [{
        id: activeTab.id,
        url: activeTab.url,
        title: activeTab.title
      }];

      saveSession(tabList, (sessions) => {
        if (!sessions) {
          return;
        }
        if (mode === "saveAndClose") {
          chrome.tabs.remove(activeTab.id, () => {
            // Cleanup empty windows after tab is closed
            setTimeout(() => {
              cleanupEmptyWindows();
            }, 500);
          });
        }
        refreshBadge();

        // After saving, refresh list.html if open
        chrome.tabs.query({ currentWindow: true, url: chrome.runtime.getURL("list.html") }, (listTabs) => {
          if (listTabs.length > 0) {
            chrome.tabs.reload(listTabs[0].id);
          }
        });
      });
    });
  });
}

/**
 * Saves the active tab with an explicit close/no-close mode (ignores popupBehavior setting).
 */
function saveActiveTabExplicit(shouldClose) {
  chrome.tabs.query({ currentWindow: true }, (allTabs) => {
    chrome.storage.local.get(["pinnedTabs"], (res) => {
      const skipPinned = !!res.pinnedTabs;
      const validTabs = allTabs.filter(tab => {
        if (!tab.url) return false;
        if (tab.url.startsWith("safari-web-extension://")) return false;
        if (tab.url.startsWith("favorites://")) return false;
        if (tab.url === "about:blank") return false;
        if (skipPinned && tab.pinned) return false;
        return true;
      });
      if (validTabs.length === 0) return;

      const activeTabs = allTabs.filter(tab => tab.active);
      const activeTab = activeTabs.length > 0
        ? validTabs.find(t => t.id === activeTabs[0].id) || validTabs[0]
        : validTabs[0];

      const tabList = [{
        id: activeTab.id,
        url: activeTab.url,
        title: activeTab.title
      }];

      saveSession(tabList, (sessions) => {
        if (!sessions) return;
        if (shouldClose) {
          // If this is the only valid tab, redirect to ios-popup.html before closing
          if (validTabs.length <= 1) {
            chrome.tabs.create({ url: chrome.runtime.getURL("ios-popup.html#tabs-saved"), active: false }, (newTab) => {
              setTimeout(() => {
                closeOriginalTabs(newTab.id, tabList, false);
              }, 100);
            });
          } else {
            chrome.tabs.remove(activeTab.id, () => {
              setTimeout(() => cleanupEmptyWindows(), 500);
            });
          }
        }
        refreshBadge();
      });
    });
  });
}

// Helper: open/focus settings.html or list.html, etc.
function openOrFocus(relativeUrl) {
  const targetUrl = chrome.runtime.getURL(relativeUrl);
  
  // Need to query each extension page URL individually since the pattern matching
  // with an array of URLs doesn't allow us to use the tabs.query URL filter
  chrome.tabs.query({}, (allTabs) => {
    // Find any tabs that match our extension pages
    const extensionPageUrls = getExtensionPageUrls();
    const extensionTabs = allTabs.filter(tab =>
      extensionPageUrls.some(url => tab.url && tab.url.startsWith(url))
    );
    
    if (extensionTabs.length > 0) {
      // Use the first found extension tab
      chrome.tabs.update(extensionTabs[0].id, { url: targetUrl, active: true }, () => {
        window.close();
      });
    } else {
      chrome.tabs.create({ url: targetUrl }, () => {
        window.close();
      });
    }
  });
}

// Open list.html on startup (no delay, no scan for existing extension tabs).
// Disabled on iOS — list.html is macOS-only and interferes with Safari's tab restoration.
function openOnStartup() {
  if (/iPhone|iPad|iPod/.test(navigator.userAgent)) return;
  const targetUrl = chrome.runtime.getURL('list.html');
  // Create a new tab in the current window if one exists; else create a new window
  chrome.windows.getAll({ populate: false }, (wins) => {
    if (!wins || wins.length === 0) {
      chrome.windows.create({ url: 'about:blank', focused: true }, (newWindow) => {
        if (newWindow && newWindow.tabs && newWindow.tabs.length > 0) {
          const tabId = newWindow.tabs[0].id;
          chrome.tabs.update(tabId, { url: targetUrl, active: true });
        } else {
          chrome.tabs.create({ windowId: newWindow.id, url: targetUrl, active: true });
        }
      });
    } else {
      chrome.tabs.create({ url: targetUrl, active: true });
    }
  });
}

// -------- Fallback: launch on first activity if onStartup is unreliable (Safari)
let startupLaunchFired = false;
const STARTUP_FALLBACK_WINDOW_MS = 5000;
let startupFallbackDeadline = Date.now() + STARTUP_FALLBACK_WINDOW_MS;
function markStartupLaunched(cb) {
  startupLaunchFired = true;
  try {
    if (chrome.storage && chrome.storage.session) {
      chrome.storage.session.set({ startupLaunchDone: true }, () => {
        if (typeof cb === 'function') cb();
      });
      return;
    }
  } catch (e) {}
  if (typeof cb === 'function') cb();
}

function maybeLaunchOnFirstActivity() {
  debug('[Tabstract BG] maybeLaunchOnFirstActivity called');
  if (startupLaunchFired) {
    debug('[Tabstract BG] maybeLaunchOnFirstActivity: startupLaunchFired=true, skipping');
    return;
  }
  const proceedIfEnabled = () => {
    if (Date.now() > startupFallbackDeadline) {
      debug('[Tabstract BG] maybeLaunchOnFirstActivity: past deadline');
      removeStartupFallbacks();
      return;
    }
    chrome.storage.local.get(['launchOnStartup', 'saveTabsOnStartup'], (res) => {
      debug(`[Tabstract BG] maybeLaunchOnFirstActivity: saveTabsOnStartup=${res.saveTabsOnStartup}`);
      // Attempt startup save independently of launch preference
      if (res.saveTabsOnStartup) {
        debug('[Tabstract BG] maybeLaunchOnFirstActivity: Calling performStartupSaveOnce');
        performStartupSaveOnce();
      }
      // Optionally open list.html on startup
      if (res.launchOnStartup && !startupLaunchFired) {
        markStartupLaunched(() => {
          openOnStartup();
          removeStartupFallbacks();
        });
      }
    });
  };
  try {
    if (chrome.storage && chrome.storage.session) {
      chrome.storage.session.get(['startupLaunchDone', 'startupFallbackDeadline'], (sess) => {
        if (sess && typeof sess.startupFallbackDeadline === 'number') {
          startupFallbackDeadline = sess.startupFallbackDeadline;
        }
        if (sess && sess.startupLaunchDone) return; // already launched this browser session
        proceedIfEnabled();
      });
    } else {
      proceedIfEnabled();
    }
  } catch (e) {
    proceedIfEnabled();
  }
}

// Helper to remove all startup fallback listeners
function removeStartupFallbacks() {
  try { chrome.windows.onCreated.removeListener(maybeLaunchOnFirstActivity); } catch (e) {}
  try { chrome.windows.onFocusChanged.removeListener(maybeLaunchOnFirstActivity); } catch (e) {}
  try { chrome.tabs.onActivated.removeListener(maybeLaunchOnFirstActivity); } catch (e) {}
}

// Register fallback listeners at service worker evaluation time
try { chrome.windows.onCreated.addListener(maybeLaunchOnFirstActivity); } catch (e) {}
try { chrome.windows.onFocusChanged.addListener(maybeLaunchOnFirstActivity); } catch (e) {}
try { chrome.tabs.onActivated.addListener(maybeLaunchOnFirstActivity); } catch (e) {}

// Initialize in-memory flag from session storage (in case SW restarted)
try {
  if (chrome.storage && chrome.storage.session) {
    chrome.storage.session.get(['startupLaunchDone', 'startupFallbackDeadline'], (sess) => {
      if (sess && sess.startupLaunchDone) startupLaunchFired = true;
      if (sess && typeof sess.startupFallbackDeadline === 'number') {
        startupFallbackDeadline = sess.startupFallbackDeadline;
      } else {
        try { chrome.storage.session.set({ startupFallbackDeadline }); } catch (e) {}
      }
      // Attempt immediate startup if within window and not yet launched
      maybeImmediateStartupAttempt();
    });
  }
} catch (e) {}

function maybeImmediateStartupAttempt() {
  debug('[Tabstract BG] maybeImmediateStartupAttempt called');
  if (startupLaunchFired) {
    debug('[Tabstract BG] maybeImmediateStartupAttempt: startupLaunchFired=true, skipping');
    return;
  }
  if (Date.now() > startupFallbackDeadline) {
    debug('[Tabstract BG] maybeImmediateStartupAttempt: past deadline, skipping');
    return;
  }
  chrome.storage.local.get(['launchOnStartup', 'saveTabsOnStartup'], (res) => {
    debug(`[Tabstract BG] maybeImmediateStartupAttempt: saveTabsOnStartup=${res.saveTabsOnStartup}`);
    // Attempt startup save independently of launch preference
    if (res.saveTabsOnStartup) {
      debug('[Tabstract BG] maybeImmediateStartupAttempt: Calling performStartupSaveOnce');
      performStartupSaveOnce();
    }
    if (res.launchOnStartup && !startupLaunchFired) {
      markStartupLaunched(() => {
        openOnStartup();
        removeStartupFallbacks();
      });
    }
  });
}

// Ensure we only save-on-startup once per browser session
let startupSaveFired = false;
function markStartupSaved(cb) {
  startupSaveFired = true;
  try {
    if (chrome.storage && chrome.storage.session) {
      chrome.storage.session.set({ startupSaveDone: true }, () => {
        if (typeof cb === 'function') cb();
      });
      return;
    }
  } catch (e) {}
  if (typeof cb === 'function') cb();
}

// Build a list of all tabs across all windows, honoring settings
function getAllOpenTabsList(callback, waitForTitles = false) {
  chrome.storage.local.get(["pinnedTabs", "avoidDuplicates"], (res) => {
    const skipPinned = !!res.pinnedTabs;
    const avoidDupes = res.avoidDuplicates !== false; // default true

    let titleWaitAttempts = 0;
    const collectTabs = () => {
      titleWaitAttempts++;
      chrome.tabs.query({}, (tabs) => {
        debugWithMessage(`chrome.tabs.query returned ${tabs.length} tabs`);

        let rawList = tabs
          .filter(tab => {
            if (!tab.url) return false;
            if (tab.url.startsWith("safari-web-extension://")) return false;
            if (tab.url.startsWith("favorites://")) return false;
            if (tab.url === "about:blank") return false;
            if (skipPinned && tab.pinned) return false;
            return true;
          })
          .map(tab => ({ id: tab.id, url: tab.url, title: tab.title }));

        // If waiting for titles on startup, check if many tabs are missing titles
        if (waitForTitles && rawList.length > 0) {
          const missingTitles = rawList.filter(t => !t.title || t.title === t.url).length;
          const percentMissing = missingTitles / rawList.length;

          debugWithMessage(`getAllOpenTabsList: ${rawList.length} tabs, ${missingTitles} missing titles (${Math.round(percentMissing * 100)}%), attempt ${titleWaitAttempts}`);

          // If more than 50% of tabs are missing titles, Safari is still restoring - wait and retry
          // But timeout after 3 attempts (750ms) to keep startup fast
          if (percentMissing > 0.5 && titleWaitAttempts < 3) {
            debugWithMessage(`Waiting 250ms for more titles to load (attempt ${titleWaitAttempts})`);
            setTimeout(collectTabs, 250);
            return;
          } else if (titleWaitAttempts >= 3) {
            debugWithMessage(`Title wait timeout after ${titleWaitAttempts * 0.25}s, proceeding with ${missingTitles} missing`);
          }
        }

        callback(rawList);
      });
    };

    collectTabs();
  });
}

function performStartupSaveOnce() {
  try {
    if (startupSaveFired) return;
    debug('[Tabstract BG] performStartupSaveOnce: Starting');
    if (chrome.storage && chrome.storage.session) {
      chrome.storage.session.get(['startupSaveDone'], (sess) => {
        if (sess && sess.startupSaveDone) {
          debug('[Tabstract BG] performStartupSaveOnce: Already done this session');
          return; // already saved this session
        }
        debug('[Tabstract BG] performStartupSaveOnce: Waiting 300ms for Safari to restore');
        // Give Safari a moment to restore windows/tabs (cache loads in parallel, ~10-50ms)
        setTimeout(() => {
          // Cache usually loads faster than this 300ms delay, so just proceed
          // If cache isn't loaded yet, check once then proceed anyway
          const startSave = () => {
            debug('[Tabstract BG] performStartupSaveOnce: Getting tabs (cache loaded=' + metadataCacheLoaded + ')');
            chrome.storage.local.get(['aiSmartCategorization'], (aiRes) => {
              const aiEnabled = !!aiRes.aiSmartCategorization;
              debug(`[Tabstract BG] performStartupSaveOnce: AI enabled=${aiEnabled}`);

              getAllWindowsTabList((tabsByWindow, allTabsList) => {
                debug(`[Tabstract BG] performStartupSaveOnce: Got ${allTabsList?.length || 0} tabs from ${tabsByWindow?.length || 0} windows`);
                if (!allTabsList || allTabsList.length === 0) {
                  debug('[Tabstract BG] performStartupSaveOnce: No tabs to save');
                  markStartupSaved();
                  return;
                }

                if (aiEnabled) {
                  // AI enabled: save all tabs as single session
                  debug('[Tabstract BG] performStartupSaveOnce: Saving all windows as single session (AI enabled)');
                  saveSession(allTabsList, (sessions) => {
                    debug('[Tabstract BG] performStartupSaveOnce: Session saved, closing tabs');
                    try { updateListHtmlTabs(sessions); } catch (_) {}
                    closeSavedTabsAllWindows(allTabsList);
                    setTimeout(() => {
                      cleanupEmptyWindows();
                      markStartupSaved();
                    }, 500);
                  });
                } else {
                  // AI disabled: save each window as separate session
                  debug('[Tabstract BG] performStartupSaveOnce: Saving each window as separate session');
                  saveMultipleWindowSessions(tabsByWindow, (sessions) => {
                    debug('[Tabstract BG] performStartupSaveOnce: Sessions saved, closing tabs');
                    try { updateListHtmlTabs(sessions); } catch (_) {}
                    closeSavedTabsAllWindows(allTabsList);
                    setTimeout(() => {
                      cleanupEmptyWindows();
                      markStartupSaved();
                    }, 500);
                  });
                }
              });
            });
          };
          startSave();
        }, 300);
      });
    } else {
      debug('[Tabstract BG] performStartupSaveOnce: Using fallback (no session storage)');
      setTimeout(() => {
        debug('[Tabstract BG] performStartupSaveOnce (fallback): Getting tabs (cache loaded=' + metadataCacheLoaded + ')');
        chrome.storage.local.get(['aiSmartCategorization'], (aiRes) => {
          const aiEnabled = !!aiRes.aiSmartCategorization;
          debug(`[Tabstract BG] performStartupSaveOnce (fallback): AI enabled=${aiEnabled}`);

          getAllWindowsTabList((tabsByWindow, allTabsList) => {
            debug(`[Tabstract BG] performStartupSaveOnce (fallback): Got ${allTabsList?.length || 0} tabs from ${tabsByWindow?.length || 0} windows`);
            if (!allTabsList || allTabsList.length === 0) {
              markStartupSaved();
              return;
            }

            if (aiEnabled) {
              // AI enabled: save all tabs as single session
              debug('[Tabstract BG] performStartupSaveOnce (fallback): Saving all windows as single session (AI enabled)');
              saveSession(allTabsList, (sessions) => {
                try { updateListHtmlTabs(sessions); } catch (_) {}
                closeSavedTabsAllWindows(allTabsList);
                setTimeout(() => {
                  cleanupEmptyWindows();
                  markStartupSaved();
                }, 500);
              });
            } else {
              // AI disabled: save each window as separate session
              debug('[Tabstract BG] performStartupSaveOnce (fallback): Saving each window as separate session');
              saveMultipleWindowSessions(tabsByWindow, (sessions) => {
                try { updateListHtmlTabs(sessions); } catch (_) {}
                closeSavedTabsAllWindows(allTabsList);
                setTimeout(() => {
                  cleanupEmptyWindows();
                  markStartupSaved();
                }, 500);
              });
            }
          });
        });
      }, 300);
    }
  } catch (e) {
    // swallow errors
  }
}

// Close the saved tabs across all windows (honors pinned tab setting)
function closeSavedTabsAllWindows(savedTabList) {
  chrome.storage.local.get(["pinnedTabs"], (res) => {
    const skipPinned = !!res.pinnedTabs;
    const savedIds = new Set();
    for (const item of savedTabList) {
      if (Array.isArray(item.allIds)) {
        item.allIds.forEach((tabId) => savedIds.add(tabId));
      } else if (typeof item.id === 'number') {
        savedIds.add(item.id);
      }
    }
    chrome.tabs.query({}, (tabs) => {
      const idsToClose = tabs
        .filter(t => {
          if (skipPinned && t.pinned) return false;
          return savedIds.has(t.id);
        })
        .map(t => t.id);
      if (idsToClose.length > 0) {
        chrome.tabs.remove(idsToClose);
      }
    });
  });
}

/**
 * Get tabs from all windows, grouped by window
 * Callback receives (tabsByWindow, allTabsList)
 * - tabsByWindow: Array of { windowId, tabs: [...] }
 * - allTabsList: Flat array of all tabs
 */
function getAllWindowsTabList(callback) {
  chrome.storage.local.get(["pinnedTabs", "avoidDuplicates"], (res) => {
    const skipPinned = !!res.pinnedTabs;
    const avoidDupes = res.avoidDuplicates !== false;

    chrome.tabs.query({}, (allTabs) => {
      // Group tabs by window
      const tabsByWindowId = new Map();

      for (const tab of allTabs) {
        // Filter ineligible tabs
        if (!tab.url) continue;
        if (tab.url.startsWith("safari-web-extension://")) continue;
        if (tab.url.startsWith("favorites://")) continue;
        if (tab.url === "about:blank") continue;
        if (skipPinned && tab.pinned) continue;

        if (!tabsByWindowId.has(tab.windowId)) {
          tabsByWindowId.set(tab.windowId, []);
        }
        tabsByWindowId.get(tab.windowId).push(tab);
      }

      // Process each window's tabs (add metadata, etc.)
      const windowProcessingPromises = [];

      for (const [windowId, tabs] of tabsByWindowId.entries()) {
        const promise = new Promise((resolve) => {
          processTabList(tabs, avoidDupes, (enrichedList) => {
            resolve({ windowId, tabs: enrichedList });
          });
        });
        windowProcessingPromises.push(promise);
      }

      Promise.all(windowProcessingPromises).then(tabsByWindow => {
        // Also create flat list of all tabs
        const allTabsList = tabsByWindow.flatMap(w => w.tabs);
        callback(tabsByWindow, allTabsList);
      });
    });
  });
}

/**
 * Process a list of tabs (add metadata, merge duplicates)
 * This is the core logic extracted from getTabList
 */
function processTabList(tabs, avoidDupes, callback) {
  let rawList = tabs.map(tab => {
    let status;
    try {
      const rec = mainFrameStatusByTab.get(tab.id);
      if (rec) status = rec.status;
    } catch (e) {}
    const hints = computeWorkHints(tab.url, tab.title, status);
    return {
      id: tab.id,
      url: tab.url,
      title: tab.title,
      status,
      hints
    };
  });

  // Extract og:description from each tab in parallel
  const metadataPromises = rawList.map(tab => {
    return new Promise((resolve) => {
      const cached = pageMetadataCache.get(tab.url);
      if (cached && (Date.now() - cached.timestamp) < METADATA_CACHE_TTL) {
        resolve({ ...tab, ogDescription: cached.ogDescription });
        return;
      }

      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        resolve({ ...tab, ogDescription: null });
      }, 1000);

      chrome.tabs.sendMessage(tab.id, { action: "getMetadata" }, (response) => {
        if (timedOut) return;
        clearTimeout(timeout);

        if (chrome.runtime.lastError || !response) {
          resolve({ ...tab, ogDescription: null });
        } else {
          if (response.ogDescription) {
            pageMetadataCache.set(tab.url, {
              ogDescription: response.ogDescription,
              timestamp: Date.now()
            });
            persistMetadataCache();
          }
          resolve({ ...tab, ogDescription: response.ogDescription });
        }
      });
    });
  });

  Promise.all(metadataPromises).then(enrichedList => {
    if (avoidDupes) {
      enrichedList = mergeDuplicates(enrichedList);
    }
    callback(enrichedList);
  });
}

/**
 * Save each window as a separate session with "Window N - [timestamp]" naming
 */
function saveMultipleWindowSessions(tabsByWindow, callback) {
  chrome.storage.local.get(["savedSessions", "aiTitleSuggestions", "totalSessionsSaved"], (res) => {
    let sessions = res.savedSessions || [];
    const aiTitleEnabled = !!res.aiTitleSuggestions;
    const aiOperational = lastKnownAIAvailability !== false;
    const baseTitle = buildDefaultSessionTitle();
    const now = Date.now();

    // Sort windows by ID for consistent numbering
    const sortedWindows = tabsByWindow.sort((a, b) => a.windowId - b.windowId);

    // Count windows with tabs to determine if we need "Window N" prefix
    const windowsWithTabs = sortedWindows.filter(w => w.tabs.length > 0).length;
    const useWindowPrefix = windowsWithTabs > 1;

    // Create a session for each window, storing timestamps for AI title generation
    const sessionTimestamps = [];
    const baseTimestamp = Date.now();
    sortedWindows.forEach((windowData, index) => {
      if (windowData.tabs.length > 0) {
        const windowNumber = index + 1;
        const windowLabel = getLocalizedMessage('windowLabel') || 'Window';

        const windowTitle = useWindowPrefix
          ? `${windowLabel} ${windowNumber} - ${baseTitle}`
          : baseTitle;
        const hasEnoughTabsForTitle = windowData.tabs.length > 0;
        const shouldGenerateTitle = aiOperational && aiTitleEnabled && hasEnoughTabsForTitle;

        // Add index to ensure unique timestamps for each window
        const sessionTimestamp = new Date(baseTimestamp + index).toISOString();
        const newSession = {
          timestamp: sessionTimestamp,
          defaultTitle: windowTitle,
          tabs: windowData.tabs
        };

        debugWithMessage("saveMultipleWindowSessions creating session", {
          windowNumber,
          timestamp: sessionTimestamp,
          defaultTitle: windowTitle,
          tabCount: windowData.tabs.length,
          firstTabTitle: windowData.tabs[0]?.title
        });

        // If AI title generation is enabled, mark for async title generation
        if (shouldGenerateTitle) {
          newSession.pendingTitle = true;
          newSession.pendingTitleStartedAt = now;
        }

        sessions.unshift(newSession);
        sessionTimestamps.push(sessionTimestamp);
      }
    });

    chrome.storage.local.set({ savedSessions: sessions }, () => {
      // Increment counter for each window session saved
      const sessionsCreated = sortedWindows.filter(w => w.tabs.length > 0).length;
      const newCount = (res.totalSessionsSaved || 0) + sessionsCreated;
      chrome.storage.local.set({ totalSessionsSaved: newCount });

      // Update badge
      refreshBadge();

      // Schedule a backup after save
      scheduleBackupAfterSave();

      // Trigger AI title generation for each window session if enabled
      if (aiTitleEnabled && aiOperational) {
        debugWithMessage("saveMultipleWindowSessions triggering AI title generation", {
          windowCount: sortedWindows.filter(w => w.tabs.length > 0).length,
          timestamps: sessionTimestamps
        });

        sortedWindows.forEach((windowData, index) => {
          if (windowData.tabs.length > 0 && sessionTimestamps[index]) {
            debugWithMessage("saveMultipleWindowSessions calling generateAITitleInBackground", {
              index,
              timestamp: sessionTimestamps[index],
              tabCount: windowData.tabs.length,
              firstTabTitle: windowData.tabs[0]?.title
            });
            generateAITitleInBackground(sessionTimestamps[index], windowData.tabs);
          }
        });
      }

      callback(sessions);
    });
  });
}

// Helper functions to handle actions (shared between message handlers and keyboard commands)
function handleSaveTabs() {
  chrome.storage.local.get(["saveAllWindows", "aiSmartCategorization"], (settings) => {
    const saveAllWindows = !!settings.saveAllWindows;
    const aiEnabled = !!settings.aiSmartCategorization;

    if (!saveAllWindows) {
      // Original behavior: save current window only
      getTabList((tabList) => {
        saveSession(tabList, (sessions) => {
          if (!sessions) {
            return;
          }
          chrome.storage.local.get("popupBehavior", (res) => {
            if (res.popupBehavior === "saveOnly") {
              openOrFocusListTab(sessions);
            } else {
              openOrFocusListTab(sessions, tabList);
            }
          });
        });
      });
    } else {
      // New behavior: save tabs from all windows
      getAllWindowsTabList((tabsByWindow, allTabsList) => {
        if (aiEnabled) {
          // AI enabled: combine all tabs into single session
          saveSession(allTabsList, (sessions) => {
            if (!sessions) {
              return;
            }
            chrome.storage.local.get("popupBehavior", (res) => {
              if (res.popupBehavior === "saveOnly") {
                openOrFocusListTab(sessions);
              } else {
                openOrFocusListTab(sessions, allTabsList, true); // true = close tabs across all windows
              }
            });
          });
        } else {
          // AI disabled: save each window as separate session
          saveMultipleWindowSessions(tabsByWindow, (sessions) => {
            if (!sessions) {
              return;
            }
            chrome.storage.local.get("popupBehavior", (res) => {
              if (res.popupBehavior === "saveOnly") {
                openOrFocusListTab(sessions);
              } else {
                openOrFocusListTab(sessions, allTabsList, true); // true = close tabs across all windows
              }
            });
          });
        }
      });
    }
  });
}

function handleSaveTabsNoClose() {
  chrome.storage.local.get(["saveAllWindows", "aiSmartCategorization"], (settings) => {
    const saveAllWindows = !!settings.saveAllWindows;
    const aiEnabled = !!settings.aiSmartCategorization;

    if (!saveAllWindows) {
      getTabList((tabList) => {
        saveSession(tabList, () => {});
      });
    } else {
      getAllWindowsTabList((tabsByWindow, allTabsList) => {
        if (aiEnabled) {
          saveSession(allTabsList, () => {});
        } else {
          saveMultipleWindowSessions(tabsByWindow, () => {});
        }
      });
    }
  });
}

function handleSaveAndCloseIOS() {
  chrome.storage.local.get(["saveAllWindows", "aiSmartCategorization"], (settings) => {
    const saveAllWindows = !!settings.saveAllWindows;
    const aiEnabled = !!settings.aiSmartCategorization;

    function closeTabsAndOpenSaved(tabList) {
      // Open saved.html as background tab, then close original tabs
      chrome.tabs.create({ url: chrome.runtime.getURL("ios-popup.html#tabs-saved"), active: false }, (newTab) => {
        setTimeout(() => {
          closeOriginalTabs(newTab.id, tabList, saveAllWindows);
        }, 100);
      });
    }

    if (!saveAllWindows) {
      getTabList((tabList) => {
        saveSession(tabList, (sessions) => {
          if (!sessions) return;
          closeTabsAndOpenSaved(tabList);
        });
      });
    } else {
      getAllWindowsTabList((tabsByWindow, allTabsList) => {
        if (aiEnabled) {
          saveSession(allTabsList, (sessions) => {
            if (!sessions) return;
            closeTabsAndOpenSaved(allTabsList);
          });
        } else {
          saveMultipleWindowSessions(tabsByWindow, (sessions) => {
            if (!sessions) return;
            closeTabsAndOpenSaved(allTabsList);
          });
        }
      });
    }
  });
}

function handleSaveAndClose() {
  chrome.storage.local.get(["saveAllWindows", "aiSmartCategorization"], (settings) => {
    const saveAllWindows = !!settings.saveAllWindows;
    const aiEnabled = !!settings.aiSmartCategorization;

    if (!saveAllWindows) {
      // Original behavior: save current window only
      getTabList((tabList) => {
        saveSession(tabList, (sessions) => {
          if (!sessions) {
            return;
          }
          openOrFocusListTab(sessions, tabList); // false = current window only (default)
        });
      });
    } else {
      // New behavior: save tabs from all windows
      getAllWindowsTabList((tabsByWindow, allTabsList) => {
        if (aiEnabled) {
          // AI enabled: combine all tabs into single session
          saveSession(allTabsList, (sessions) => {
            if (!sessions) {
              return;
            }
            openOrFocusListTab(sessions, allTabsList, true); // true = close tabs across all windows
          });
        } else {
          // AI disabled: save each window as separate session
          saveMultipleWindowSessions(tabsByWindow, (sessions) => {
            if (!sessions) {
              return;
            }
            openOrFocusListTab(sessions, allTabsList, true); // true = close tabs across all windows
          });
        }
      });
    }
  });
}

function handleSaveSelectedTabs(selectedTabIds) {
  chrome.storage.local.get(["saveAllWindows", "popupBehavior", "avoidDuplicates", "pinnedTabs", "aiSmartCategorization"], (settings) => {
    const saveAllWindows = !!settings.saveAllWindows;
    const popupBehavior = settings.popupBehavior || "saveAndClose";
    const avoidDupes = settings.avoidDuplicates !== false;
    const skipPinned = !!settings.pinnedTabs;
    const aiEnabled = !!settings.aiSmartCategorization;

    // Always query all tabs since user has explicitly selected which tabs to save
    chrome.tabs.query({}, (allTabs) => {
      // Filter to valid tabs using the same logic as getAllWindowsTabList
      const validTabs = allTabs.filter(tab => {
        if (!tab.url) return false;
        if (tab.url.startsWith("safari-web-extension://")) return false;
        if (tab.url.startsWith("favorites://")) return false;
        if (tab.url === "about:blank") return false;
        if (skipPinned && tab.pinned) return false;
        return true;
      });

      // Filter to only the selected tabs
      const selectedTabs = allTabs.filter(tab => selectedTabIds.includes(tab.id));

      if (selectedTabs.length === 0) {
        return;
      }

      // Determine if all valid tabs are selected
      const allTabsSelected = selectedTabIds.length === validTabs.length;

      // Check if there are multiple windows involved
      const windowIds = new Set(selectedTabs.map(tab => tab.windowId));
      const multipleWindows = windowIds.size > 1;

      // If all tabs are selected and there are multiple windows, respect window organization
      if (allTabsSelected && multipleWindows && !aiEnabled) {
        // Group selected tabs by window
        const tabsByWindowId = new Map();
        for (const tab of selectedTabs) {
          if (!tabsByWindowId.has(tab.windowId)) {
            tabsByWindowId.set(tab.windowId, []);
          }
          tabsByWindowId.get(tab.windowId).push(tab);
        }

        // Process each window's tabs
        const windowProcessingPromises = [];
        for (const [windowId, tabs] of tabsByWindowId.entries()) {
          const promise = new Promise((resolve) => {
            processTabList(tabs, avoidDupes, (enrichedList) => {
              resolve({ windowId, tabs: enrichedList });
            });
          });
          windowProcessingPromises.push(promise);
        }

        Promise.all(windowProcessingPromises).then(tabsByWindow => {
          const allTabsList = tabsByWindow.flatMap(w => w.tabs);

          // Save each window as separate session
          saveMultipleWindowSessions(tabsByWindow, (sessions) => {
            if (!sessions) {
              return;
            }

            // Handle close behavior
            if (popupBehavior === "saveOnly") {
              openOrFocusListTab(sessions);
            } else {
              // Pass true for closeAllWindows since user selected tabs from multiple windows
              openOrFocusListTab(sessions, allTabsList, true);
            }
          });
        });
      } else {
        // Either subset selected, or all tabs in single window, or AI enabled
        // Save as single session
        processTabList(selectedTabs, avoidDupes, (tabList) => {
          saveSession(tabList, (sessions) => {
            if (!sessions) {
              return;
            }

            // Handle close behavior
            if (popupBehavior === "saveOnly") {
              openOrFocusListTab(sessions);
            } else {
              // Always query all windows since user explicitly selected tabs that may be from any window
              openOrFocusListTab(sessions, tabList, true);
            }
          });
        });
      }
    });
  });
}

function handleOpenList() {
  // First, check if there are any windows open at all
  chrome.windows.getAll({ populate: false }, (allWindows) => {
    if (allWindows.length === 0) {
      // No windows open => create a new window with about:blank, then update its tab to list.html
      chrome.windows.create({
        url: "about:blank",
        focused: true,
        populate: true
      }, (newWindow) => {
        if (newWindow && newWindow.tabs && newWindow.tabs.length > 0) {
          const tabId = newWindow.tabs[0].id;
          chrome.tabs.update(tabId, { url: chrome.runtime.getURL("list.html") });
        } else {
          // Fallback in case tabs array is missing or empty
          chrome.tabs.create({ windowId: newWindow.id, url: chrome.runtime.getURL("list.html") });
        }
      });
    } else {
      // Check for extension pages in the current window only (allows multiple windows with list.html)
      chrome.windows.getCurrent((currentWindow) => {
        chrome.tabs.query({ windowId: currentWindow.id }, (tabs) => {
          // Find any tabs that match our extension pages in the current window
          const extensionPageUrls = getExtensionPageUrls();
          const extensionTabs = tabs.filter(tab =>
            extensionPageUrls.some(url => tab.url && tab.url.startsWith(url))
          );

          if (extensionTabs.length > 0) {
            // Update existing extension tab to list.html and focus it
            const existingTab = extensionTabs[0];
            chrome.tabs.update(existingTab.id, { url: chrome.runtime.getURL("list.html"), active: true });
          } else {
            // Create new tab in current window
            chrome.tabs.create({ url: chrome.runtime.getURL("list.html") });
          }
        });
      });
    }
  });
}

// ---------------------------------------------------------
// Keyboard commands (Shift+Cmd+S => "save-tabs", etc.)
// ---------------------------------------------------------
chrome.commands.onCommand.addListener((command) => {
  chrome.storage.local.get(["enableKeyboardShortcuts"], (settings) => {
    const shortcutsEnabled = (typeof settings.enableKeyboardShortcuts === "boolean")
      ? settings.enableKeyboardShortcuts
      : true;
    if (!shortcutsEnabled) return;

    // Use the same helper functions as the message handlers
    if (command === "save-tabs") {
      chrome.storage.local.get(["popupBehavior"], (result) => {
        const mode = result.popupBehavior || "saveAndClose";
        if (mode === "saveOnly") {
          handleSaveTabs();
        } else {
          handleSaveAndClose();
        }
      });

    } else if (command === "open-list") {
      handleOpenList();

    } else if (command === "save-active-tab") {
      saveActiveTab();
    }
  });
});
