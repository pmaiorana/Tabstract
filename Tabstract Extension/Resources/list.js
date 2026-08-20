//
//  list.js
//  Tabstract
//
//  Created by Paul Maiorana on 3/16/25.
//

// =============================
// Debug Logging Helper
// =============================

let DEBUG_MODE = false;

// Load debug mode setting on startup
chrome.storage.local.get(['debugMode'], (result) => {
  DEBUG_MODE = !!result.debugMode;
  if (DEBUG_MODE) startElementInspectorPolling();
});

// =============================
// Click Freeze State
// =============================
// Prevents accidental clicks on links/sessions after menu closes
// Note: This integrates with the existing ignoreClicksUntil mechanism (defined around line 528)
// which is used by the document-level click handler to prevent mis-fired clicks
let clickFreezeTimeout = null;

function freezeClicks(duration = 250) {
  // Use the existing ignoreClicksUntil mechanism to prevent actual clicks
  ignoreClicksUntil = Date.now() + duration;

  // Add visual feedback that clicks are frozen
  document.body.classList.add('click-frozen');

  clearTimeout(clickFreezeTimeout);
  clickFreezeTimeout = setTimeout(() => {
    document.body.classList.remove('click-frozen');
  }, duration);
}

// =============================
// Submenu Positioning Helper
// =============================
// Positions submenus to avoid viewport overflow by flipping to the left if needed
function positionSubmenu(submenu) {
  // Reset position first
  submenu.classList.remove('flip-left');

  // Get submenu dimensions after it's visible
  const rect = submenu.getBoundingClientRect();
  const viewportWidth = window.innerWidth;

  // Check if submenu extends beyond viewport right edge
  if (rect.right > viewportWidth) {
    submenu.classList.add('flip-left');
  }
}

// =============================
// View Mode State
// =============================
// Flag to track if we're restoring view mode on page load (to skip animation)
let isRestoringViewMode = false;

// =============================
// Rainbow Sort Easter Egg
// =============================
// Color wheel order for rainbow sort (Red → Orange → Yellow → Green → Blue → Purple)
const COLOR_WHEEL_ORDER = {
  'red': 0,
  'orange': 1,
  'yellow': 2,
  'green': 3,
  'blue': 4,
  'purple': 5
};

// Flag to prevent infinite loop when storage changes trigger updates
let isUpdatingFromStorage = false;

// Listen for debug mode changes
chrome.storage.onChanged.addListener((changes) => {
  if (changes.debugMode) {
    DEBUG_MODE = !!changes.debugMode.newValue;
  }

  // Refresh sessions when storage changes (from any window or background script)
  if (changes.savedSessions && !isUpdatingFromStorage) {
    isUpdatingFromStorage = true;
    const newSessions = changes.savedSessions.newValue || [];
    savedSessions = newSessions;
    if (viewMode === 'fullscreen') {
      // In fullscreen/advanced mode, update fullscreen data directly (preserves sort config)
      // Avoids calling updateSessionList which renders compact mode and writes back to storage
      debug('[Storage Listener] savedSessions changed, updating fullscreen view');
      fullscreenData.allTabs = transformSessionsToTabs(newSessions);
      applyFiltersAndRender();
    } else {
      debug('[Storage Listener] savedSessions changed, calling updateSessionList');
      updateSessionList(newSessions);
    }
    // Reset flag after a brief delay to allow the update to complete
    setTimeout(() => {
      isUpdatingFromStorage = false;
    }, 100);
  } else if (changes.savedSessions) {
    debug('[Storage Listener] savedSessions changed but SKIPPED (isUpdatingFromStorage=true)');
  }
});

// Debug logging function
function debug(...args) {
  if (!DEBUG_MODE) return; // Early return avoids work when debug is off
  console.log('[Tabstract]', ...args);
  // Also send to native debug log file
  try {
    browser.runtime.sendNativeMessage("application.id", {
      action: "debugLog",
      level: "log",
      source: "list",
      message: args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ').substring(0, 10000)
    }).catch(() => {});
  } catch (e) {}
}

// Capture and send a debug snapshot of this page's DOM, CSS, and state
function captureDebugSnapshot() {
  // Collect all stylesheets (linked + inline) into one string
  let cssText = '';
  for (const sheet of document.styleSheets) {
    try {
      for (const rule of sheet.cssRules) {
        cssText += rule.cssText + '\n';
      }
    } catch (e) {
      // Cross-origin sheets can't be read; note them
      cssText += `/* Could not read: ${sheet.href || 'inline'} */\n`;
    }
  }

  const html = document.documentElement.outerHTML;
  chrome.storage.local.get(null, (storage) => {
    const meta = {
      url: location.href,
      timestamp: new Date().toISOString(),
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      darkMode: document.documentElement.classList.contains('dark-mode'),
      userAgent: navigator.userAgent
    };
    try {
      browser.runtime.sendNativeMessage("application.id", {
        action: "debugSnapshot",
        source: "list",
        html: html,
        css: cssText,
        storage: storage,
        meta: meta
      }).catch(() => {});
    } catch (e) {}
  });
}

// Auto-snapshot after page load (delayed so DOM is fully rendered)
setTimeout(() => {
  if (DEBUG_MODE) captureDebugSnapshot();
}, 2000);

// =============================
// Element Inspector (debug only)
// =============================

// Collect full inspection data for a DOM element
function inspectElement(selector) {
  const el = document.querySelector(selector);
  if (!el) return { error: `No element found for selector: ${selector}` };

  // 1. Computed Styles — all resolved CSS properties
  const computed = window.getComputedStyle(el);
  const computedStyles = {};
  for (let i = 0; i < computed.length; i++) {
    const prop = computed[i];
    computedStyles[prop] = computed.getPropertyValue(prop);
  }

  // Also get pseudo-element styles if they exist
  const pseudoBefore = window.getComputedStyle(el, '::before');
  const pseudoAfter = window.getComputedStyle(el, '::after');
  const beforeContent = pseudoBefore.getPropertyValue('content');
  const afterContent = pseudoAfter.getPropertyValue('content');
  const pseudoStyles = {};
  if (beforeContent && beforeContent !== 'none' && beforeContent !== 'normal') {
    pseudoStyles['::before'] = {};
    for (let i = 0; i < pseudoBefore.length; i++) {
      const prop = pseudoBefore[i];
      pseudoStyles['::before'][prop] = pseudoBefore.getPropertyValue(prop);
    }
  }
  if (afterContent && afterContent !== 'none' && afterContent !== 'normal') {
    pseudoStyles['::after'] = {};
    for (let i = 0; i < pseudoAfter.length; i++) {
      const prop = pseudoAfter[i];
      pseudoStyles['::after'][prop] = pseudoAfter.getPropertyValue(prop);
    }
  }

  // 2. Box Model / Layout Geometry
  const rect = el.getBoundingClientRect();
  const boxModel = {
    boundingClientRect: {
      x: rect.x, y: rect.y,
      width: rect.width, height: rect.height,
      top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left
    },
    offsetWidth: el.offsetWidth,
    offsetHeight: el.offsetHeight,
    clientWidth: el.clientWidth,
    clientHeight: el.clientHeight,
    scrollWidth: el.scrollWidth,
    scrollHeight: el.scrollHeight,
    scrollTop: el.scrollTop,
    scrollLeft: el.scrollLeft,
    offsetTop: el.offsetTop,
    offsetLeft: el.offsetLeft,
    isInViewport: (
      rect.top < window.innerHeight && rect.bottom > 0 &&
      rect.left < window.innerWidth && rect.right > 0
    ),
    isVisible: (
      computed.display !== 'none' &&
      computed.visibility !== 'hidden' &&
      computed.opacity !== '0' &&
      rect.width > 0 && rect.height > 0
    ),
    viewport: { width: window.innerWidth, height: window.innerHeight }
  };

  // 3. Element State & Attributes
  const attributes = {};
  for (const attr of el.attributes) {
    attributes[attr.name] = attr.value;
  }
  const state = {
    tagName: el.tagName.toLowerCase(),
    id: el.id || null,
    classList: Array.from(el.classList),
    attributes: attributes,
    dataset: Object.assign({}, el.dataset),
    textContent: (el.textContent || '').substring(0, 500),
    innerHTML: el.innerHTML.substring(0, 2000),
    childElementCount: el.childElementCount
  };
  // Input-specific state
  if (el instanceof HTMLInputElement) {
    state.inputType = el.type;
    state.value = el.value;
    state.checked = el.checked;
    state.disabled = el.disabled;
    state.placeholder = el.placeholder;
  } else if (el instanceof HTMLSelectElement) {
    state.value = el.value;
    state.selectedIndex = el.selectedIndex;
    state.disabled = el.disabled;
    state.options = Array.from(el.options).map(o => ({ value: o.value, text: o.text, selected: o.selected }));
  } else if (el instanceof HTMLTextAreaElement) {
    state.value = el.value;
    state.disabled = el.disabled;
  }
  // ARIA state
  const ariaAttrs = {};
  for (const attr of el.attributes) {
    if (attr.name.startsWith('aria-') || attr.name === 'role') {
      ariaAttrs[attr.name] = attr.value;
    }
  }
  if (Object.keys(ariaAttrs).length > 0) state.aria = ariaAttrs;

  // 4. Ancestor Chain — selector path from element to <html>
  const ancestors = [];
  let current = el;
  while (current && current !== document) {
    let desc = current.tagName.toLowerCase();
    if (current.id) desc += `#${current.id}`;
    if (current.classList.length > 0) desc += '.' + Array.from(current.classList).join('.');
    ancestors.push(desc);
    current = current.parentElement;
  }

  return {
    selector: selector,
    computedStyles: computedStyles,
    pseudoStyles: Object.keys(pseudoStyles).length > 0 ? pseudoStyles : undefined,
    boxModel: boxModel,
    elementState: state,
    ancestorChain: ancestors
  };
}

// Poll for element inspector requests (only in debug mode)
let _elementInspectorInterval = null;
function startElementInspectorPolling() {
  if (_elementInspectorInterval) return;
  _elementInspectorInterval = setInterval(() => {
    if (!DEBUG_MODE) return;
    browser.runtime.sendNativeMessage("application.id", {
      action: "checkElementInspectorRequest",
      source: "list"
    }).then((response) => {
      if (response && response.found && response.selector) {
        const result = inspectElement(response.selector);
        result.source = "list";
        result.timestamp = new Date().toISOString();
        browser.runtime.sendNativeMessage("application.id", {
          action: "elementInspectorResult",
          source: "list",
          ...result
        }).catch(() => {});
      }
    }).catch(() => {});
  }, 3000);
}

// Start polling when debug mode is on, stop when off
if (DEBUG_MODE) startElementInspectorPolling();
chrome.storage.onChanged.addListener((changes) => {
  if (changes.debugMode) {
    if (changes.debugMode.newValue) {
      startElementInspectorPolling();
    } else if (_elementInspectorInterval) {
      clearInterval(_elementInspectorInterval);
      _elementInspectorInterval = null;
    }
  }
});

// DEBUG: Check all active alarms (for debugging template schedules)
async function debugCheckAlarms() {
  debug('[ALARM DEBUG] === Checking all active alarms ===');

  // Get all alarms
  chrome.alarms.getAll((alarms) => {
    debug(`[ALARM DEBUG] Found ${alarms.length} total alarms`);

    if (alarms.length === 0) {
      debug('[ALARM DEBUG] ⚠️ NO ALARMS FOUND - this is the problem!');
      return;
    }

    const now = Date.now();
    alarms.forEach((alarm) => {
      const fireTime = new Date(alarm.scheduledTime);
      const minutesUntilFire = Math.round((alarm.scheduledTime - now) / 1000 / 60);
      const isPast = alarm.scheduledTime < now;

      debug(`[ALARM DEBUG] Alarm: ${alarm.name}`);
      debug(`  - Scheduled: ${fireTime.toLocaleString()}`);
      debug(`  - Status: ${isPast ? '⚠️ PAST DUE' : `⏰ ${minutesUntilFire} minutes from now`}`);
      debug(`  - Raw time: ${alarm.scheduledTime}`);

      if (alarm.name.startsWith('template-schedule-')) {
        const templateId = alarm.name.replace('template-schedule-', '');
        debug(`  - Template ID: ${templateId}`);
      }
    });
  });

  // Also check templates in storage
  chrome.storage.local.get(['savedTemplates'], (result) => {
    const templates = result.savedTemplates || [];
    const scheduledTemplates = templates.filter(t => t.schedule && t.schedule.enabled);

    debug(`[ALARM DEBUG] Found ${scheduledTemplates.length} templates with schedules enabled`);

    scheduledTemplates.forEach((template) => {
      debug(`[ALARM DEBUG] Template: ${template.name} (${template.id})`);
      debug(`  - Schedule type: ${template.schedule.type}`);
      debug(`  - Hour: ${template.schedule.hour}, Minute: ${template.schedule.minute}`);
      if (template.schedule.daysOfWeek) {
        debug(`  - Days of week: ${template.schedule.daysOfWeek.join(', ')}`);
      }
      if (template.schedule.dayOfMonth) {
        debug(`  - Day of month: ${template.schedule.dayOfMonth}`);
      }
      debug(`  - Last executed: ${template.schedule.lastExecuted || 'Never'}`);
    });
  });
}

// Make it globally accessible for console debugging
window.debugCheckAlarms = debugCheckAlarms;

// DEBUG: Manually trigger a template alarm for testing
async function debugTestTemplateAlarm(templateId) {
  debug(`[ALARM DEBUG] 🧪 Manually triggering alarm for template ${templateId}`);

  if (!templateId) {
    // If no templateId provided, show available templates
    chrome.storage.local.get(['savedTemplates'], (result) => {
      const templates = result.savedTemplates || [];
      debug('[ALARM DEBUG] Available templates:');
      templates.forEach(t => {
        debug(`  - ${t.name} (ID: ${t.id})`);
        if (t.schedule && t.schedule.enabled) {
          debug(`    Schedule: ${t.schedule.type} at ${t.schedule.hour}:${String(t.schedule.minute).padStart(2, '0')}`);
        }
      });
      debug('\nUsage: debugTestTemplateAlarm("template-id-here")');
    });
    return;
  }

  // Trigger the template alarm
  chrome.runtime.sendMessage({
    action: 'testTemplateAlarm',
    templateId: templateId
  });

  debug('[ALARM DEBUG] Test alarm triggered. Check console for results.');
}

window.debugTestTemplateAlarm = debugTestTemplateAlarm;

// DEBUG: Manually trigger the interval-based schedule check
async function debugCheckSchedulesNow() {
  debug('[ALARM DEBUG] 🔍 Manually triggering schedule check in background...');

  // Send message to background to trigger the check
  chrome.runtime.sendMessage({
    action: 'checkSchedulesNow'
  }, (response) => {
    if (chrome.runtime.lastError) {
      debug('[ALARM DEBUG] Error:', chrome.runtime.lastError.message);
    } else {
      debug('[ALARM DEBUG] Schedule check triggered. Watch for results in console.');
    }
  });
}

window.debugCheckSchedulesNow = debugCheckSchedulesNow;

// DEBUG: Check template notification settings and test notification
function debugCheckTemplateNotifications() {
  debug('[DEBUG] Checking template notification settings...');

  chrome.storage.local.get(['savedTemplates'], (result) => {
    const templates = result.savedTemplates || [];
    const scheduledTemplates = templates.filter(t => t.schedule && t.schedule.enabled);

    debug(`[DEBUG] Found ${scheduledTemplates.length} scheduled templates:`);
    scheduledTemplates.forEach(t => {
      debug(`  - ${t.name}:`);
      debug(`    notifyOnSpawn: ${t.notifyOnSpawn}`);
      debug(`    schedule enabled: ${t.schedule.enabled}`);
    });
  });

  // Test web Notification API
  debug('[DEBUG] Testing web Notification API...');
  debug('[DEBUG] Permission state:', typeof Notification !== 'undefined' ? Notification.permission : 'N/A');

  if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    const notification = new Notification('Tabstract Debug Test', {
      body: 'Template notification test from list.html',
      icon: chrome.runtime.getURL('images/icon-512.png')
    });
    debug('[DEBUG] ✅ Test notification displayed');
    setTimeout(() => notification.close(), 3000);
  } else {
    debug('[DEBUG] ⚠️ Permission not granted. Use debugTestNotification() to request permission.');
  }
}

window.debugCheckTemplateNotifications = debugCheckTemplateNotifications;

// DEBUG: Test native notification via macOS host app
async function debugTestNotification() {
  debug('[DEBUG] Testing native macOS notification...');

  try {
    const response = await browser.runtime.sendNativeMessage("application.id", {
      action: "showNotification",
      title: "Tabstract Test",
      body: "Native notifications are working! 🎉 Click to open Tabstract.",
      identifier: `debug-test-${Date.now()}`,
      extensionURL: chrome.runtime.getURL("list.html")
    });

    if (response && response.success) {
      debug('[DEBUG] ✅ Native notification sent successfully');
    } else if (response && response.error) {
      debug('[DEBUG] ❌ Native notification failed:', response.error);
    } else {
      debug('[DEBUG] ⚠️ Unexpected response:', response);
    }
  } catch (error) {
    debug('[DEBUG] ❌ Error:', error.message);
  }
}

window.debugTestNotification = debugTestNotification;

// DEBUG: Test scheduled ribbon on first session
function debugTestScheduledRibbon(color = null) {
  const firstWrapper = document.querySelector('.session-wrapper');
  if (!firstWrapper) {
    console.log('No session wrapper found');
    return;
  }

  // Remove existing ribbon if any
  const existing = firstWrapper.querySelector('.scheduled-ribbon');
  if (existing) existing.remove();

  const ribbon = document.createElement('div');
  ribbon.className = 'scheduled-ribbon';
  ribbon.innerHTML = '<svg class="icon" viewBox="0 0 32.25 31.8906" aria-hidden="true"><g><path d="M15.9375 31.875C24.7344 31.875 31.875 24.7344 31.875 15.9375C31.875 7.14062 24.7344 0 15.9375 0C7.14062 0 0 7.14062 0 15.9375C0 24.7344 7.14062 31.875 15.9375 31.875ZM15.9375 29.2188C8.59375 29.2188 2.65625 23.2812 2.65625 15.9375C2.65625 8.59375 8.59375 2.65625 15.9375 2.65625C23.2812 2.65625 29.2188 8.59375 29.2188 15.9375C29.2188 23.2812 23.2812 29.2188 15.9375 29.2188Z"/><path d="M7.76562 17.625L15.9219 17.625C16.5312 17.625 17.0156 17.1562 17.0156 16.5312L17.0156 6C17.0156 5.39062 16.5312 4.92188 15.9219 4.92188C15.3125 4.92188 14.8438 5.39062 14.8438 6L14.8438 15.4531L7.76562 15.4531C7.14062 15.4531 6.67188 15.9219 6.67188 16.5312C6.67188 17.1562 7.14062 17.625 7.76562 17.625Z"/></g></svg>';

  if (color) {
    ribbon.style.setProperty('--ribbon-color', color);
  }

  firstWrapper.appendChild(ribbon);
  console.log('Added scheduled ribbon to first session' + (color ? ` with color ${color}` : ''));
}
window.debugTestScheduledRibbon = debugTestScheduledRibbon;

// ============================================================================
// Template Schedule Checker - Runs while list.html is open
// ============================================================================
// Safari suspends service workers, so we run an interval here to check schedules
// while this page is open. This ensures reliable schedule execution.

let scheduleCheckInterval = null;

function startScheduleChecker() {
  // Clear any existing interval
  if (scheduleCheckInterval) {
    clearInterval(scheduleCheckInterval);
  }

  // Check immediately
  chrome.runtime.sendMessage({ action: 'checkSchedulesNow' });

  // Then check every 15 seconds
  scheduleCheckInterval = setInterval(() => {
    chrome.runtime.sendMessage({ action: 'checkSchedulesNow' });
  }, 15 * 1000); // Check every 15 seconds
}

// Stop the checker when the page unloads
window.addEventListener('beforeunload', () => {
  if (scheduleCheckInterval) {
    clearInterval(scheduleCheckInterval);
    scheduleCheckInterval = null;
  }
});

// Start the checker when the page loads
startScheduleChecker();

// ============================================================================

// Expose debug controls to console
window.Tabstract = {
  enableDebug: () => {
    chrome.storage.local.set({ debugMode: true }, () => {
      console.log('[Tabstract] Debug mode enabled');
    });
    return '✓ Debug mode enabled - reload the extension to see debug logs';
  },
  disableDebug: () => {
    chrome.storage.local.set({ debugMode: false }, () => {
      console.log('[Tabstract] Debug mode disabled');
    });
    return '✓ Debug mode disabled';
  },
  getDebugStatus: () => {
    chrome.storage.local.get(['debugMode'], (result) => {
      const status = !!result.debugMode ? 'enabled' : 'disabled';
      console.log('[Tabstract] Debug mode:', status);
    });
    return 'Status will be logged to console (check above)';
  },
};

// =============================
// Global Variables
// =============================

let collapsedSessions = {};

function computeFavicon(url) {
    const domain = new URL(url).hostname;
    return `https://favicone.com/${domain}?s=32`;
}

function generateDeleteId() {
    return "trash-" + Math.random().toString(36).substr(2, 8);
}

// Preload and reuse a shared transparent pixel for drag images.
// Safari cancels the first drag attempt if setDragImage is called with an
// <img> that hasn't finished decoding yet, so we warm it up at script load.
let invisibleDragImageReady = false;
const invisibleDragImage = (() => {
  const img = new Image();
  img.src = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
  img.width = 1;
  img.height = 1;
  if (img.complete) {
    invisibleDragImageReady = true;
  } else {
    img.addEventListener('load', () => {
      invisibleDragImageReady = true;
    }, { once: true });
  }
  if (img.decode) {
    img.decode().catch(() => {
      // Ignore decode errors – the drag fallback will display the native ghost.
    });
  }
  return img;
})();

// ------------------------------------------------
// Title Fetching Utilities
// ------------------------------------------------

/**
 * Fetches the page title for a given URL
 * @param {string} url - The URL to fetch the title from
 * @returns {Promise<string|null>} The page title or null if fetch failed
 */
async function fetchPageTitle(url) {
  debug('Fetching title for:', url);
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 second timeout

    const response = await fetch(url, {
      signal: controller.signal,
      method: 'GET',
      credentials: 'omit',
      cache: 'no-store'
    });

    clearTimeout(timeoutId);

    debug('Response status for', url, ':', response.status);

    // Reject error status codes - these often have generic/unhelpful titles
    if (!response.ok || response.status >= 400) {
      debug('Rejected due to status code:', response.status);
      return null;
    }

    // Also reject redirects that might have changed the URL significantly
    if (response.status >= 300 && response.status < 400) {
      debug('Rejected due to redirect');
      return null;
    }

    const html = await response.text();
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);

    if (titleMatch && titleMatch[1]) {
      const title = decodeHtmlEntities(titleMatch[1]).trim();

      debug('Found title for', url, ':', title);
      return title || null;
    }

    debug('No title tag found for', url);
    return null;
  } catch (error) {
    // Failed to fetch - could be CORS, timeout, network error, etc.
    debug('Fetch error for', url, ':', error.message);
    return null;
  }
}

function decodeHtmlEntities(str) {
  if (!str || typeof str !== 'string') return str;
  const textarea = document.createElement('textarea');
  textarea.innerHTML = str;
  return textarea.value;
}

function normalizeTrashedLinksData(links) {
  let changed = false;
  const normalized = (links || []).map(link => {
    if (!link || typeof link.title !== 'string') return link;
    if (!link.title.includes('&')) return link;
    const decoded = decodeHtmlEntities(link.title);
    if (decoded === link.title) return link;
    changed = true;
    return { ...link, title: decoded };
  });
  return { links: normalized, changed };
}

/**
 * Throttled queue for fetching page titles
 * Processes requests with a delay to avoid overwhelming the network
 */
class TitleFetchQueue {
  constructor(concurrency = 3, delayMs = 200) {
    this.queue = [];
    this.running = 0;
    this.concurrency = concurrency;
    this.delayMs = delayMs;
  }

  async add(url, tab) {
    return new Promise((resolve) => {
      this.queue.push({ url, tab, resolve });
      this.process();
    });
  }

  async process() {
    // Process multiple items concurrently up to the concurrency limit
    while (this.running < this.concurrency && this.queue.length > 0) {
      const item = this.queue.shift();
      this.running++;

      // Process this item without blocking other items
      (async () => {
        try {
          const title = await fetchPageTitle(item.url);
          if (title) {
            item.tab.title = title;
            debug('[Tabstract] Updated tab title to:', title);

            // Trigger callback if provided (for live UI updates)
            if (item.onUpdate) {
              item.onUpdate(title);
            }
          }
        } catch (error) {
          debug('Title fetch failed for', item.url, error);
        } finally {
          item.resolve();

          // Add delay before allowing next item
          setTimeout(() => {
            this.running--;
            this.process();
          }, this.delayMs);
        }
      })();
    }
  }

  // Add with optional callback for live updates
  async addWithCallback(url, tab, onUpdate) {
    return new Promise((resolve) => {
      this.queue.push({ url, tab, resolve, onUpdate });
      this.process();
    });
  }
}

// Auto-scroll helper: scrolls the window if the pointer is near the top or bottom.
function autoScroll(e) {
  const threshold = 200; // pixels from top/bottom edge to trigger scrolling
  const scrollSpeed = 7; // number of pixels to scroll per pointermove event
  if (e.clientY < threshold) {
    window.scrollBy(0, -scrollSpeed);
  } else if (e.clientY > window.innerHeight - threshold) {
    window.scrollBy(0, scrollSpeed);
  }
}

// We'll keep a local copy of savedSessions
let savedSessions = [];
const MAX_AI_TITLE_WORK_ATTEMPTS = 20;
let aiAvailabilityState = null;

// We'll store "pending" merges/deletes here until the undo timer finishes.
const pendingOperations = {};
// Track the last valid drop index so we don’t rely on elementFromPoint at pointerup
let lastSessionDropIndex = null;
let dragSourceIndex = null;
// Global variables for link-level dragging
let isLinkDragging = false;
let dragSourceLinkElement = null;
let dragSourceLinkSession = null;
let dragSourceLinkIndex = -1;
let linkDragPreview = null;
let linkOffsetX = 0;
let linkOffsetY = 0;

// New globals for drag threshold detection
let wasDraggingLink = false;
let linkDragStartX = 0;
let linkDragStartY = 0;

// Global variable to control suppression of mis-fired clicks
let ignoreClicksUntil = 0;

// Split mode globals
let isSplitMode = false;
let splitModeSessionTimestamp = null;
let splitModePreviewLine = null;

// Search functionality globals
let isSearchActive = false;
let allTabsData = []; // Store all tabs for searching

// Trash functionality globals
let currentView = 'active'; // 'active' or 'trash'
let trashedLinks = []; // Local copy of trashed items

const TRASH_FILTER_TOKEN = 'in:trash';
let shouldPrefillTrashFilter = true;
try {
  // Check effective language (localStorage first, then browser)
  const effectiveLang = window.getEffectiveLanguage ? window.getEffectiveLanguage() : (chrome.i18n.getUILanguage() || 'en');
  shouldPrefillTrashFilter = /^en\b/i.test(effectiveLang);
} catch (_) {
  shouldPrefillTrashFilter = true;
}

const AI_PENDING_TIMEOUT_MS = 15 * 1000; // 15 seconds

// ============================================================================
// Full Screen Mode globals
// ============================================================================
let viewMode = "compact"; // "compact" | "fullscreen"
let fullscreenData = {
  allTabs: [],           // Hierarchical list with sessions and tabs
  filteredTabs: [],      // After applying filters
  selectedTabIds: new Set(),
  collapsedSessions: new Set(), // Track which sessions are collapsed (expanded by default)
  sortConfig: {
    column: "dateCreated",
    direction: "desc"
  },
  sessionSortConfig: {   // Separate config for session-level sorting (preserved when sorting by domain)
    column: "dateCreated",
    direction: "desc"
  },
  tabSortConfig: {       // Separate config for tab-level sorting (preserved when sorting by session columns)
    column: "tabIndex",  // Default: preserve original tab order within sessions
    direction: "asc"
  },
  filters: {
    date: "all",
    domain: "all",
    color: "all",
    search: ""
  }
};

function recordAIAvailability(isAvailable) {
  if (isAvailable !== true && isAvailable !== false) return;
  aiAvailabilityState = isAvailable;
  if (!isAvailable) {
    clearPendingAIState();
  }
}

function clearPendingAIState() {
  chrome.storage.local.get(["savedSessions"], (result) => {
    let sessions = result.savedSessions || [];
    let changed = false;

    sessions = sessions.map((session) => {
      if (!session) return session;
      let mutated = false;
      const updated = { ...session };

      if (session.pendingCategorization) {
        delete updated.pendingCategorization;
        delete updated.pendingCategorizationStartedAt;
        mutated = true;
      }

      if (session.pendingTitle) {
        delete updated.pendingTitle;
        delete updated.pendingTitleStartedAt;
        mutated = true;
      }

      if (mutated) {
        changed = true;
        return updated;
      }
      return session;
    });

    if (changed) {
      chrome.storage.local.set({ savedSessions: sessions }, () => {
        updateSessionList(sessions);
      });
    } else {
      updateSessionList(sessions);
    }
  });
}

function hasTrashFilterPrefix(value) {
  return /^\s*in:trash\b/i.test(value || '');
}

function addTrashFilterPrefix(value) {
  const current = value || '';
  if (hasTrashFilterPrefix(current)) return current;
  if (!current.trim()) {
    return `${TRASH_FILTER_TOKEN} `;
  }
  return `${TRASH_FILTER_TOKEN} ${current}`;
}

function removeTrashFilterPrefix(value) {
  return (value || '').replace(/^\s*in:trash\s*/i, '').trim();
}

function sanitizePendingSessions(sessions, now = Date.now()) {
  let changed = false;
  const sanitized = sessions.map((session) => {
    if (!session) return session;
    let mutated = false;
    const updated = { ...session };

    if (session.pendingCategorization) {
      const started = typeof session.pendingCategorizationStartedAt === 'number'
        ? session.pendingCategorizationStartedAt
        : 0;
      if (!started || (now - started) > AI_PENDING_TIMEOUT_MS) {
        delete updated.pendingCategorization;
        delete updated.pendingCategorizationStartedAt;
        mutated = true;
      }
    }

    if (session.pendingTitle) {
      const started = typeof session.pendingTitleStartedAt === 'number'
        ? session.pendingTitleStartedAt
        : 0;
      if (!started || (now - started) > AI_PENDING_TIMEOUT_MS) {
        delete updated.pendingTitle;
        delete updated.pendingTitleStartedAt;
        mutated = true;
      }
    }

    if (Array.isArray(session.tabs)) {
      let tabsMutated = false;
      const normalizedTabs = session.tabs.map((tab) => {
        if (!tab || typeof tab.title !== 'string') return tab;
        if (!tab.title.includes('&')) return tab;
        const decoded = decodeHtmlEntities(tab.title);
        if (decoded === tab.title) return tab;
        tabsMutated = true;
        return { ...tab, title: decoded };
      });
      if (tabsMutated) {
        updated.tabs = normalizedTabs;
        mutated = true;
      }
    }

    if (mutated) {
      changed = true;
      return updated;
    }
    return session;
  });

  return { sanitized, changed };
}

function startPendingSessionWatchdog() {
  if (pendingWatchdogId) return;
  pendingWatchdogId = setInterval(() => {
    if (!savedSessions || savedSessions.length === 0) return;
    const result = sanitizePendingSessions(savedSessions);
    if (!result.changed) return;
    updateSessionList(result.sanitized);
  }, 30 * 1000);
}

// Install a document-level capturing click event listener to cancel clicks during our ignore window.
document.addEventListener('click', function(e) {
  if (Date.now() < ignoreClicksUntil) {
    e.stopImmediatePropagation();
    e.preventDefault();
  }
}, true);

// User-definable timeout for the undo bubble (in ms)
let UNDO_TIMEOUT_MS = 5000; // default
chrome.storage.local.get(["undoTimeoutSec"], (result) => {
  let timeout = parseInt(result.undoTimeoutSec, 10);
  if (!timeout || timeout <= 0) timeout = 5;
  UNDO_TIMEOUT_MS = timeout * 1000;
});

// We'll place undo bubbles in this container.
const undoContainer = document.createElement('div');
undoContainer.id = 'undoContainer';
document.body.appendChild(undoContainer);

// Ensure nav events are wired regardless of session render state
function wireTrashNav() {
  const trashBtn = document.getElementById('trashBtn');
  if (trashBtn && !trashBtn.dataset.bound) {
    trashBtn.dataset.bound = 'true';
    trashBtn.addEventListener('click', (e) => {
      // Prevent default anchor navigation; control view via JS
      e.preventDefault();
      if (currentView !== 'trash') {
        switchToTrashView();
      }
      // If already in trash, do nothing so we stay in trash
    });
  }
}

/**
 * Refresh the badge count on the extension action button.
 */
function refreshBadge() {
  // Small delay to ensure storage operations have completed
  setTimeout(() => {
    chrome.runtime.sendMessage({ action: "refreshBadge" });
  }, 10);
}

// =============================
// View Switching Functions
// =============================

/**
 * Switch to trash view
 */
function switchToTrashView() {
  currentView = 'trash';

  // Add trash-view class FIRST to immediately hide active sessions via CSS
  document.body.classList.add('trash-view');

  // Clear #tabList content immediately to prevent flash of active sessions
  const tabList = document.getElementById('tabList');
  if (tabList) {
    tabList.innerHTML = '';
  }

  // Save current mode and hide fullscreen immediately to prevent flash
  if (viewMode === 'fullscreen') {
    window.trashPreviousViewMode = 'fullscreen';
    // Hide fullscreen container immediately
    const fullscreenContainer = document.getElementById('fullscreen-container');
    if (fullscreenContainer) {
      fullscreenContainer.style.display = 'none';
    }
  } else {
    window.trashPreviousViewMode = 'compact';
  }

  // Make sure compact view is visible (trash renders in #tabList inside #main-content)
  const compactContainer = document.getElementById('main-content');
  if (compactContainer) {
    compactContainer.style.display = '';
  }
  const trashNav = document.getElementById('trashBtn');
  const homeNav = document.querySelector('.tabstract-nav .nav-item.home');
  if (trashNav) trashNav.classList.add('active');
  if (homeNav) homeNav.classList.remove('active');

  // Hide actions menu, inject trash controls
  const actionsMenuContainer = document.querySelector('.actions-menu-container');
  const headerSearch = document.querySelector('.header-search');
  if (actionsMenuContainer) actionsMenuContainer.style.display = 'none';

  // Add trash header controls if not already present
  if (headerSearch && !document.getElementById('trashHeaderControls')) {
    const emptyTrashText = getMessage("emptyTrash") || "Empty Trash";

    const trashControls = document.createElement('div');
    trashControls.id = 'trashHeaderControls';
    trashControls.className = 'trash-header-controls';
    trashControls.innerHTML = `
      <button id="emptyTrashBtn" class="empty-trash-header-btn">
        <svg viewBox="0 0 31.179 38.1519" aria-hidden="true">
          <path d="M10.8009 29.9681C11.4594 29.9681 11.8837 29.5509 11.8681 28.9366L11.3894 12.5553C11.3709 11.9465 10.9409 11.5422 10.3109 11.5422C9.65812 11.5422 9.23655 11.9594 9.25218 12.5709L9.71812 28.945C9.73655 29.5666 10.1694 29.9681 10.8009 29.9681ZM15.4034 29.9681C16.0506 29.9681 16.5062 29.5566 16.5062 28.9478L16.5062 12.5653C16.5062 11.9565 16.0506 11.5422 15.4034 11.5422C14.7534 11.5422 14.3106 11.9565 14.3106 12.5653L14.3106 28.9478C14.3106 29.5566 14.7534 29.9681 15.4034 29.9681ZM20.0159 29.9681C20.6375 29.9681 21.0675 29.5666 21.0859 28.945L21.5519 12.5709C21.5675 11.9594 21.1459 11.5422 20.4931 11.5422C19.8631 11.5422 19.4331 11.9465 19.4147 12.5681L18.9487 28.9366C18.9331 29.5509 19.3575 29.9681 20.0159 29.9681ZM8.305 7.18844L11.1887 7.18844L11.1887 3.94312C11.1887 3.13405 11.7547 2.61499 12.6247 2.61499L18.1537 2.61499C19.0237 2.61499 19.5897 3.13405 19.5897 3.94312L19.5897 7.18844L22.4734 7.18844L22.4734 3.79812C22.4734 1.40875 20.9484 0 18.3594 0L12.4191 0C9.83 0 8.305 1.40875 8.305 3.79812ZM1.3828 8.88842L29.434 8.88842C30.204 8.88842 30.804 8.27686 30.804 7.50686C30.804 6.74249 30.204 6.14375 29.434 6.14375L1.3828 6.14375C0.625622 6.14375 0 6.74249 0 7.50686C0 8.28967 0.625622 8.88842 1.3828 8.88842ZM8.22749 35.2581L22.5894 35.2581C24.9812 35.2581 26.5347 33.7937 26.6469 31.3991L27.7209 8.58873L24.8228 8.58873L23.7956 30.9337C23.7644 31.8712 23.1459 32.4937 22.255 32.4937L8.53624 32.4937C7.67092 32.4937 7.05248 31.8556 7.00842 30.9337L5.92998 8.58873L3.08312 8.58873L4.17 31.4119C4.285 33.8065 5.81 35.2581 8.22749 35.2581Z"/>
        </svg>
        <span class="empty-trash-text">${emptyTrashText}</span>
        <span class="empty-trash-count"></span>
      </button>
    `;

    // Insert before search box
    const searchBox = headerSearch.querySelector('.search-box');
    headerSearch.insertBefore(trashControls, searchBox);
  }

  // Prefill search box with trash filter token only for English locales
  const searchInput = document.getElementById('searchInput');
  if (searchInput) {
    const currentValue = searchInput.value || '';
    if (shouldPrefillTrashFilter) {
      const updatedValue = addTrashFilterPrefix(currentValue);
      if (updatedValue !== currentValue) {
        searchInput.value = updatedValue;
      }
    } else if (hasTrashFilterPrefix(currentValue)) {
      searchInput.value = removeTrashFilterPrefix(currentValue);
    }
    // Update clear button visibility
    const searchClear = document.getElementById('searchClear');
    if (searchClear) {
      if (searchInput.value.trim()) {
        searchClear.classList.add('visible');
      } else {
        searchClear.classList.remove('visible');
      }
    }
  }

  // In trash view, disable undo: immediately finalize any in-progress operations
  finalizeAllPendingOperations();

  // Render trash immediately from cached data (already kept in sync via updateTrash messages)
  renderTrashView();

  // Initialize search functionality (needed when deep-linking directly to trash view)
  initializeSearch();

  // After trash is loaded, clean up the mode state
  if (window.trashPreviousViewMode === 'fullscreen') {
    // Disable transitions for instant mode switch
    document.body.classList.add('no-transitions');

    viewMode = 'compact';
    document.body.setAttribute('data-view-mode', 'compact');
    exitFullScreenMode();
    updateFullScreenModeButtonState();
    updateCompactOnlyButtonsState();

    // Re-enable transitions after a brief delay
    requestAnimationFrame(() => {
      document.body.classList.remove('no-transitions');
    });
  }
}

/**
 * Switch to active sessions view
 */
function switchToActiveView() {
  currentView = 'active';
  document.body.classList.remove('trash-view');
  const trashNav = document.getElementById('trashBtn');
  const homeNav = document.querySelector('.tabstract-nav .nav-item.home');
  if (trashNav) trashNav.classList.remove('active');
  if (homeNav) homeNav.classList.add('active');

  // Restore compact view display
  const compactContainer = document.getElementById('main-content');
  if (compactContainer) {
    compactContainer.style.display = '';
  }

  // Restore previous view mode when leaving trash
  if (window.trashPreviousViewMode === 'fullscreen') {
    // Restore fullscreen display property
    const fullscreenContainer = document.getElementById('fullscreen-container');
    if (fullscreenContainer) {
      fullscreenContainer.style.display = '';
    }

    viewMode = 'fullscreen';
    document.body.setAttribute('data-view-mode', 'fullscreen');
    enterFullScreenMode();
    updateFullScreenModeButtonState();
    updateCompactOnlyButtonsState();
  }
  // Clear the saved state
  window.trashPreviousViewMode = null;

  // Show actions menu, remove trash controls
  const actionsMenuContainer = document.querySelector('.actions-menu-container');
  if (actionsMenuContainer) {
    actionsMenuContainer.style.display = '';
  }

  // Remove trash header controls if present
  const trashControls = document.getElementById('trashHeaderControls');
  if (trashControls) trashControls.remove();

  // Remove trash filter token from search box
  const searchInput = document.getElementById('searchInput');
  if (searchInput) {
    const currentValue = searchInput.value || '';
    const cleanedValue = removeTrashFilterPrefix(currentValue);
    searchInput.value = cleanedValue;
    // Update clear button visibility
    const searchClear = document.getElementById('searchClear');
    if (searchClear) {
      if (cleanedValue) {
        searchClear.classList.add('visible');
      } else {
        searchClear.classList.remove('visible');
      }
    }
  }

  // Reload sessions
  chrome.storage.local.get(["savedSessions"], (result) => {
    updateSessionList(result.savedSessions || []);
  });
}

/**
 * Toggle between views
 */
function toggleView() {
  if (currentView === 'active') {
    switchToTrashView();
  } else {
    switchToActiveView();
  }
}

/**
 * Finalize and clear all pending undo operations; remove any visible bubbles.
 * Undo is not available in trash view to prevent conflicts with restore.
 */
function finalizeAllPendingOperations() {
  const opIds = Object.keys(pendingOperations);
  opIds.forEach((opId) => {
    const op = pendingOperations[opId];
    if (!op) return;
    if (op.timerId) {
      clearTimeout(op.timerId);
      op.timerId = null;
    }
    finalizePendingOperation(opId);
  });
  // Remove any leftover bubbles just in case
  undoContainer.querySelectorAll('.undo-bubble').forEach(el => el.remove());
}

/**
 * Render the trash view with all trashed links
 */
function renderTrashView() {
  const container = document.getElementById('tabList');

  // Update header button count and search state (must happen before early return)
  const emptyTrashCount = document.querySelector('.empty-trash-count');
  if (emptyTrashCount) {
    emptyTrashCount.textContent = `(${trashedLinks.length})`;
  }

  const searchInput = document.getElementById('searchInput');
  if (searchInput) searchInput.disabled = (trashedLinks.length === 0);

  // Add event listener to header empty trash button
  const emptyTrashBtn = document.getElementById('emptyTrashBtn');
  if (emptyTrashBtn) {
    // Disable button if trash is empty
    emptyTrashBtn.disabled = (trashedLinks.length === 0);

    // Remove old listener if any
    const newBtn = emptyTrashBtn.cloneNode(true);
    emptyTrashBtn.parentNode.replaceChild(newBtn, emptyTrashBtn);
    // Add new listener
    newBtn.addEventListener('click', emptyTrash);
    // Re-apply disabled state after replacement
    newBtn.disabled = (trashedLinks.length === 0);
  }

  if (trashedLinks.length === 0) {
    // Empty trash state
    container.innerHTML = `
      <div class="trash-empty-state">
        <svg viewBox="0 0 31.179 38.1519" aria-hidden="true">
          <path fill="currentColor" d="M10.8009 29.9681C11.4594 29.9681 11.8837 29.5509 11.8681 28.9366L11.3894 12.5553C11.3709 11.9465 10.9409 11.5422 10.3109 11.5422C9.65812 11.5422 9.23655 11.9594 9.25218 12.5709L9.71812 28.945C9.73655 29.5666 10.1694 29.9681 10.8009 29.9681ZM15.4034 29.9681C16.0506 29.9681 16.5062 29.5566 16.5062 28.9478L16.5062 12.5653C16.5062 11.9565 16.0506 11.5422 15.4034 11.5422C14.7534 11.5422 14.3106 11.9565 14.3106 12.5653L14.3106 28.9478C14.3106 29.5566 14.7534 29.9681 15.4034 29.9681ZM20.0159 29.9681C20.6375 29.9681 21.0675 29.5666 21.0859 28.945L21.5519 12.5709C21.5675 11.9594 21.1459 11.5422 20.4931 11.5422C19.8631 11.5422 19.4331 11.9465 19.4147 12.5681L18.9487 28.9366C18.9331 29.5509 19.3575 29.9681 20.0159 29.9681ZM8.305 7.18844L11.1887 7.18844L11.1887 3.94312C11.1887 3.13405 11.7547 2.61499 12.6247 2.61499L18.1537 2.61499C19.0237 2.61499 19.5897 3.13405 19.5897 3.94312L19.5897 7.18844L22.4734 7.18844L22.4734 3.79812C22.4734 1.40875 20.9484 0 18.3594 0L12.4191 0C9.83 0 8.305 1.40875 8.305 3.79812ZM1.3828 8.88842L29.434 8.88842C30.204 8.88842 30.804 8.27686 30.804 7.50686C30.804 6.74249 30.204 6.14375 29.434 6.14375L1.3828 6.14375C0.625622 6.14375 0 6.74249 0 7.50686C0 8.28967 0.625622 8.88842 1.3828 8.88842ZM8.22749 35.2581L22.5894 35.2581C24.9812 35.2581 26.5347 33.7937 26.6469 31.3991L27.7209 8.58873L24.8228 8.58873L23.7956 30.9337C23.7644 31.8712 23.1459 32.4937 22.255 32.4937L8.53624 32.4937C7.67092 32.4937 7.05248 31.8556 7.00842 30.9337L5.92998 8.58873L3.08312 8.58873L4.17 31.4119C4.285 33.8065 5.81 35.2581 8.22749 35.2581Z"/>
        </svg>
        <h3>${getMessage("trashEmpty")}</h3>
        <p>${getMessage("trashEmptyDesc")}</p>
      </div>
    `;
    return;
  }

  // Group trash items by expiration timeframe
  const now = new Date();
  const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999).getTime();
  const endOfTomorrow = endOfToday + (24 * 60 * 60 * 1000);
  const nextWeek = now.getTime() + (7 * 24 * 60 * 60 * 1000);

  const groups = {
    today: [],
    tomorrow: [],
    thisWeek: [],
    soon: []
  };

  trashedLinks.forEach(link => {
    const expiresAt = link.expiresAt;
    if (expiresAt <= endOfToday) {
      groups.today.push(link);
    } else if (expiresAt <= endOfTomorrow) {
      groups.tomorrow.push(link);
    } else if (expiresAt <= nextWeek) {
      groups.thisWeek.push(link);
    } else {
      groups.soon.push(link);
    }
  });

  // Build trash HTML grouped by expiration (header controls are injected separately)
  let html = ``;

  // Helper function to render a group
  const renderGroup = (links, titleKey) => {
    if (links.length === 0) return '';

    const title = getMessage(titleKey);
    let groupHtml = `
      <div class="session-wrapper trash-group">
        <div class="session-header">
          <div class="session-title-container">
            <svg class="trash-group-icon" version="1.1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 30.252 37.0259">
              <g>
                <path d="M10.185 29.7998C9.70156 29.7998 9.39812 29.5083 9.37656 29.0453L8.86422 11.4353C8.85344 10.9734 9.16656 10.6759 9.65594 10.6759C10.1033 10.6759 10.432 10.9627 10.4428 11.41L10.9767 29.0405C10.9875 29.4878 10.6733 29.7998 10.185 29.7998ZM14.9458 29.7998C14.4672 29.7998 14.1373 29.4975 14.1373 29.0405L14.1373 11.4353C14.1373 10.9783 14.4672 10.6759 14.9458 10.6759C15.4244 10.6759 15.765 10.9783 15.765 11.4353L15.765 29.0405C15.765 29.4975 15.4244 29.7998 14.9458 29.7998ZM19.7077 29.8047C19.2242 29.8047 18.91 29.4975 18.9208 29.0453L19.4439 11.4256C19.4547 10.9675 19.7834 10.6808 20.2308 10.6808C20.7202 10.6808 21.0333 10.9783 21.0225 11.4402L20.5102 29.055C20.4886 29.5131 20.1803 29.8047 19.7077 29.8047ZM8.26078 6.78703L10.1736 6.78703L10.1736 3.47235C10.1736 2.4461 10.8713 1.805 11.9734 1.805L17.8869 1.805C18.9939 1.805 19.6916 2.4461 19.6916 3.47235L19.6916 6.78703L21.6044 6.78703L21.6044 3.36938C21.6044 1.26359 20.2422 0 17.9861 0L11.8694 0C9.62297 0 8.26078 1.26359 8.26078 3.36938ZM0.915158 7.74641L28.9823 7.74641C29.4825 7.74641 29.877 7.32547 29.877 6.83016C29.877 6.32516 29.4777 5.91984 28.9823 5.91984L0.915158 5.91984C0.430626 5.91984 0 6.33 0 6.83016C0 7.3411 0.430626 7.74641 0.915158 7.74641ZM7.86219 34.453L22.0305 34.453C24.042 34.453 25.4936 33.058 25.5933 31.0609L26.7645 7.42313L3.12703 7.42313L4.30906 31.0717C4.40875 33.0688 5.83391 34.453 7.86219 34.453Z"/>
              </g>
            </svg>
            <h3 class="session-title">${title}</h3>
          </div>
        </div>
        <div class="tab-list">
    `;

    links.forEach(link => {
      const timeRemaining = getTimeRemaining(link.expiresAt);
      // Exact local expiration time for hover title
      let expiresExact = '';
      try {
        expiresExact = new Date(link.expiresAt).toLocaleString(window.getEffectiveLocale ? window.getEffectiveLocale() : navigator.language, {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
          second: '2-digit',
          timeZoneName: 'short'
        });
      } catch (_) {
        expiresExact = new Date(link.expiresAt).toString();
      }
      let savedLabel = '';
      if (link.originalSavedAt) {
        try {
          const iso = new Date(link.originalSavedAt).toISOString().slice(0,10);
          savedLabel = getMessage('savedOnLabel', [iso]) || `Saved: ${iso}`;
        } catch (_) {}
      }
      const faviconUrl = computeFavicon(link.url);
      const displayTitle = decodeHtmlEntities(link.title || '');

      groupHtml += `
        <div class="trash-item">
          <div class="favicon-wrap">
            <img src="${faviconUrl}" alt="Favicon" width="16" height="16" onerror="this.style.display='none'">
          </div>
          <div class="trash-content">
            <a href="${escapeHtml(link.url)}" class="trash-title trash-link" data-url="${escapeHtml(link.url)}" title="${escapeHtml(link.url)}" tabindex="0">${escapeHtml(displayTitle)}</a>
            <div class="trash-meta">${savedLabel ? `${savedLabel} • ` : ''}<span class="expires-remaining" title="${escapeHtml(expiresExact)}">${timeRemaining}</span></div>
          </div>
          <div class="trash-actions">
            <a href="#" class="open-session-link" title="${getMessage('bulkActionRestore')}" data-link-id="${link.id}" tabindex="0" aria-label="${getMessage('bulkActionRestore')} ${escapeHtml(displayTitle)}">
              <svg viewBox="0 0 28.0382 27.6857" aria-hidden="true">
               <g>
                <path d="M4.20878 27.6632L23.4431 27.6632C26.2182 27.6632 27.6632 26.1888 27.6632 23.465L27.6632 4.20253C27.6632 1.47876 26.2182 0 23.4431 0L4.20878 0C1.44938 0 0 1.44501 0 4.20253L0 23.465C0 26.2225 1.44938 27.6632 4.20878 27.6632ZM4.25128 26.5087C2.22755 26.5087 1.16568 25.4444 1.16568 23.4031L1.16568 4.2644C1.16568 2.22317 2.22755 1.16568 4.25128 1.16568L23.4119 1.16568C25.375 1.16568 26.4975 2.22317 26.4975 4.2644L26.4975 23.4031C26.4975 25.4444 25.375 26.5087 23.4119 26.5087Z"/>
                <path d="M14.4432 20.1081L14.4432 7.51941C14.4432 7.16127 14.1775 6.90688 13.8238 6.90688C13.4969 6.90688 13.2356 7.17252 13.2356 7.51941L13.2356 20.1081C13.2356 20.4506 13.4969 20.7275 13.8238 20.7275C14.1775 20.7275 14.4432 20.4663 14.4432 20.1081ZM7.53941 14.4188L20.1438 14.4188C20.475 14.4188 20.7519 14.1507 20.7519 13.835C20.7519 13.4813 20.4975 13.2044 20.1438 13.2044L7.53941 13.2044C7.18127 13.2044 6.93126 13.4813 6.93126 13.835C6.93126 14.1507 7.20377 14.4188 7.53941 14.4188Z"/>
               </g>
              </svg>
            </a>
            <a href="#" class="delete-session-link" title="${getMessage('draftDelete')}" data-link-id="${link.id}" tabindex="0" aria-label="${getMessage('draftDelete')} ${escapeHtml(displayTitle)}">
              <svg version="1.1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 28.0382 27.6857" aria-hidden="true">
               <g>
                <path d="M4.20878 27.6632L23.4431 27.6632C26.2182 27.6632 27.6632 26.1888 27.6632 23.465L27.6632 4.20253C27.6632 1.47876 26.2182 0 23.4431 0L4.20878 0C1.44938 0 0 1.44501 0 4.20253L0 23.465C0 26.2225 1.44938 27.6632 4.20878 27.6632ZM4.25128 26.5087C2.22755 26.5087 1.16568 25.4444 1.16568 23.4031L1.16568 4.2644C1.16568 2.22317 2.22755 1.16568 4.25128 1.16568L23.4119 1.16568C25.375 1.16568 26.4975 2.22317 26.4975 4.2644L26.4975 23.4031C26.4975 25.4444 25.375 26.5087 23.4119 26.5087Z"/>
                <path d="M8.72005 19.8513L19.8669 8.70005C20.0157 8.55567 20.0732 8.40504 20.0732 8.23003C20.0732 7.89127 19.8075 7.63688 19.4531 7.63688C19.2669 7.63688 19.1319 7.69439 18.9762 7.85439L7.80502 19.0081C7.66064 19.1569 7.59876 19.2919 7.59876 19.4713C7.59876 19.8144 7.88002 20.0732 8.23003 20.0732C8.43629 20.0732 8.56442 20.0069 8.72005 19.8513ZM18.9675 19.8513C19.1231 20.0069 19.2513 20.0732 19.4531 20.0732C19.8075 20.0732 20.0732 19.8144 20.0732 19.4713C20.0732 19.2919 20.0157 19.1569 19.8669 19.0081L8.7113 7.85439C8.55567 7.69439 8.41629 7.63688 8.23003 7.63688C7.88002 7.63688 7.59876 7.89127 7.59876 8.23003C7.59876 8.40504 7.66064 8.55567 7.80502 8.70005Z"/>
               </g>
              </svg>
            </a>
          </div>
        </div>
      `;
    });

    groupHtml += `
        </div>
      </div>
    `;
    return groupHtml;
  };

  // Render groups in order
  html += renderGroup(groups.today, 'trashExpiringToday');
  html += renderGroup(groups.tomorrow, 'trashExpiringTomorrow');
  html += renderGroup(groups.thisWeek, 'trashExpiringThisWeek');
  html += renderGroup(groups.soon, 'trashExpiringSoon');

  container.innerHTML = html;

  // Add event listeners for restore and delete actions
  const restoreIcons = container.querySelectorAll('.trash-actions .open-session-link');
  restoreIcons.forEach(a => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const linkId = e.currentTarget.getAttribute('data-link-id');
      restoreLink(linkId);
    });
  });

  const deleteIcons = container.querySelectorAll('.trash-actions .delete-session-link');
  deleteIcons.forEach(a => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const linkId = e.currentTarget.getAttribute('data-link-id');
      permanentlyDeleteLink(linkId);
    });
  });
  // Make trash titles clickable to open the link, but do NOT remove from trash
  const trashLinks = container.querySelectorAll('.trash-link');
  trashLinks.forEach(a => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const url = e.currentTarget.getAttribute('data-url');
      const altKey = e.altKey; // support Option to invert background
      chrome.runtime.sendMessage({
        action: 'openSingleTab',
        url,
        invertBackground: !!altKey
        // Intentionally omit timestamp and invertDelete so nothing is removed anywhere
      });
    });
  });

  // Setup hover handlers for trash item borders
  setupTrashItemBorderHandlers();
}

/**
 * Setup hover handlers to hide borders on trash items
 */
function setupTrashItemBorderHandlers() {
  const trashItems = document.querySelectorAll('.trash-item');

  trashItems.forEach(item => {
    item.addEventListener('mouseenter', () => {
      item.classList.add('trash-hover');
      // Add class to previous sibling to hide its bottom border
      if (item.previousElementSibling && item.previousElementSibling.classList.contains('trash-item')) {
        item.previousElementSibling.classList.add('trash-hover-next');
      }
    });

    item.addEventListener('mouseleave', () => {
      item.classList.remove('trash-hover');
      if (item.previousElementSibling && item.previousElementSibling.classList.contains('trash-item')) {
        item.previousElementSibling.classList.remove('trash-hover-next');
      }
    });
  });
}

/**
 * Get human-readable time remaining until expiration
 */
function getTimeRemaining(expiresAt) {
  const now = Date.now();
  const remaining = expiresAt - now;

  if (remaining <= 0) return getMessage('expiredLabel') || "Expired";

  const days = Math.floor(remaining / (24 * 60 * 60 * 1000));
  const hours = Math.floor((remaining % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));

  if (days > 0) {
    return getMessage('expiresInDays', [String(days)]) || `Expires in ${days} days`;
  } else if (hours > 0) {
    return getMessage('expiresInHours', [String(hours)]) || `Expires in ${hours} hours`;
  } else {
    return getMessage('expiresInLessThanHour') || "Expires in < 1 hour";
  }
}

/**
 * Restore a link from trash
 */
function restoreLink(linkId) {

  // CLIENT-SIDE RESTORE: Handle trash restoration directly, bypassing background.js
  chrome.storage.local.get(['trashedLinks', 'savedSessions'], (result) => {
    let localTrashedLinks = result.trashedLinks || [];
    let localSavedSessions = result.savedSessions || [];

    // Find the trashed link
    const trashedLinkIndex = localTrashedLinks.findIndex(item => item.id === linkId);
    if (trashedLinkIndex === -1) {
      debug('Trashed link not found:', linkId);
      return;
    }

    const trashedLink = localTrashedLinks[trashedLinkIndex];
    const restoredTitle = decodeHtmlEntities(trashedLink.title || '');

    // Create tab object for the restored link
    const restoredTab = {
      url: trashedLink.url,
      title: restoredTitle
    };

    // Look for existing localized "Restored From Trash" session
    const restoredSessionName = getMessage("restoredFromTrashSessionName") || "Restored From Trash";
    let existingSession = localSavedSessions.find(session =>
      (session.customName === restoredSessionName) ||
      (session.defaultTitle === restoredSessionName)
    );

    if (existingSession) {
      // Add to existing "Restored From Trash" session
      existingSession.tabs.push(restoredTab);
    } else {
      // Create new "Restored From Trash" session
      const newSession = {
        timestamp: new Date().toISOString(),
        customName: restoredSessionName,
        defaultTitle: restoredSessionName,
        tabs: [restoredTab]
      };
      localSavedSessions.unshift(newSession); // Add to beginning (most recent)
    }

    // Remove the link from trash
    localTrashedLinks.splice(trashedLinkIndex, 1);

    // Save everything back
    chrome.storage.local.set({
      trashedLinks: localTrashedLinks,
      savedSessions: localSavedSessions
    }, () => {
      refreshBadge();

      // Update global trashedLinks and re-render if in trash view
      if (currentView === 'trash') {
        // Update global variable with the updated data
        trashedLinks = localTrashedLinks;
        // Re-render trash view immediately
        renderTrashView();
      } else {
        // Only update session list if we're not in trash view
        updateSessionList(localSavedSessions);
      }
    });
  });
}

/**
 * Permanently delete a link from trash
 */
function permanentlyDeleteLink(linkId) {
  if (confirm(getMessage("confirmDeleteFromTrash"))) {
    chrome.runtime.sendMessage({ action: "permanentlyDeleteFromTrash", linkId });
  }
}

/**
 * Empty all trash
 */
function emptyTrash() {
  if (confirm(getMessage("confirmEmptyTrash"))) {
    chrome.runtime.sendMessage({ action: "emptyTrash" });
  }
}

/**
 * On load, fetch sessions *and* collapsed state from storage and render.
 */
debug(`[INITIAL LOAD] ⏰ Timestamp: ${Date.now()}, viewMode="${viewMode}", isRestoringViewMode=${isRestoringViewMode}`);
chrome.storage.local.get(["savedSessions","collapsedSessions","trashedLinks","viewMode"], (result) => {
  // Set view mode FIRST before any rendering
  const savedViewMode = result.viewMode;

  debug(`[INITIAL LOAD] 📦 Got from storage: sessions=${result.savedSessions?.length || 0}, savedViewMode="${savedViewMode}"`);

  // Set restoration flag and viewMode before rendering
  if (savedViewMode === "fullscreen") {
    viewMode = "fullscreen";
    isRestoringViewMode = true;
    debug('[INITIAL LOAD] ✓ Set viewMode="fullscreen" and isRestoringViewMode=true');
  } else if (savedViewMode) {
    viewMode = savedViewMode;
    debug(`[INITIAL LOAD] ✓ Set viewMode="${viewMode}"`);
  }

  // Set body attribute immediately if DOM is ready
  if (document.body) {
    // Disable transitions during initial load to prevent animation
    document.body.classList.add('no-transitions');
    document.body.setAttribute("data-view-mode", viewMode);
    debug(`[INITIAL LOAD] ✓ Set body[data-view-mode="${viewMode}"]`);
  }

  collapsedSessions = result.collapsedSessions || {};
  const normalizedTrash = normalizeTrashedLinksData(result.trashedLinks || []);
  trashedLinks = normalizedTrash.links;
  if (normalizedTrash.changed) {
    chrome.storage.local.set({ trashedLinks: trashedLinks });
  }

  // Sanitize sessions: remove null sessions and null tabs within sessions
  let sessions = result.savedSessions || [];
  let sanitizationNeeded = false;
  sessions = sessions.filter(session => {
    if (!session) {
      sanitizationNeeded = true;
      debug('[INITIAL LOAD] Removed null session from data');
      return false;
    }
    return true;
  }).map(session => {
    if (session.tabs && Array.isArray(session.tabs)) {
      const originalLength = session.tabs.length;
      const filteredTabs = session.tabs.filter(tab => tab !== null && tab !== undefined);
      if (filteredTabs.length !== originalLength) {
        sanitizationNeeded = true;
        debug(`[INITIAL LOAD] Removed ${originalLength - filteredTabs.length} null tab(s) from session "${session.customName || session.defaultTitle}"`);
        return { ...session, tabs: filteredTabs };
      }
    }
    return session;
  });
  if (sanitizationNeeded) {
    debug('[INITIAL LOAD] Saving sanitized sessions to storage');
    chrome.storage.local.set({ savedSessions: sessions });
  }

  // Kill any STUCK pending AI states on page load (only those that have timed out)
  const now = Date.now();
  let aiStatesCleaned = false;
  sessions = sessions.map((session) => {
    if (!session) return session;
    let needsUpdate = false;
    const updated = { ...session };

    // Only kill pendingCategorization if it's actually stuck (no timestamp or timed out)
    if (session.pendingCategorization) {
      const started = typeof session.pendingCategorizationStartedAt === 'number'
        ? session.pendingCategorizationStartedAt
        : 0;
      const age = started ? (now - started) : -1;
      debug('[Tabstract] Checking pendingCategorization:', {
        timestamp: session.timestamp,
        started,
        age,
        timeout: AI_PENDING_TIMEOUT_MS,
        willClean: !started || age > AI_PENDING_TIMEOUT_MS
      });
      if (!started || (now - started) > AI_PENDING_TIMEOUT_MS) {
        delete updated.pendingCategorization;
        delete updated.pendingCategorizationStartedAt;
        needsUpdate = true;
        debug('[Tabstract] Cleaned stuck AI categorization for session:', session.timestamp);
      }
    }

    // Only kill pendingTitle if it's actually stuck (no timestamp or timed out)
    if (session.pendingTitle) {
      const started = typeof session.pendingTitleStartedAt === 'number'
        ? session.pendingTitleStartedAt
        : 0;
      const age = started ? (now - started) : -1;
      debug('[Tabstract] Checking pendingTitle:', {
        timestamp: session.timestamp,
        started,
        age,
        timeout: AI_PENDING_TIMEOUT_MS,
        willClean: !started || age > AI_PENDING_TIMEOUT_MS
      });
      if (!started || (now - started) > AI_PENDING_TIMEOUT_MS) {
        delete updated.pendingTitle;
        delete updated.pendingTitleStartedAt;
        needsUpdate = true;
        debug('[Tabstract] Cleaned stuck AI title generation for session:', session.timestamp);
      }
    }

    if (needsUpdate) {
      aiStatesCleaned = true;
      return updated;
    }
    return session;
  });

  if (aiStatesCleaned) {
    chrome.storage.local.set({ savedSessions: sessions });
  }

  // Fix any duplicate timestamps (can happen from race conditions in duplicate operations)
  const timestampCounts = new Map();
  let hasDuplicates = false;
  sessions.forEach(session => {
    const count = timestampCounts.get(session.timestamp) || 0;
    timestampCounts.set(session.timestamp, count + 1);
    if (count > 0) hasDuplicates = true;
  });

  if (hasDuplicates) {
    debug('[INITIAL LOAD] Found duplicate timestamps, fixing...');
    const seenTimestamps = new Set();
    sessions = sessions.map(session => {
      if (seenTimestamps.has(session.timestamp)) {
        // Generate new unique timestamp
        let newTimestamp = new Date().toISOString();
        while (seenTimestamps.has(newTimestamp)) {
          // Add a millisecond to ensure uniqueness
          newTimestamp = new Date(new Date(newTimestamp).getTime() + 1).toISOString();
        }
        debug(`[INITIAL LOAD] Fixed duplicate timestamp ${session.timestamp} -> ${newTimestamp}`);
        seenTimestamps.add(newTimestamp);
        return { ...session, timestamp: newTimestamp };
      }
      seenTimestamps.add(session.timestamp);
      return session;
    });
    chrome.storage.local.set({ savedSessions: sessions });
  }

  // Always wire nav events ASAP
  wireTrashNav();

  // Deep link support: open directly in trash if requested via hash or query
  let wantsTrash = false;
  try {
    wantsTrash = (window.location.hash === '#trash') ||
      (new URLSearchParams(window.location.search).get('view') === 'trash');
  } catch (e) {
    debug('Unable to parse deep link for trash:', e);
  }

  if (wantsTrash) {
    // Set trash view immediately and skip initial active render
    switchToTrashView();
  } else {
    // Default: render active sessions and mark Home active
    updateSessionList(sessions);
    const trashNav = document.getElementById('trashBtn');
    const homeNav = document.querySelector('.tabstract-nav .nav-item.home');
    if (trashNav) trashNav.classList.remove('active');
    if (homeNav) homeNav.classList.add('active');
  }
  // Ensure badge is current when list.html loads
  refreshBadge();
  // Respond to future hash changes (e.g., user clicks #trash link)
  window.addEventListener('hashchange', () => {
    if (window.location.hash === '#trash') {
      switchToTrashView();
    }
  });
});

/**
 * Show AI unavailability modal (only once per session)
 */
let aiUnavailableModalShown = false;

function showAIUnavailableModal() {
  // Only show once per page load
  if (aiUnavailableModalShown) {
    debug('[Tabstract] AI modal already shown, skipping');
    return;
  }
  aiUnavailableModalShown = true;

  debug('[Tabstract] Creating AI unavailable modal');

  // Create modal backdrop
  const backdrop = document.createElement('div');
  backdrop.className = 'ai-modal-backdrop';

  // Create modal container
  const modal = document.createElement('div');
  modal.className = 'ai-modal';

  // Create modal content
  const title = document.createElement('h2');
  title.className = 'ai-modal-title';
  title.textContent = 'Apple Intelligence Unavailable';

  const message = document.createElement('p');
  message.className = 'ai-modal-message';
  message.innerHTML = getMessage("aiNotAvailable") ||
    "Apple Intelligence is not available. Please check your system settings to ensure it is enabled and working, and then restart Safari.";

  const dismissBtn = document.createElement('button');
  dismissBtn.className = 'ai-modal-dismiss';
  dismissBtn.textContent = 'OK';
  dismissBtn.setAttribute('aria-label', 'Dismiss Apple Intelligence unavailable message');

  const closeModal = () => {
    backdrop.classList.remove('show');
    setTimeout(() => backdrop.remove(), 300);
    document.removeEventListener('keydown', handleKeydown);
  };

  dismissBtn.onclick = closeModal;

  // Allow clicking backdrop to dismiss
  backdrop.onclick = (e) => {
    if (e.target === backdrop) {
      closeModal();
    }
  };

  // Allow Escape key to dismiss
  const handleKeydown = (e) => {
    if (e.key === 'Escape') {
      closeModal();
    }
  };
  document.addEventListener('keydown', handleKeydown);

  modal.appendChild(title);
  modal.appendChild(message);
  modal.appendChild(dismissBtn);
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  debug('[Tabstract] AI modal added to DOM, backdrop:', backdrop, 'modal:', modal);

  // Trigger animation
  requestAnimationFrame(() => {
    backdrop.classList.add('show');
    debug('[Tabstract] AI modal animation triggered');
  });

  // Focus the OK button for accessibility
  setTimeout(() => {
    dismissBtn.focus();
    debug('[Tabstract] AI modal button focused');
  }, 100);
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.action === "captureDebugSnapshot") {
    if (DEBUG_MODE) captureDebugSnapshot();
    return;
  }
  if (message.action === "debugLog") {
    // Receive debug logs from background script
    debug(`[DEBUG from ${message.source}] ${message.message}:`, message.data);

    // Show user-visible warning if AI is not available
    if (message.message === "categorizeAITabsSingle: AI not available" ||
        message.message === "generateAITitle: AI not available") {
      recordAIAvailability(false);
      showAIUnavailableModal();
    } else if (message.message === "AI availability check") {
      if (message.data && typeof message.data.available === 'boolean') {
        recordAIAvailability(message.data.available);
      }
    } else if (message.message === "AI availability check failed" ||
               message.message === "categorizeAITabsSingle exception" ||
               message.message === "categorizeAITabsSingle poll error") {
      recordAIAvailability(false);
    } else if (message.message === "categorizeAITabsSingle: success") {
      recordAIAvailability(true);
    } else if (message.message === "generateAITitle result") {
      if ((message.data && message.data.success === true) ||
          (message.data && typeof message.data.title === 'string' && message.data.title.length > 0)) {
        recordAIAvailability(true);
      }
    }
  } else if (message.action === "setTabList") {
    savedSessions = message.savedSessions;
    if (viewMode === 'fullscreen') {
      fullscreenData.allTabs = transformSessionsToTabs(message.savedSessions);
      applyFiltersAndRender();
    } else {
      updateSessionList(message.savedSessions);
    }
    // Ensure badge is updated when receiving new session data from background
    refreshBadge();
  } else if (message.action === "refreshSessions") {
    // Refresh session list with animation
    const activeInput = document.querySelector('.session-title-input');
    if (!activeInput) {
      chrome.storage.local.get(["savedSessions"], (result) => {
        const sessions = result.savedSessions || [];

        // If a new session timestamp was provided (e.g., from scheduled template),
        // use the same animation as manual session additions
        if (message.newSessionTimestamp) {
          updateSessionList(sessions);
          setTimeout(() => {
            highlightAddSession(message.newSessionTimestamp);
          }, 50);
        } else {
          // AI title was generated - animate changed titles
          updateSessionListWithAnimation(sessions);
        }

        // Also update advanced mode data if in fullscreen mode
        if (viewMode === 'fullscreen') {
          fullscreenData.allTabs = transformSessionsToTabs(sessions);
          applyFiltersAndRender();
        }
      });
    }
  } else if (message.action === "titleGenerationState") {
    if (message.state === 'started') {
      markTitleGenerationInProgress(message.timestamp);
    }
  } else if (message.action === "titleRegenerated") {
    if (message.error === 'ai-unavailable') {
      recordAIAvailability(false);
    } else if (message.title) {
      recordAIAvailability(true);
    }
    const ts = message.timestamp;
    const wrappers = document.querySelectorAll(`.session-wrapper[data-timestamp="${ts}"]`);
    wrappers.forEach(w => {
      const btn = w.querySelector('.ai-regenerate-btn');
      if (btn) {
        btn.style.opacity = '';
        btn.classList.remove('working');
      }

      const titleSpan = w.querySelector('.session-title-text, .session-title');
      if (titleSpan) {
        titleSpan.classList.remove('ai-title-working');
      }
      const titleInput = w.querySelector('.session-title-input');
      if (titleInput) {
        titleInput.classList.remove('ai-title-working');
      }
      delete w.dataset.pendingTitle;

      const sessionIdx = savedSessions.findIndex(s => s.timestamp === ts);
      if (sessionIdx !== -1) {
        delete savedSessions[sessionIdx].pendingTitle;
        delete savedSessions[sessionIdx].pendingTitleStartedAt;
        if (message.title) {
          savedSessions[sessionIdx].customName = message.title;
          savedSessions[sessionIdx].aiGenerated = true;
        }
      }

      // Update title if provided (success case)
      if (message.title) {
        displayTitle = message.title;
        if (titleSpan) {
          // Update the title span (non-editing view)
          titleSpan.textContent = message.title;
          titleSpan.classList.remove('ai-title-update');
          void titleSpan.offsetWidth;
          titleSpan.classList.add('ai-title-update');
          setTimeout(() => {
            titleSpan.classList.remove('ai-title-update');
          }, 450);
        }

        // Update input if currently editing
        const input = w.querySelector('.session-title-input');
        if (input) {
          input.value = message.title;
          input.placeholder = message.title;
          // Resize input to fit new title
          const measure = document.createElement('span');
          measure.style.position = 'absolute';
          measure.style.visibility = 'hidden';
          measure.style.whiteSpace = 'pre';
          const inputStyle = window.getComputedStyle(input);
          measure.style.fontSize = inputStyle.fontSize;
          measure.style.fontFamily = inputStyle.fontFamily;
          measure.style.fontWeight = inputStyle.fontWeight;
          measure.style.lineHeight = inputStyle.lineHeight;
          measure.style.letterSpacing = inputStyle.letterSpacing;
          measure.textContent = input.value;
          document.body.appendChild(measure);
          const padLeft = parseInt(inputStyle.paddingLeft, 10) || 0;
          const padRight = parseInt(inputStyle.paddingRight, 10) || 0;
          const measuredWidth = measure.offsetWidth + padLeft + padRight + 2;
          document.body.removeChild(measure);
          input.style.width = measuredWidth + 'px';
        }
      }
    });
  } else if (message.action === "categorizationComplete") {
    // AI categorization complete - animate the split
    chrome.storage.local.get(["savedSessions"], (result) => {
      animateCategorization(
        message.placeholderTimestamp,
        message.newTimestamps,
        result.savedSessions || []
      );
    });
  } else if (message.action === "languageChanged") {
    // Refresh all internationalized UI elements
    chrome.storage.local.get(["savedSessions"], (result) => {
      updateSessionList(result.savedSessions || []);
    });
  } else if (message.action === "updateTrash") {
    // Update local trash data when it changes
    const normalizedTrash = normalizeTrashedLinksData(message.trashedLinks || []);
    trashedLinks = normalizedTrash.links;
    if (normalizedTrash.changed) {
      chrome.storage.local.set({ trashedLinks });
    }
    if (currentView === 'trash') {
      renderTrashView();
    }
  }
});

function refreshInternationalizedElements() {
  document.querySelectorAll('.lock-session-link').forEach(link => {
    if (link.classList.contains('locked')) {
      link.title = getMessage("sessionLocked");
    } else {
      link.title = getMessage("lockSession");
    }
  });
  
  document.querySelectorAll('.open-session-link').forEach(link => {
    link.title = getMessage("restoreAllTabs");
  });
  
  document.querySelectorAll('.merge-session-link').forEach(link => {
    link.title = getMessage("mergeIntoSessionBelow");
  });
  
  document.querySelectorAll('.delete-session-link').forEach(link => {
    link.title = getMessage("draftDelete");
  });
  
  document.querySelectorAll('.drag-handle').forEach(handle => {
    handle.title = getMessage("dragToReorder");
  });
}

/**
 * Animate categorization - replace placeholder with multiple sessions
 */
function animateCategorization(placeholderTimestamp, newTimestamps, updatedSessions) {
  debug("🎬 Animating categorization split");

  // Find the placeholder element
  const placeholderWrapper = document.querySelector(`.session-wrapper[data-timestamp="${placeholderTimestamp}"]`);

  if (!placeholderWrapper) {
    debug("Placeholder not found, just refreshing");
    updateSessionList(updatedSessions);
    return;
  }

  // Add fade-out class to placeholder
  placeholderWrapper.classList.add('categorizing-out');

  // Wait for fade out, then update list and animate new sessions in
  setTimeout(() => {
    updateSessionList(updatedSessions);

    // Animate the new categorized sessions in
    requestAnimationFrame(() => {
      newTimestamps.forEach(timestamp => {
        const newWrapper = document.querySelector(`.session-wrapper[data-timestamp="${timestamp}"]`);
        if (newWrapper) {
          newWrapper.classList.add('categorized-in');
          // Remove class after animation
          setTimeout(() => {
            newWrapper.classList.remove('categorized-in');
          }, 500);
        }
      });
    });
  }, 300); // Match CSS transition duration
}

/**
 * Update session list with animation for changed titles (e.g., AI-generated titles)
 */
function updateSessionListWithAnimation(newSessions) {
  // Find sessions whose titles changed (AI titles arriving)
  const changedTimestamps = new Set();

  newSessions.forEach(newSession => {
    const oldSession = savedSessions.find(s => s.timestamp === newSession.timestamp);
    if (oldSession) {
      const oldTitle = oldSession.customName || oldSession.defaultTitle || '';
      const newTitle = newSession.customName || newSession.defaultTitle || '';
      if (oldTitle !== newTitle) {
        changedTimestamps.add(newSession.timestamp);
      }
    }
  });

  // Update the session list normally
  updateSessionList(newSessions);

  // Animate the changed titles
  if (changedTimestamps.size > 0) {
    requestAnimationFrame(() => {
      changedTimestamps.forEach(timestamp => {
        const wrapper = document.querySelector(`.session-wrapper[data-timestamp="${timestamp}"]`);
        if (wrapper) {
          const titleSpan = wrapper.querySelector('.session-title');
          if (titleSpan) {
            titleSpan.classList.add('ai-title-update');
            // Remove class after animation completes
            setTimeout(() => {
              titleSpan.classList.remove('ai-title-update');
            }, 600);
          }
        }
      });
    });
  }
}

/**
 * Render the standard welcome screen for new users
 */
function renderNewUserWelcome(container) {
  container.innerHTML = `
    <div class="welcome-container">
      <div class="welcome-left">
        <div class="welcome-header">
          <h2 class="welcome-title">${getMessage("welcomeTitle")}</h2>
        </div>

        <p class="welcome-description">${getMessage("welcomeDescription")}</p>

        <div class="welcome-actions">
          <button id="saveSampleSession" class="welcome-button primary">
            <svg class="button-icon" viewBox="0 0 24 24" aria-hidden="true">
              <rect width="18" height="18" x="3" y="3" rx="2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              <line x1="9" x2="15" y1="15" y2="9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            ${getMessage("welcomeActionSave")}
          </button>
          <a href="help.html" class="welcome-button secondary">
            <svg class="button-icon" viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="1.5"/>
              <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" fill="none" stroke="currentColor" stroke-width="1.5"/>
              <circle cx="12" cy="17" r="1" fill="currentColor"/>
            </svg>
            ${getMessage("welcomeActionHelp")}
          </a>
        </div>

        <div class="welcome-tip">
          <span>${getMessage("welcomeTip")}</span>
        </div>
      </div>

      <div class="welcome-right">
        <div class="welcome-steps">
          <div class="welcome-step">
            <div class="step-number">1</div>
            <div class="step-content">
              <h3>${getMessage("welcomeStep0Title")}</h3>
              <p>${getMessage("welcomeStep0Description")}</p>
            </div>
          </div>

          <div class="welcome-step">
            <div class="step-number">2</div>
            <div class="step-content">
              <h3>${getMessage("welcomeStep1Title")}</h3>
              <p>${getMessage("welcomeStep1Description")}</p>
            </div>
          </div>

          <div class="welcome-step">
            <div class="step-number">3</div>
            <div class="step-content">
              <h3>${getMessage("welcomeStep3Title")}</h3>
              <p>${getMessage("welcomeStep3Description")}</p>
            </div>
          </div>
        </div>
      </div>
    </div>
    <div class="welcome-video-section">
      <video class="welcome-demo-video" poster="${chrome.runtime.getURL('images/welcome-drag-to-toolbar-poster.jpg')}" src="https://tabstract.app/app-assets/welcome-drag-to-toolbar-optimized.mp4" muted loop autoplay playsinline preload="metadata"></video>
    </div>
  `;

  // Add event listener with smooth transition on click
  const sampleBtn = document.getElementById('saveSampleSession');
  sampleBtn?.addEventListener('click', () => {
    const welcomeEl = document.querySelector('.welcome-container');
    if (welcomeEl) {
      // Trigger fade out, then create the sample session and render
      welcomeEl.classList.add('fade-out');
      setTimeout(() => {
        createSampleSession();
      }, 220);
    } else {
      createSampleSession();
    }
  });

  // Ensure welcome video respects current color theme
  const welcomeVideo = document.querySelector('.welcome-demo-video');
  if (welcomeVideo) {
    setWelcomeVideoSrc(welcomeVideo);
  }
}

/**
 * Render carousel-based welcome screen for returning users
 */
function renderReturningUserWelcome(container) {
  // Randomly select one of the welcome back messages
  const titleVariations = ['welcomeBackTitle1', 'welcomeBackTitle2', 'welcomeBackTitle3', 'welcomeBackTitle4'];
  const randomTitle = titleVariations[Math.floor(Math.random() * titleVariations.length)];

  // Carousel slides data from help.html user guide (skipping "Getting Started" and "Keyboard Shortcuts")
  const carouselSlides = [
    {
      title: getMessage("guideAIFeaturesTitle"),
      description: getMessage("guideAIFeaturesBody"),
      videoSrc: "https://tabstract.app/app-assets/help-ai-organization-optimized.mp4",
      poster: chrome.runtime.getURL("images/help-ai-organization-poster.jpg")
    },
    {
      title: getMessage("guidePasteLinksTitle"),
      description: getMessage("guidePasteLinksBody"),
      videoSrc: "https://tabstract.app/app-assets/help-paste-links-optimized.mp4",
      poster: chrome.runtime.getURL("images/help-paste-links-poster.jpg")
    },
    {
      title: getMessage("guideBadgeNotificationsTitle"),
      description: getMessage("guideBadgeNotificationsBody"),
      videoSrc: "https://tabstract.app/app-assets/slide-reminders-optimized.mp4",
      poster: chrome.runtime.getURL("images/slide-reminders-poster.jpg")
    },
    {
      title: getMessage("guideShiftClickTitle"),
      description: getMessage("guideShiftClickBody"),
      videoSrc: "https://tabstract.app/app-assets/slide-opensession-optimized.mp4",
      poster: chrome.runtime.getURL("images/slide-opensession-poster.jpg")
    },
    {
      title: getMessage("guideDragToReorderTitle"),
      description: getMessage("guideDragToReorderBody"),
      videoSrc: "https://tabstract.app/app-assets/help-drag-and-drop-optimized.mp4",
      poster: chrome.runtime.getURL("images/help-drag-and-drop-poster.jpg")
    },
    {
      title: getMessage("guideTrashUndoTitle"),
      description: getMessage("guideTrashUndoBody"),
      videoSrc: "https://tabstract.app/app-assets/help-trash-optimized.mp4",
      poster: chrome.runtime.getURL("images/help-trash-poster.jpg")
    }
  ];

  // Preload all poster images as actual Image objects before rendering
  const posterPromises = carouselSlides.map(slide => {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve();
      img.onerror = () => resolve(); // Resolve anyway to not block rendering
      img.src = slide.poster;
    });
  });

  // Wait for all posters to load, then render carousel
  Promise.all(posterPromises).then(() => {
    container.innerHTML = `
    <div class="welcome-container returning-user">
      <div class="welcome-carousel">
        <div class="carousel-header">
          <h2 class="carousel-title">${getMessage(randomTitle) || "Welcome back!"}</h2>
          <p class="carousel-subtitle">${getMessage("welcomeBackSubtitle") || "Here are some tips to help you get the most out of Tabstract:"}</p>
        </div>

        <div class="carousel-slides">
          ${carouselSlides.map((slide, index) => `
            <div class="carousel-slide ${index === 0 ? 'active' : ''}" data-slide="${index}">
              <div class="carousel-content">
                <div class="carousel-video">
                  <video class="guide-video"
                         width="1600"
                         height="1000"
                         poster="${slide.poster}"
                         src="${slide.videoSrc}"
                         muted
                         loop
                         playsinline
                         preload="none"></video>
                </div>
                <div class="carousel-text">
                  <h3 class="carousel-slide-title">${slide.title}</h3>
                  <div class="carousel-slide-description">${slide.description}</div>
                </div>
              </div>
            </div>
          `).join('')}
        </div>

        <div class="carousel-controls">
          <button class="carousel-btn prev" aria-label="Previous slide">
            <svg viewBox="0 0 24 24" width="24" height="24">
              <path fill="currentColor" d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/>
            </svg>
          </button>

          <div class="carousel-indicators">
            ${carouselSlides.map((_, index) => `
              <button class="carousel-indicator ${index === 0 ? 'active' : ''}" data-slide="${index}" aria-label="Go to slide ${index + 1}"></button>
            `).join('')}
          </div>

          <button class="carousel-btn next" aria-label="Next slide">
            <svg viewBox="0 0 24 24" width="24" height="24">
              <path fill="currentColor" d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/>
            </svg>
          </button>
        </div>
      </div>
    </div>
  `;

  // Initialize carousel functionality
  let currentSlide = 0;
  const slides = container.querySelectorAll('.carousel-slide');
  const indicators = container.querySelectorAll('.carousel-indicator');
  const prevBtn = container.querySelector('.carousel-btn.prev');
  const nextBtn = container.querySelector('.carousel-btn.next');

  function showSlide(index) {
    // Wrap around
    if (index < 0) index = slides.length - 1;
    if (index >= slides.length) index = 0;

    // Update active slide
    slides.forEach((slide, i) => {
      slide.classList.toggle('active', i === index);
      // Auto-play video for active slide, pause others
      const video = slide.querySelector('video');
      if (video) {
        if (i === index) {
          video.play().catch(() => {/* ignore autoplay errors */});
        } else {
          video.pause();
          video.currentTime = 0; // Reset to beginning
        }
      }
    });

    // Update indicators
    indicators.forEach((indicator, i) => {
      indicator.classList.toggle('active', i === index);
    });

    currentSlide = index;
  }

  // Navigation button handlers
  prevBtn?.addEventListener('click', () => showSlide(currentSlide - 1));
  nextBtn?.addEventListener('click', () => showSlide(currentSlide + 1));

  // Indicator button handlers
  indicators.forEach((indicator, index) => {
    indicator.addEventListener('click', () => showSlide(index));
  });

  // Start playing the first video after posters are loaded
  const firstVideo = slides[0]?.querySelector('video');
  if (firstVideo) {
    firstVideo.play().catch(() => {/* ignore autoplay errors */});
  }
  }); // End of Promise.all().then()
}

/**
 * Render the entire session list in #tabList.
 */
function updateSessionList(sessions) {
  if (!Array.isArray(sessions)) {
    sessions = [];
  }
  const { sanitized } = sanitizePendingSessions(sessions);
  sessions = sanitized;

  // Clean up any lingering session drag listeners from previous renders
  document.removeEventListener('pointermove', onSessionPointerMove);
  document.removeEventListener('pointerup', onSessionPointerUp);
  isSessionDragging = false;

  // Sort sessions: pinned sessions first (by pinnedAt), then unpinned (preserve manual order)
  // Extract pinned and unpinned sessions
  const pinnedSessions = sessions.filter(s => s.pinned);
  const unpinnedSessions = sessions.filter(s => !s.pinned);

  // Sort pinned sessions by pinnedAt (most recent first)
  pinnedSessions.sort((a, b) => {
    const aPinnedTime = a.pinnedAt || 0;
    const bPinnedTime = b.pinnedAt || 0;
    return bPinnedTime - aPinnedTime;
  });

  // Don't sort unpinned sessions - preserve their current order (manual or by creation)
  // This allows users to manually reorder sessions via drag and drop

  // Combine: pinned first, then unpinned in current order
  sessions = [...pinnedSessions, ...unpinnedSessions];

  // Keep empty sessions so users can create new groups
  // Update savedSessions AFTER pin-sort so indexes match the rendered order
  // (drag-and-drop uses rendered sessionIndex into savedSessions)
  savedSessions = sessions;
  chrome.storage.local.set({ savedSessions: sessions }, () => {
    // Ensure badge is updated after any session list change
    refreshBadge();
  });

  renderSessionList(sessions);

  // Update Reset Group Colors button state
  updateResetGroupColorsButtonState();
}

function renderSessionList(sessions) {
    // --- Clean up stale collapsedSessions entries ---
    const timestamps = new Set(sessions.map(s => String(s.timestamp)));
    let collapsedChanged = false;
    for (const ts in collapsedSessions) {
      if (!timestamps.has(ts)) {        // compare as strings
        delete collapsedSessions[ts];
        collapsedChanged = true;
      }
    }
    if (collapsedChanged) {
      chrome.storage.local.set({ collapsedSessions });
    }

  const container = document.getElementById('tabList');
  container.innerHTML = '';

    if (sessions.length === 0) {
      // Show search box even on welcome screen; optionally hide only the add session button and banner
      const addSessionBtn = document.getElementById('addSessionBtn');
      const headerSearch = document.querySelector('.header-search');
      const banner = document.querySelector('.banner');
      if (addSessionBtn) {
        addSessionBtn.style.display = '';
        addSessionBtn.disabled = true;
      }
      if (headerSearch) headerSearch.style.display = '';
      // Disable search while on welcome screen (no sessions yet)
      const searchInput = document.getElementById('searchInput');
      if (searchInput) searchInput.disabled = true;
      if (banner) banner.style.display = 'none';

      // Check if user is returning (installed 3+ days ago)
      chrome.storage.local.get('installDate', (result) => {
        const installDate = result.installDate || Date.now();
        const daysSinceInstall = (Date.now() - installDate) / (1000 * 60 * 60 * 24);
        const isReturningUser = daysSinceInstall >= 3;

        if (isReturningUser) {
          // Show carousel-based welcome for returning users
          renderReturningUserWelcome(container);
        } else {
          // Show standard welcome for new users
          renderNewUserWelcome(container);
        }

        // Ensure search is wired and visible even on welcome screen
        initializeSearch();

        // Wire up the actions menu even on welcome screen (so menu button works)
        wireActionsMenu();
      });

      return;
    }

    // Show the new session button, search box, and banner when there are sessions
    const addSessionBtn = document.getElementById('addSessionBtn');
    const headerSearch = document.querySelector('.header-search');
    const banner = document.querySelector('.banner');
    if (addSessionBtn) {
      addSessionBtn.style.display = '';
      addSessionBtn.disabled = false;
    }
    if (headerSearch) headerSearch.style.display = '';
    // Enable search when sessions exist
    const searchInput = document.getElementById('searchInput');
    if (searchInput) searchInput.disabled = false;

    // Only show banner if user has been using the app for 3+ days and hasn't dismissed it
    if (banner) {
      chrome.storage.local.get('installDate', (result) => {
        const installDate = (typeof result.installDate === 'number' && result.installDate > 0)
          ? result.installDate
          : Date.now();
        const daysSinceInstall = (Date.now() - installDate) / (1000 * 60 * 60 * 24);
        const dismissed = localStorage.getItem(banner.id) === 'true';
        if (daysSinceInstall >= 3 && !dismissed) {
          banner.classList.add('is-visible');
        } else {
          banner.classList.remove('is-visible');
        }
      });
    }

      sessions.forEach((session, sessionIndex) => {
        // Handle Smart Groups differently
        let displayTitle;
        if (session.isSmartGroup) {
          displayTitle = session.customName || session.name;
        } else {
          const dateObj = new Date(session.timestamp);
          const formattedDate = dateObj.toLocaleDateString(window.getEffectiveLocale ? window.getEffectiveLocale() : navigator.language, {
            weekday: getMessage("weekdayFormat") || 'long',
            month: getMessage("monthFormat") || 'long',
            day: getMessage("dayFormat") || 'numeric'
          });
          const formattedTime = dateObj.toLocaleTimeString(window.getEffectiveLocale ? window.getEffectiveLocale() : navigator.language, {
            hour: getMessage("hourFormat") || 'numeric',
            minute: getMessage("minuteFormat") || 'numeric'
          });
          const defaultTitle = `${formattedDate} ${formattedTime}`;
          displayTitle = session.customName || session.defaultTitle || defaultTitle;
        }

    // Outer .session-wrapper
    const wrapper = document.createElement('div');
    wrapper.className = 'session-wrapper';
    wrapper.dataset.timestamp = session.timestamp || session.id;
    wrapper.dataset.index = sessionIndex;
    if (session.isSmartGroup) {
      wrapper.classList.add('smart-group');
      wrapper.dataset.smartGroupId = session.id;
      if (session.pinned) {
        wrapper.classList.add('pinned-smart-group');
      }
    }
    if (!session.isSmartGroup && session.pinned) {
      wrapper.classList.add('pinned-session');
    }
    if (session.locked) {
      wrapper.classList.add('locked-session');
    }
    // Apply collapsed state
    const collapseKey = session.timestamp || session.id;
    if (collapsedSessions[collapseKey]) {
      wrapper.classList.add('collapsed');
      wrapper.classList.add('closed');
    }
    // Mark as pending categorization
    if (session.pendingCategorization) {
      wrapper.dataset.pendingCategorization = "true";
    } else {
      delete wrapper.dataset.pendingCategorization;
    }

    if (session.pendingTitle) {
      wrapper.dataset.pendingTitle = "true";
    } else {
      delete wrapper.dataset.pendingTitle;
    }

    // Session header
    const header = document.createElement('div');
    header.className = 'session-header';

    // Title container: drag icon + session title + toggle
    const titleContainer = document.createElement('div');
    titleContainer.className = 'session-title-container';

    // Drag icon (or pinned icon for pinned sessions)
    const dragIcon = document.createElement('span');
    dragIcon.className = 'session-drag-handle';

    // Create corner ribbon for unread scheduled templates
    let scheduledRibbon = null;
    if (session.scheduledTemplate && !session.scheduledTemplateRead) {
      scheduledRibbon = document.createElement('div');
      scheduledRibbon.className = 'scheduled-ribbon';
      scheduledRibbon.innerHTML = '<svg class="icon" viewBox="0 0 32.25 31.8906" aria-hidden="true"><g><path d="M15.9375 31.875C24.7344 31.875 31.875 24.7344 31.875 15.9375C31.875 7.14062 24.7344 0 15.9375 0C7.14062 0 0 7.14062 0 15.9375C0 24.7344 7.14062 31.875 15.9375 31.875ZM15.9375 29.2188C8.59375 29.2188 2.65625 23.2812 2.65625 15.9375C2.65625 8.59375 8.59375 2.65625 15.9375 2.65625C23.2812 2.65625 29.2188 8.59375 29.2188 15.9375C29.2188 23.2812 23.2812 29.2188 15.9375 29.2188Z"/><path d="M7.76562 17.625L15.9219 17.625C16.5312 17.625 17.0156 17.1562 17.0156 16.5312L17.0156 6C17.0156 5.39062 16.5312 4.92188 15.9219 4.92188C15.3125 4.92188 14.8438 5.39062 14.8438 6L14.8438 15.4531L7.76562 15.4531C7.14062 15.4531 6.67188 15.9219 6.67188 16.5312C6.67188 17.1562 7.14062 17.625 7.76562 17.625Z"/></g></svg>';
      scheduledRibbon.title = 'Loaded from scheduled routine';

      // Use session color for ribbon if set, otherwise CSS default (--info)
      if (session.color && session.color !== 'none') {
        const colorMap = {
          'blue': '#007AFF',
          'green': '#53b559',
          'yellow': '#ffc400',
          'orange': '#fa6a22',
          'red': '#FF0000',
          'pink': '#ff66ad',
          'purple': '#924ff6'
        };
        const ribbonColor = session.color.startsWith('#') ? session.color : colorMap[session.color];
        if (ribbonColor) {
          scheduledRibbon.style.setProperty('--ribbon-color', ribbonColor);
        }
      }

      wrapper.appendChild(scheduledRibbon);

      // Add interaction handlers to mark as read
      const markAsRead = () => {
        session.scheduledTemplateRead = true;

        // Prevent storage listener from re-rendering during our animation
        isUpdatingFromStorage = true;

        chrome.storage.local.get(['savedSessions'], (result) => {
          const sessions = result.savedSessions || [];
          const sessionToUpdate = sessions.find(s => s.timestamp === session.timestamp);
          if (sessionToUpdate) {
            sessionToUpdate.scheduledTemplateRead = true;
            chrome.storage.local.set({ savedSessions: sessions });
          }
        });

        // Add fade class on next frame to ensure transition works
        requestAnimationFrame(() => {
          scheduledRibbon.classList.add('fade-ribbon');
        });

        // Remove ribbon after fade animation completes (3s)
        setTimeout(() => {
          if (scheduledRibbon && scheduledRibbon.parentNode) {
            scheduledRibbon.parentNode.removeChild(scheduledRibbon);
          }

          // Re-enable storage listener after animation completes
          isUpdatingFromStorage = false;
        }, 3000);
      };

      wrapper.addEventListener('mouseover', markAsRead, { once: true });
      wrapper.addEventListener('click', markAsRead, { once: true });
    }

    // Show pushpin icon for pinned sessions/groups, drag handle for unpinned
    if (session.pinned) {
      dragIcon.classList.add('pinned-indicator');
      dragIcon.innerHTML = '<svg class="icon" viewBox="0 0 23.6864 36.9547" aria-hidden="true"><g><path d="M0 23.1814C0 24.3206 0.788907 25.0745 2.03047 25.0745L10.5417 25.0745L10.5417 33.208C10.5417 35.2852 11.3383 36.9547 11.6611 36.9547C11.978 36.9547 12.7745 35.2852 12.7745 33.3208L12.7745 25.0745L21.2809 25.0745C22.5225 25.0745 23.3114 24.3206 23.3114 23.1814C23.3114 19.8458 20.6805 16.4825 16.4255 14.9808L15.9244 7.71203C17.9005 6.54594 19.7755 5.09172 20.5928 3.99641C20.9506 3.51844 21.1392 3.04531 21.1392 2.63469C21.1392 1.79297 20.492 1.17219 19.5097 1.17219L3.8125 1.17219C2.81937 1.17219 2.18297 1.79297 2.18297 2.63469C2.18297 3.04531 2.36078 3.51844 2.71859 3.99641C3.54078 5.09172 5.41578 6.55078 7.38703 7.71203L6.88594 14.9808C2.63094 16.4825 0 19.8458 0 23.1814Z"/></g></svg>';
      dragIcon.title = 'Pinned';
      // Don't add drag event listeners for pinned items
    } else {
      dragIcon.innerHTML = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" stroke-width="2"><circle cx="12" cy="5" r="1"/><circle cx="19" cy="5" r="1"/><circle cx="5" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/><circle cx="12" cy="19" r="1"/><circle cx="19" cy="19" r="1"/><circle cx="5" cy="19" r="1"/></svg>';
      dragIcon.addEventListener('pointerdown', (ev) => {
        dragSourceIndex = sessionIndex;
        lastSessionDropIndex = null;
        startSessionDrag(ev, sessionIndex, wrapper);
        ev.preventDefault();
        ev.stopPropagation();
      });
    }

    // Session title
    const titleSpan = document.createElement('span');
    titleSpan.className = 'session-title';
    titleSpan.textContent = displayTitle;
    if (session.pendingTitle) {
      titleSpan.classList.add('ai-title-working');
    }

    // Apply session color if set
    if (session.color && session.color !== 'none') {
      const colorMap = {
        'blue': '#007AFF',
        'green': '#53b559',
        'yellow': '#ffc400',
        'orange': '#fa6a22',
        'red': '#FF0000',
        'pink': '#ff66ad',
        'purple': '#924ff6'
      };
      // Use custom color (hex) or map named color
      const colorValue = session.color.startsWith('#') ? session.color : colorMap[session.color];
      if (colorValue) {
        titleSpan.style.color = colorValue;
        dragIcon.style.color = colorValue;
        // Also set fill for SVG elements
        const svg = dragIcon.querySelector('svg');
        if (svg) {
          svg.style.fill = colorValue;
          svg.style.stroke = colorValue;
          const paths = svg.querySelectorAll('path, circle');
          paths.forEach(p => {
            p.style.fill = colorValue;
            p.style.stroke = colorValue;
          });
        }
        // Apply border to session wrapper and override accent color
        wrapper.style.setProperty('--session-accent', colorValue);
        wrapper.classList.add('has-color');

        // Color the chevron SVGs and tab count (will be added later after toggleButton is created)
        wrapper.dataset.sessionColor = colorValue;
      }
    }
    titleSpan.addEventListener('click', (e) => {
      e.stopPropagation();
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'session-title-input';
      const upToDateSession = savedSessions.find(s => s.timestamp === session.timestamp) || session;
      const fallbackTitle = upToDateSession.customName || displayTitle;
        // For date-based titles: start empty with placeholder (user likely wants to replace entirely)
        // For AI/custom titles: make text editable (user may want to tweak just one word)
        if (upToDateSession.customName) {
          input.value = fallbackTitle;
          input.placeholder = '';
        } else {
          input.value = '';
          input.placeholder = fallbackTitle;
        }
      const spanStyle = window.getComputedStyle(titleSpan);

      // Add 2px cursor buffer to the span before measuring
      // This prevents caret shift when switching from span to input
      const originalPaddingRight = titleSpan.style.paddingRight;
      const computedPaddingRight = parseInt(spanStyle.paddingRight, 10) || 0;
      titleSpan.style.paddingRight = (computedPaddingRight + 2) + 'px';

      // Capture the span width (now includes the 2px cursor buffer)
      // offsetWidth returns rounded integers, avoiding sub-pixel issues
      const spanWidth = titleSpan.offsetWidth;

      // Set the span's width explicitly to the rounded value so it visually matches
      titleSpan.style.width = spanWidth + 'px';

      // Restore original padding so we copy the correct style to input
      titleSpan.style.paddingRight = originalPaddingRight;
      const measure = document.createElement('span');
      measure.style.visibility = 'hidden';
      measure.style.position = 'absolute';
      measure.style.whiteSpace = 'pre';
      measure.style.fontSize = spanStyle.fontSize;
      measure.style.fontFamily = spanStyle.fontFamily;
      measure.style.fontWeight = spanStyle.fontWeight;
      measure.style.lineHeight = spanStyle.lineHeight;
      measure.style.letterSpacing = spanStyle.letterSpacing;
      measure.style.top = '-9999px';
      measure.style.left = '-9999px';
      // Keep initial width equal to the visible title width
      measure.textContent = fallbackTitle;
      document.body.appendChild(measure);
      titleContainer.replaceChild(input, titleSpan);

      // If AI title suggestions are enabled, hide the chevron toggle and show AI regenerate icon instead
      const prevToggleDisplay = toggleButton.style.display;
      let regenBtn = document.createElement('button');
      regenBtn.type = 'button';
      regenBtn.className = 'ai-regenerate-btn';
      regenBtn.title = (getMessage('aiRegenerateTitle') || 'Regenerate title');
      regenBtn.setAttribute('aria-label', (getMessage('aiRegenerateTitle') || 'Regenerate title'));
      regenBtn.innerHTML = '<svg class="icon" viewBox="0 0 35.1953 39.3281" aria-hidden="true" focusable="false"><g><path d="M7.21094 24.9375C6.77344 24.9375 6.45312 25.2422 6.41406 25.7109C5.84375 30.4375 5.64844 30.5859 0.8125 31.3359C0.28125 31.4062 0 31.7031 0 32.1406C0 32.5703 0.28125 32.875 0.71875 32.9453C5.64844 33.8516 5.84375 33.8672 6.41406 38.5625C6.45312 39.0391 6.77344 39.3281 7.21094 39.3281C7.65625 39.3281 7.98438 39.0391 8.03125 38.5859C8.64062 33.75 8.78906 33.625 13.7031 32.9453C14.1172 32.8906 14.4297 32.5703 14.4297 32.1406C14.4297 31.7188 14.125 31.4062 13.7188 31.3359C8.75781 30.4375 8.64844 30.375 8.03125 25.6641C7.98438 25.2422 7.64844 24.9375 7.21094 24.9375Z"/><path d="M20.125 4.85938C19.4453 4.85938 18.8828 5.36719 18.7734 6.09375C17.2891 15.6719 16.0625 16.8828 6.73438 18.1562C5.98438 18.2578 5.44531 18.8203 5.44531 19.5312C5.44531 20.2656 5.99219 20.8516 6.74219 20.9219C16.0938 21.9688 17.4453 23.3984 18.7734 32.9766C18.875 33.7031 19.4375 34.2266 20.125 34.2266C20.8203 34.2266 21.375 33.7031 21.5 32.9766C22.9688 23.3984 24.1875 22.0859 33.5469 20.9219C34.2969 20.8359 34.8203 20.2578 34.8203 19.5312C34.8203 18.8125 34.2891 18.2422 33.5234 18.1562C24.1719 17.1016 22.8281 15.6719 21.5 6.09375C21.3828 5.36719 20.8438 4.85938 20.125 4.85938Z"/></g></svg>';

      // Apply session color to AI regenerate button if session has a color
      const sessionColor = wrapper.dataset.sessionColor;
      if (sessionColor) {
        const svg = regenBtn.querySelector('svg');
        if (svg) {
          svg.style.setProperty('fill', sessionColor, 'important');
          const paths = svg.querySelectorAll('path');
          paths.forEach(p => {
            p.style.setProperty('fill', sessionColor, 'important');
            p.style.setProperty('stroke', 'none', 'important');
          });
        }
      }

      // Only hide toggle and show regenerate icon if AI is available (hardware/software support)
      // Use cached AI availability state for instant response
      if (aiAvailabilityState === true) {
        toggleButton.style.display = 'none';
        titleContainer.appendChild(regenBtn);
      } else if (aiAvailabilityState === null) {
        // Status not yet known, check async but don't delay
        chrome.runtime.sendMessage({ action: "checkAIStatus" }, (response) => {
          if (chrome.runtime.lastError) return;
          if (response && response.available) {
            recordAIAvailability(true);
            toggleButton.style.display = 'none';
            titleContainer.appendChild(regenBtn);
          } else {
            recordAIAvailability(false);
          }
        });
      }

      const triggerRegenerate = () => {
        if (regenBtn.classList.contains('working')) return;
        regenBtn.classList.add('working');
        try { chrome.runtime.sendMessage({ action: 'regenerateSessionTitle', timestamp: session.timestamp }); } catch (err) {}
      };
      // Use mousedown to avoid stealing focus from the input (prevents blur)
      regenBtn.addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        triggerRegenerate();
        // Keep typing focus
        try { input.focus(); } catch (e) {}
      });
      // Fallback for click (if mousedown was blocked by platform)
      regenBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        triggerRegenerate();
        try { input.focus(); } catch (e) {}
      });
      const inputStyle = window.getComputedStyle(input);
      const padLeft = parseInt(inputStyle.paddingLeft, 10) || 0;
      const padRight = parseInt(inputStyle.paddingRight, 10) || 0;
      document.body.removeChild(measure);
      input.style.fontSize = spanStyle.fontSize;
      input.style.fontFamily = spanStyle.fontFamily;
      input.style.fontWeight = spanStyle.fontWeight;
      input.style.lineHeight = spanStyle.lineHeight;
      input.style.letterSpacing = spanStyle.letterSpacing;
      input.style.padding = spanStyle.padding;
      input.style.margin = spanStyle.margin;
      input.style.boxSizing = spanStyle.boxSizing;
      input.style.height = spanStyle.height;
      input.style.verticalAlign = spanStyle.verticalAlign;
      input.style.minWidth = spanStyle.minWidth;
      input.style.border = spanStyle.border;
      input.style.outline = 'none';
      input.style.display = 'inline-block';
      // Use measured span width (already includes 2px cursor buffer from above)
      input.style.width = spanWidth + 'px';

    // Store original toggle button margin for restoration on blur
    const originalToggleMargin = toggleButton.style.marginLeft;

    input.addEventListener('blur', () => {
      // Restore toggle button margin
      toggleButton.style.marginLeft = originalToggleMargin;

      if (input.value.length > 60) {
        input.value = input.value.substring(0, 60);
      }
      const final = (input.value || '').trim();
      if (!final) {
        // No change: keep prior visible title (custom or default)
        titleSpan.textContent = fallbackTitle;
        displayTitle = fallbackTitle;
        titleContainer.replaceChild(titleSpan, input);
        toggleButton.style.display = prevToggleDisplay || '';
        const existingRegen = titleContainer.querySelector('.ai-regenerate-btn');
        if (existingRegen) existingRegen.remove();
        return;
      }
      updateSessionName(session.timestamp, final);
      titleSpan.textContent = final;  // Update titleSpan with the new title
      displayTitle = final;
      titleContainer.replaceChild(titleSpan, input);
      toggleButton.style.display = prevToggleDisplay || '';
      const existingRegen = titleContainer.querySelector('.ai-regenerate-btn');
      if (existingRegen) existingRegen.remove();
    });
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') input.blur();
      });
      input.addEventListener('input', () => {
        input.value = input.value.replace(/ {2,}/g, ' ');
        const flashError = () => {
          input.classList.remove('error-flash');
          void input.offsetWidth;
          input.classList.add('error-flash');
        };
        if (input.value.length > 60) {
          input.value = input.value.substring(0, 60);
          flashError();
        }
        measure.textContent = input.value || ' ';
        document.body.appendChild(measure);
        const newTextWidth = measure.offsetWidth;
        document.body.removeChild(measure);
        const padLeft2 = parseInt(inputStyle.paddingLeft, 10) || 0;
        const padRight2 = parseInt(inputStyle.paddingRight, 10) || 0;
        let newWidth = newTextWidth + padLeft2 + padRight2 + 2;
        if (newWidth > 525) {
          flashError();
          newWidth = 525;
        }
        input.style.width = newWidth + 'px';
      });
      // Focus and select entire text for quick rename
      // Focus with empty value (caret at natural position)
      input.focus();

      // Hack: shift toggle button 2px left when input is focused to prevent visual shift
      toggleButton.style.marginLeft = '-2px';
    });

    // No progress chip; keep UI uncluttered and rely on autosafe cleanup

    // Toggle collapse/expand button
    const toggleButton = document.createElement('button');
    toggleButton.className = 'toggle-button';
    const isCollapsed = !!collapsedSessions[session.timestamp];
    toggleButton.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
    toggleButton.setAttribute('aria-label', isCollapsed ? (getMessage('expandSession') || 'Expand session') : (getMessage('collapseSession') || 'Collapse session'));
    toggleButton.innerHTML = `
      <!-- Chevron open -->
      <svg class="chevron-open" version="1.1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 26.4209 15.7106">
        <path d="M13.0259 15.7106C13.3439 15.7106 13.6473 15.5689 13.8694 15.3253L25.7161 2.84751C25.9188 2.63516 26.0459 2.38829 26.0459 2.08969C26.0459 1.48063 25.5819 1.00578 24.968 1.00578C24.6791 1.00578 24.402 1.11844 24.1994 1.31032L12.3372 13.782L13.7136 13.782L1.84172 1.31032C1.65469 1.11844 1.37766 1.00578 1.07313 1.00578C0.464064 1.00578 0 1.48063 0 2.08969C0 2.38829 0.132031 2.64485 0.334688 2.86313L12.1717 15.3302C12.4153 15.5738 12.6923 15.7106 13.0259 15.7106Z"/>
      </svg>

      <!-- Chevron closed -->
      <svg class="chevron-closed" version="1.1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 18.3153 26.0266">
        <path d="M18.3153 13.0055C18.3153 12.6923 18.193 12.4202 17.9591 12.2019L5.4775 0.304532C5.26407 0.101875 5.00266 0 4.69328 0C4.09984 0 3.62016 0.454376 3.62016 1.07313C3.62016 1.37172 3.73766 1.63422 3.91984 1.83204L15.6678 13.0055L3.91984 24.1789C3.73766 24.3719 3.62016 24.6284 3.62016 24.9378C3.62016 25.5566 4.09984 26.0109 4.69328 26.0109C5.00266 26.0109 5.26407 25.9042 5.4775 25.6908L17.9591 13.8091C18.193 13.5752 18.3153 13.3186 18.3153 13.0055Z"/>
      </svg>
      <span class="link-count">${session.tabs.length}</span>
    `;
      toggleButton.addEventListener('click', e => {
        e.stopPropagation();
        const nowCollapsed = wrapper.classList.toggle('collapsed');
        wrapper.classList.toggle('closed', nowCollapsed);
        toggleButton.setAttribute('aria-expanded', nowCollapsed ? 'false' : 'true');
        toggleButton.setAttribute('aria-label', nowCollapsed ? (getMessage('expandSession') || 'Expand session') : (getMessage('collapseSession') || 'Collapse session'));

        if (e.shiftKey) {
          // Apply the same collapse/expand to every session
          document.querySelectorAll('.session-wrapper').forEach(w => {
            w.classList.toggle('collapsed', nowCollapsed);
            w.classList.toggle('closed', nowCollapsed);
            const btn = w.querySelector('.toggle-button');
            if (btn) {
              btn.setAttribute('aria-expanded', nowCollapsed ? 'false' : 'true');
              btn.setAttribute('aria-label', nowCollapsed ? (getMessage('expandSession') || 'Expand session') : (getMessage('collapseSession') || 'Collapse session'));
            }
            collapsedSessions[w.dataset.timestamp] = nowCollapsed;

            // Update split group button disabled state for this session
            const splitBtn = w.querySelector('.split-group-btn');
            if (splitBtn) {
              const sessionTabs = savedSessions.find(s => s.timestamp === w.dataset.timestamp)?.tabs;
              const shouldDisable = (sessionTabs && sessionTabs.length <= 1) || nowCollapsed;
              if (shouldDisable) {
                splitBtn.classList.add('disabled');
              } else {
                splitBtn.classList.remove('disabled');
              }
            }
          });
        } else {
          // Single-session toggle
          collapsedSessions[session.timestamp] = nowCollapsed;

          // Update split group button disabled state for this session
          const splitBtn = wrapper.querySelector('.split-group-btn');
          if (splitBtn) {
            const shouldDisable = (session.tabs && session.tabs.length <= 1) || nowCollapsed;
            if (shouldDisable) {
              splitBtn.classList.add('disabled');
            } else {
              splitBtn.classList.remove('disabled');
            }
          }
        }

        chrome.storage.local.set({ collapsedSessions });
      });

    // Assemble header
    titleContainer.appendChild(dragIcon);
    titleContainer.appendChild(titleSpan);
    titleContainer.appendChild(toggleButton);

    // Apply color to chevron and tab count if session has a color
    const sessionColor = wrapper.dataset.sessionColor;
    if (sessionColor) {
      const chevronSvgs = toggleButton.querySelectorAll('svg');
      chevronSvgs.forEach(svg => {
        svg.style.setProperty('fill', sessionColor, 'important');
        const paths = svg.querySelectorAll('path');
        paths.forEach(p => {
          p.style.setProperty('fill', sessionColor, 'important');
          p.style.setProperty('stroke', 'none', 'important');
        });
      });
      const linkCount = toggleButton.querySelector('.link-count');
      if (linkCount) {
        linkCount.style.setProperty('color', sessionColor, 'important');
      }
    }

    header.appendChild(titleContainer);

    // Action links: "Lock", "Restore", "Merge", "Delete"
    const actionsRow = document.createElement('div');
    actionsRow.className = 'session-actions';

    // Session-level actions menu (⋯)
    const sessionActionsMenuContainer = document.createElement('div');
    sessionActionsMenuContainer.className = 'session-actions-menu-container';

    const sessionActionsMenuBtn = document.createElement('button');
    sessionActionsMenuBtn.className = 'session-actions-menu-btn';
    sessionActionsMenuBtn.setAttribute('aria-label', 'Session actions');
    sessionActionsMenuBtn.setAttribute('aria-expanded', 'false');
    sessionActionsMenuBtn.setAttribute('aria-haspopup', 'true');
    sessionActionsMenuBtn.innerHTML = `
      <svg viewBox="0 0 32.4375 8.10938" aria-hidden="true">
        <path d="M28.0156 8.09375C30.25 8.09375 32.0625 6.26562 32.0625 4.04688C32.0625 1.8125 30.25 0 28.0156 0C25.7969 0 23.9688 1.8125 23.9688 4.04688C23.9688 6.26562 25.7969 8.09375 28.0156 8.09375Z" fill="currentColor"/>
        <path d="M16.0312 8.09375C18.2656 8.09375 20.0781 6.26562 20.0781 4.04688C20.0781 1.8125 18.2656 0 16.0312 0C13.7969 0 11.9844 1.8125 11.9844 4.04688C11.9844 6.26562 13.7969 8.09375 16.0312 8.09375Z" fill="currentColor"/>
        <path d="M4.04688 8.09375C6.26562 8.09375 8.09375 6.26562 8.09375 4.04688C8.09375 1.8125 6.26562 0 4.04688 0C1.8125 0 0 1.8125 0 4.04688C0 6.26562 1.8125 8.09375 4.04688 8.09375Z" fill="currentColor"/>
      </svg>
    `;

    const sessionActionsMenu = document.createElement('div');
    sessionActionsMenu.className = 'session-actions-menu';
    sessionActionsMenu.setAttribute('role', 'menu');
    const saveTemplateDisabled = '';

    // Check if "Send to Top" should be disabled
    let moveToTopDisabled = '';
    if (session.pinned) {
      // For pinned sessions: disable if it's the only pinned or already at top of pinned
      const pinnedSessions = sessions.filter(s => s.pinned);
      const isOnlyPinned = pinnedSessions.length === 1;
      const isTopPinned = sessionIndex === 0;
      moveToTopDisabled = (isOnlyPinned || isTopPinned) ? ' disabled' : '';
    } else {
      // For unpinned sessions: disable if already at top of unpinned
      const firstUnpinnedIndex = sessions.findIndex(s => !s.pinned);
      const isAtTopOfUnpinned = (firstUnpinnedIndex !== -1 && sessionIndex === firstUnpinnedIndex) ||
                                (firstUnpinnedIndex === -1 && sessionIndex === 0);
      moveToTopDisabled = isAtTopOfUnpinned ? ' disabled' : '';
    }

    // Check if "Split Group" should be disabled (need at least 2 tabs to split, or if session is collapsed)
    const splitGroupDisabled = (session.tabs && session.tabs.length <= 1) || isCollapsed ? ' disabled' : '';

    sessionActionsMenu.innerHTML = `
      <div class="session-actions-menu-item-wrapper has-submenu">
        <button class="session-actions-menu-item session-copy-btn" role="menuitem" aria-haspopup="true" aria-expanded="false">
          <svg class="session-actions-menu-icon" viewBox="0 0 31.9842 38.9234" aria-hidden="true">
            <g>
              <path d="M21.7347 1.31063L30.2986 9.95593C31.2864 10.9653 31.6092 11.9467 31.6092 13.4423L31.6092 26.7014C31.6092 29.7431 30.0569 31.3122 27.0416 31.3122L24.0359 31.3122L24.0359 29.3778L26.9348 29.3778C28.7391 29.3778 29.6748 28.4205 29.6748 26.6594L29.6748 12.8786L21.7569 12.8786C20.1247 12.8786 19.3272 12.1355 19.3272 10.4489L19.3272 1.93438L12.2369 1.93438C10.4278 1.93438 9.50282 2.92672 9.50282 4.65281L9.50282 7.57406L7.57328 7.57406L7.57328 4.61078C7.57328 1.56906 9.13047 0 12.1409 0L18.4111 0C19.7391 0 20.7852 0.339532 21.7347 1.31063ZM21.0939 10.2095C21.0939 10.8484 21.3466 11.1119 21.9855 11.1119L29.1009 11.1119L21.0939 3.02829Z"/>
              <path d="M0 34.2755C0 37.328 1.53672 38.8863 4.56766 38.8863L19.4683 38.8863C22.4992 38.8863 24.0359 37.3172 24.0359 34.2755L24.0359 21.6073C24.0359 19.927 23.8113 19.178 22.7695 18.1147L13.5983 8.84047C12.5948 7.81547 11.7752 7.57406 10.2625 7.57406L4.56766 7.57406C1.56203 7.57406 0 9.13235 0 12.1848ZM1.93438 34.2334L1.93438 12.2161C1.93438 10.5008 2.85938 9.50844 4.6636 9.50844L10.365 9.50844L10.365 18.9052C10.365 20.6947 11.2681 21.5483 12.9925 21.5483L22.1016 21.5483L22.1016 34.2334C22.1016 35.9945 21.1658 36.9519 19.3723 36.9519L4.65281 36.9519C2.85938 36.9519 1.93438 35.9945 1.93438 34.2334ZM13.2022 19.7169C12.4803 19.7169 12.1916 19.4281 12.1916 18.7063L12.1916 10.0963L21.7092 19.7169Z"/>
            </g>
          </svg>
          <span>${getMessage('copyMenu')}</span>
          <svg class="submenu-arrow" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
        <div class="session-actions-submenu" role="menu">
          <button class="session-actions-submenu-item" data-copy-format="markdown" data-timestamp="${session.timestamp}" role="menuitem">
            <span>${getMessage('copyFormatMarkdown')}</span>
          </button>
          <button class="session-actions-submenu-item" data-copy-format="plain" data-timestamp="${session.timestamp}" role="menuitem">
            <span>${getMessage('copyFormatPlain')}</span>
          </button>
          <button class="session-actions-submenu-item" data-copy-format="rich" data-timestamp="${session.timestamp}" role="menuitem">
            <span>${getMessage('copyFormatRich')}</span>
          </button>
        </div>
      </div>
      <div class="session-actions-menu-item-wrapper has-submenu">
        <button class="session-actions-menu-item session-export-btn" role="menuitem" aria-haspopup="true" aria-expanded="false">
          <svg class="session-actions-menu-icon" viewBox="0 0 104.834 134.619" aria-hidden="true">
            <path d="M18.7988 134.619L86.0352 134.619C98.5352 134.619 104.834 128.174 104.834 115.625L104.834 57.1777C104.834 49.9023 103.955 46.7285 99.4141 42.1387L63.2324 5.46875C58.9355 1.02539 55.4199 0.0488281 48.9258 0.0488281L18.7988 0.0488281C6.39648 0.0488281 0 6.44531 0 19.043L0 115.625C0 128.223 6.29883 134.619 18.7988 134.619ZM19.2383 125.977C12.2559 125.977 8.64258 122.266 8.64258 115.43L8.64258 19.2383C8.64258 12.5488 12.2559 8.69141 19.2871 8.69141L48.1934 8.69141L48.1934 46.0938C48.1934 53.5645 51.9531 57.1777 59.2773 57.1777L96.1914 57.1777L96.1914 115.43C96.1914 122.266 92.5781 125.977 85.5469 125.977ZM60.2051 49.0234C57.4707 49.0234 56.3477 47.9492 56.3477 45.166L56.3477 10.4004L94.4824 49.0234Z"/>
            <path d="M33.5449 91.9434C31.3477 91.9434 29.7363 93.5059 29.7363 95.7031C29.7363 97.0215 30.3223 97.9492 31.2012 98.7793L49.5605 115.967C50.6836 116.992 51.5137 117.383 52.5879 117.383C53.7598 117.383 54.541 116.992 55.6152 115.967L73.9746 98.7793C74.9023 97.9492 75.4883 97.0215 75.4883 95.7031C75.4883 93.5059 73.8281 91.9434 71.6797 91.9434C70.5566 91.9434 69.4824 92.3828 68.75 93.1641L63.5254 98.5352L53.2227 109.082L51.9531 109.082L41.6992 98.5352L36.4258 93.1641C35.6934 92.3828 34.5703 91.9434 33.5449 91.9434ZM52.5879 65.8203C50.3906 65.8203 48.4863 67.627 48.4863 69.8242L48.4863 94.8242L49.0234 110.107C49.2188 114.746 55.957 114.746 56.1523 110.107L56.7383 94.8242L56.7383 69.8242C56.7383 67.627 54.834 65.8203 52.5879 65.8203Z"/>
          </svg>
          <span>${getMessage('exportMenu')}</span>
          <svg class="submenu-arrow" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
        <div class="session-actions-submenu" role="menu">
          <button class="session-actions-submenu-item" data-export-format="markdown" data-timestamp="${session.timestamp}" role="menuitem">
            <span>${getMessage('exportFormatMarkdown')}</span>
          </button>
          <button class="session-actions-submenu-item" data-export-format="plain" data-timestamp="${session.timestamp}" role="menuitem">
            <span>${getMessage('exportFormatPlain')}</span>
          </button>
          <button class="session-actions-submenu-item" data-export-format="rtf" data-timestamp="${session.timestamp}" role="menuitem">
            <span>${getMessage('copyFormatRich')}</span>
          </button>
          <button class="session-actions-submenu-item" data-export-format="html" data-timestamp="${session.timestamp}" role="menuitem">
            <span>${getMessage('exportFormatHTML')}</span>
          </button>
          <button class="session-actions-submenu-item" data-export-format="json" data-timestamp="${session.timestamp}" role="menuitem">
            <span>${getMessage('exportFormatJSON')}</span>
          </button>
          <button class="session-actions-submenu-item" data-export-format="opml" data-timestamp="${session.timestamp}" role="menuitem">
            <span>${getMessage('exportFormatOPML')}</span>
          </button>
        </div>
      </div>
      <hr class="actions-menu-separator">
      <button class="session-actions-menu-item pin-to-top-btn" role="menuitem" data-timestamp="${session.timestamp}">
        <svg class="session-actions-menu-icon" viewBox="0 0 23.6864 36.9547" aria-hidden="true">
          <g>
            <path d="M0 23.1814C0 24.3206 0.788907 25.0745 2.03047 25.0745L10.5417 25.0745L10.5417 33.3208C10.5417 35.2852 11.3383 36.9547 11.6611 36.9547C11.978 36.9547 12.7745 35.2852 12.7745 33.3208L12.7745 25.0745L21.2809 25.0745C22.5225 25.0745 23.3114 24.3206 23.3114 23.1814C23.3114 19.8458 20.6805 16.4825 16.4255 14.9808L15.9244 7.71203C17.9005 6.54594 19.7755 5.09172 20.5928 3.99641C20.9506 3.51844 21.1392 3.04531 21.1392 2.63469C21.1392 1.79297 20.492 1.17219 19.5097 1.17219L3.8125 1.17219C2.81937 1.17219 2.18297 1.79297 2.18297 2.63469C2.18297 3.04531 2.36078 3.51844 2.71859 3.99641C3.54078 5.09172 5.41578 6.55078 7.38703 7.71203L6.88594 14.9808C2.63094 16.4825 0 19.8458 0 23.1814Z"/>
          </g>
        </svg>
        <span>${getMessage(session.pinned ? 'unpinFromTop' : 'pinToTop')}</span>
      </button>
      <button class="session-actions-menu-item move-to-top-btn${moveToTopDisabled}" role="menuitem" data-timestamp="${session.timestamp}">
        <svg class="session-actions-menu-icon" viewBox="0 0 28.3319 28.6659" aria-hidden="true">
          <g>
            <path d="M4.60594 28.2909L23.6802 28.2909C26.7434 28.2909 28.2909 26.7397 28.2909 23.7341L28.2909 4.56766C28.2909 1.56203 26.7434 0 23.6802 0L4.60594 0C1.55828 0 0 1.5475 0 4.56766L0 23.7341C0 26.7542 1.55828 28.2909 4.60594 28.2909ZM4.64203 26.3614C2.88094 26.3614 1.93438 25.4316 1.93438 23.6273L1.93438 4.67438C1.93438 2.87016 2.88094 1.93438 4.64203 1.93438L23.6489 1.93438C25.375 1.93438 26.3566 2.87016 26.3566 4.67438L26.3566 23.6273C26.3566 25.4316 25.375 26.3614 23.6489 26.3614Z"/>
            <path d="M14.1641 21.9206C14.6809 21.9206 15.1234 21.4997 15.1234 20.9888L15.1234 11.3163L15.0372 8.36078C15.0264 7.82719 14.6006 7.51999 14.1641 7.51999C13.7227 7.51999 13.3125 7.82719 13.2909 8.36078L13.2106 11.3163L13.2106 20.9888C13.2106 21.4997 13.6472 21.9206 14.1641 21.9206ZM14.1641 6.35953C13.9242 6.35953 13.7011 6.43391 13.4709 6.66406L8.26734 11.7539C8.07547 11.9399 7.97953 12.1318 7.97953 12.3933C7.97953 12.8836 8.34172 13.2399 8.84297 13.2399C9.07203 13.2399 9.34313 13.1391 9.51344 12.9472L12.1936 10.1593L14.1641 8.11218L14.1641 8.11218L16.1297 10.1593L18.8098 12.9472C18.9802 13.1391 19.2356 13.2399 19.4647 13.2399C19.9611 13.2399 20.3438 12.8836 20.3438 12.3933C20.3438 12.1318 20.2478 11.9399 20.0619 11.7539L14.8572 6.66406C14.6222 6.43391 14.4147 6.35953 14.1641 6.35953Z"/>
          </g>
        </svg>
        <span>${getMessage('moveToTop')}</span>
      </button>
      <hr class="actions-menu-separator">
      <button class="session-actions-menu-item duplicate-group-btn" role="menuitem" data-timestamp="${session.timestamp}">
        <svg class="session-actions-menu-icon" viewBox="0 0 32.8563 31.7678" aria-hidden="true">
          <g>
            <path d="M24.9031 4.6086L24.9031 6.85391L22.9687 6.85391L22.9688 4.71531C22.9688 2.9111 21.9872 1.97532 20.2611 1.97532L4.64203 1.97532C2.88094 1.97532 1.93438 2.9111 1.93438 4.71531L1.93438 20.2805C1.93438 22.0895 2.88094 23.0253 4.64203 23.0253L7.57813 23.0253L7.57813 24.9548L4.60594 24.9548C1.5475 24.9548 0 23.4073 0 20.3872L0 4.6086C0 1.58844 1.5475 0.0409374 4.60594 0.0409374L20.3031 0.0409374C23.3448 0.0409374 24.9031 1.60297 24.9031 4.6086Z"/>
            <path d="M12.1889 31.7678L27.8861 31.7678C30.923 31.7678 32.4813 30.2058 32.4813 27.2002L32.4813 11.4216C32.4813 8.4111 30.923 6.85391 27.8861 6.85391L12.1889 6.85391C9.12563 6.85391 7.57812 8.39063 7.57812 11.4216L7.57812 27.2002C7.57812 30.2203 9.12563 31.7678 12.1889 31.7678ZM12.2202 29.8334C10.4698 29.8334 9.5125 28.8977 9.5125 27.0934L9.5125 11.5283C9.5125 9.71923 10.4698 8.78345 12.2202 8.78345L27.8392 8.78345C29.5653 8.78345 30.5469 9.71923 30.5469 11.5283L30.5469 27.0934C30.5469 28.8977 29.5653 29.8334 27.8392 29.8334Z"/>
            <path d="M21.0497 25.3686L21.0497 13.217C21.0497 12.6091 20.6191 12.1881 20.0219 12.1881C19.45 12.1881 19.0409 12.6188 19.0409 13.217L19.0409 25.3686C19.0409 25.9561 19.45 26.3867 20.0219 26.3867C20.6191 26.3867 21.0497 25.9766 21.0497 25.3686ZM13.9725 20.2894L26.1241 20.2894C26.7116 20.2894 27.1422 19.8803 27.1422 19.3084C27.1422 18.7113 26.7213 18.2855 26.1241 18.2855L13.9725 18.2855C13.3586 18.2855 12.9436 18.7113 12.9436 19.3084C12.9436 19.8803 13.3742 20.2894 13.9725 20.2894Z"/>
          </g>
        </svg>
        <span>${getMessage('duplicateGroup')}</span>
      </button>
      <button class="session-actions-menu-item split-group-btn${splitGroupDisabled}" role="menuitem" data-timestamp="${session.timestamp}">
        <svg class="session-actions-menu-icon" viewBox="0 0 28.7745 36.6053" aria-hidden="true">
          <g>
            <path d="M14.2052 35.9594C14.493 35.9594 14.7759 35.8263 15.0002 35.5913L21.0925 29.5172C21.3469 29.252 21.4886 28.9858 21.4886 28.6581C21.4886 28.0717 21.0461 27.6233 20.4489 27.6233C20.1514 27.6233 19.8695 27.7181 19.6572 27.9364L14.2052 33.658L8.75797 27.9364C8.55047 27.7181 8.26375 27.6233 7.9711 27.6233C7.37391 27.6233 6.93141 28.0717 6.93141 28.6581C6.93141 28.9858 7.07312 29.252 7.3275 29.5172L13.415 35.5913C13.6344 35.8263 13.9066 35.9594 14.2052 35.9594ZM15.1764 33.2753L15.2616 29.3333L15.2616 21.9634C15.2616 21.3339 14.8239 20.907 14.2052 20.907C13.5864 20.907 13.1428 21.3339 13.1428 21.9634L13.1428 29.3333L13.2388 33.2753C13.2495 33.8197 13.6656 34.2417 14.2052 34.2417C14.7495 34.2417 15.1656 33.8197 15.1764 33.2753Z"/>
            <path d="M0 17.9797C0 18.5888 0.43172 19.0313 1.04563 19.0313L27.3695 19.0313C27.9678 19.0313 28.3995 18.5888 28.3995 17.9797C28.3995 17.3706 27.9678 16.9173 27.3695 16.9173L1.04563 16.9173C0.43172 16.9173 0 17.3706 0 17.9797Z"/>
            <path d="M15.1764 2.67329C15.1656 2.14454 14.7495 1.71766 14.2052 1.71766C13.6656 1.71766 13.2495 2.14454 13.2388 2.67329L13.1428 6.6261L13.1428 13.9852C13.1428 14.6147 13.5864 15.0416 14.2052 15.0416C14.8239 15.0416 15.2616 14.6147 15.2616 13.9852L15.2616 6.6261ZM14.2052 0C13.9066 0 13.6344 0.122344 13.415 0.357345L7.3275 6.44219C7.07312 6.70735 6.93141 6.96282 6.93141 7.29047C6.93141 7.87688 7.37391 8.32532 7.9711 8.32532C8.26375 8.32532 8.55047 8.24126 8.75797 8.01219L14.2052 2.29547L19.6572 8.01219C19.8695 8.24126 20.1514 8.32532 20.4489 8.32532C21.0461 8.32532 21.4886 7.87688 21.4886 7.29047C21.4886 6.96282 21.3469 6.70735 21.0925 6.44219L15.0002 0.357345C14.7759 0.122344 14.493 0 14.2052 0Z"/>
          </g>
        </svg>
        <span>${getMessage('splitGroup')}</span>
      </button>
      <hr class="actions-menu-separator">
      <button class="session-actions-menu-item save-template-btn${saveTemplateDisabled}" role="menuitem" data-timestamp="${session.timestamp}">
        <svg class="session-actions-menu-icon" viewBox="0 0 31.722 37.3644" aria-hidden="true">
          <g>
            <path d="M18.5463 0.911902C18.5463 2.4956e-05 17.9163-0.252163 17.1769 0.265182L12.3244 3.67315C11.7122 4.10643 11.723 4.72565 12.3244 5.14815L17.1877 8.56097C17.9163 9.06753 18.5463 8.81534 18.5463 7.9094ZM15.6711 34.3455C24.3275 34.3455 31.347 27.326 31.347 18.6744C31.347 10.018 24.3383 3.00924 15.6555 3.00331C15.0809 3.00924 14.653 3.47221 14.653 4.00097C14.653 4.55612 15.0917 5.02503 15.6663 5.02503C23.2183 5.02503 29.3205 11.1272 29.3205 18.6744C29.3205 26.2167 23.2183 32.3189 15.6711 32.3189C8.12875 32.3189 2.02657 26.2167 2.02657 18.6744C2.02657 13.9258 4.45141 9.74722 8.1175 7.34316C8.60797 6.97987 8.76266 6.41503 8.46891 5.91378C8.17516 5.43893 7.5025 5.29503 6.97484 5.68581C2.75953 8.49519 0 13.2327 0 18.6744C0 27.326 7.01953 34.3455 15.6711 34.3455Z"/>
            <path d="M16.6833 24.7297L16.6833 12.583C16.6833 11.975 16.2527 11.5541 15.6555 11.5541C15.0836 11.5541 14.6637 11.9799 14.6637 12.583L14.6637 24.7297C14.6637 25.3221 15.0836 25.7527 15.6555 25.7527C16.2527 25.7527 16.6833 25.3377 16.6833 24.7297ZM9.60016 19.6553L21.7577 19.6553C22.35 19.6553 22.7758 19.2463 22.7758 18.6744C22.7758 18.0772 22.3548 17.6466 21.7577 17.6466L9.60016 17.6466C8.99219 17.6466 8.57719 18.0772 8.57719 18.6744C8.57719 19.2463 8.99703 19.6553 9.60016 19.6553Z"/>
          </g>
        </svg>
        <span>${getMessage('saveAsTemplate')}</span>
      </button>
      <hr class="actions-menu-separator">
      <div class="session-color-picker-wrapper">
        <div class="session-color-picker-container clickable-color">
          <div class="session-color-picker" data-timestamp="${session.timestamp}">
            <button class="color-dot color-dot-none" data-color="none" title="None" aria-label="No color"></button>
            <button class="color-dot" data-color="blue" style="background-color: #007AFF;" title="Blue" aria-label="Blue"></button>
            <button class="color-dot" data-color="green" style="background-color: #53b559;" title="Green" aria-label="Green"></button>
            <button class="color-dot" data-color="yellow" style="background-color: #ffc400;" title="Yellow" aria-label="Yellow"></button>
            <button class="color-dot" data-color="orange" style="background-color: #fa6a22;" title="Orange" aria-label="Orange"></button>
            <button class="color-dot" data-color="red" style="background-color: #FF0000;" title="Red" aria-label="Red"></button>
            <button class="color-dot" data-color="pink" style="background-color: #ff66ad;" title="Pink" aria-label="Pink"></button>
            <button class="color-dot" data-color="purple" style="background-color: #924ff6;" title="Purple" aria-label="Purple"></button>
            <button class="color-dot color-dot-custom" data-color="custom" title="Custom color" aria-label="Custom color">
              <input type="color" class="color-picker-input" data-timestamp="${session.timestamp}">
            </button>
          </div>
        </div>
      </div>
    `;

    sessionActionsMenuContainer.appendChild(sessionActionsMenuBtn);
    sessionActionsMenuContainer.appendChild(sessionActionsMenu);
    actionsRow.appendChild(sessionActionsMenuContainer);

    let sessionMenuHideTimeout;

    // Toggle menu on button click
    sessionActionsMenuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = sessionActionsMenu.classList.contains('show');
      // Close all other session menus first
      document.querySelectorAll('.session-actions-menu.show').forEach(menu => {
        menu.classList.remove('show');
        const btn = menu.previousElementSibling;
        if (btn) btn.setAttribute('aria-expanded', 'false');
      });
      document.body.classList.remove('session-menu-open');

      // Close header actions menu
      const headerActionsMenuBtn = document.getElementById('actionsMenuBtn');
      const headerActionsMenu = document.getElementById('actionsMenu');
      if (headerActionsMenuBtn && headerActionsMenu) {
        headerActionsMenu.classList.remove('show');
        headerActionsMenuBtn.setAttribute('aria-expanded', 'false');
      }

      if (!isOpen) {
        // Reset any previous position adjustments
        sessionActionsMenu.style.top = '';

        sessionActionsMenu.classList.add('show');
        sessionActionsMenuBtn.setAttribute('aria-expanded', 'true');
        document.body.classList.add('session-menu-open');

        // Check if menu extends beyond viewport and adjust position
        const menuRect = sessionActionsMenu.getBoundingClientRect();
        const viewportHeight = window.innerHeight;
        const padding = 20; // Padding from viewport edge

        if (menuRect.bottom > viewportHeight - padding) {
          // Shift menu up by the overflow amount plus extra buffer
          const overflow = menuRect.bottom - viewportHeight + padding + 120;
          sessionActionsMenu.style.top = `${-overflow}px`;
        }
      }
    });

    // Keep menu open when hovering over button (if already open)
    sessionActionsMenuBtn.addEventListener('mouseenter', () => {
      clearTimeout(sessionMenuHideTimeout);
    });

    // Close menu when mouse leaves button (with 1s delay for less finicky interaction)
    sessionActionsMenuBtn.addEventListener('mouseleave', () => {
      const isOpen = sessionActionsMenu.classList.contains('show');
      if (isOpen) {
        sessionMenuHideTimeout = setTimeout(() => {
          // Don't close if color picker is active
          const pickerActive = sessionActionsMenu.dataset.colorPickerActive === 'true';
          if (pickerActive) {
            return;
          }
          sessionActionsMenu.classList.remove('show');
          sessionActionsMenuBtn.setAttribute('aria-expanded', 'false');
          document.body.classList.remove('session-menu-open');
          freezeClicks(250);
        }, 1000);
      }
    });

    // Keep menu open when hovering over it
    sessionActionsMenu.addEventListener('mouseenter', () => {
      clearTimeout(sessionMenuHideTimeout);
    });

    sessionActionsMenu.addEventListener('mouseleave', () => {
      sessionMenuHideTimeout = setTimeout(() => {
        // Don't close if color picker is active
        const pickerActive = sessionActionsMenu.dataset.colorPickerActive === 'true';
        if (pickerActive) {
          return;
        }
        sessionActionsMenu.classList.remove('show');
        sessionActionsMenuBtn.setAttribute('aria-expanded', 'false');
        document.body.classList.remove('session-menu-open');
        freezeClicks(250);
      }, 1000);
    });

    // Note: Menu closing on outside click is handled globally at the document level
    // See the document-level click handler that closes all open menus

    // Handle submenu hover
    const sessionCopyBtn = sessionActionsMenu.querySelector('.session-copy-btn');
    const sessionCopyWrapper = sessionCopyBtn?.closest('.session-actions-menu-item-wrapper');
    const sessionCopySubmenu = sessionCopyWrapper?.querySelector('.session-actions-submenu');
    debug('[Session Menu] Copy button:', !!sessionCopyBtn, 'Wrapper:', !!sessionCopyWrapper, 'Submenu:', !!sessionCopySubmenu);
    if (sessionCopyBtn && sessionCopyWrapper && sessionCopySubmenu) {
      let copyHideTimeout;

      sessionCopyWrapper.addEventListener('mouseenter', () => {
        clearTimeout(copyHideTimeout);
        sessionCopySubmenu.classList.add('show');
        positionSubmenu(sessionCopySubmenu);
        sessionCopyBtn.setAttribute('aria-expanded', 'true');
      });

      sessionCopyWrapper.addEventListener('mouseleave', () => {
        copyHideTimeout = setTimeout(() => {
          sessionCopySubmenu.classList.remove('show');
          sessionCopyBtn.setAttribute('aria-expanded', 'false');
        }, 400);
      });

      // Keep submenu visible when hovering over it
      sessionCopySubmenu.addEventListener('mouseenter', () => {
        clearTimeout(copyHideTimeout);
      });

      sessionCopySubmenu.addEventListener('mouseleave', () => {
        copyHideTimeout = setTimeout(() => {
          sessionCopySubmenu.classList.remove('show');
          sessionCopyBtn.setAttribute('aria-expanded', 'false');
        }, 400);
      });

      // Handle copy format selection
      const copyFormatBtns = sessionCopySubmenu.querySelectorAll('.session-actions-submenu-item');
      copyFormatBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const format = btn.dataset.copyFormat;
          const timestamp = btn.dataset.timestamp;
          sessionActionsMenu.classList.remove('show');
          sessionActionsMenuBtn.setAttribute('aria-expanded', 'false');
          sessionCopySubmenu.classList.remove('show');
          document.body.classList.remove('session-menu-open');
          sessionCopyBtn.setAttribute('aria-expanded', 'false');
          freezeClicks(250);
          handleSessionCopy(timestamp, format);
        });
      });
    }

    // Handle export submenu hover
    const sessionExportBtn = sessionActionsMenu.querySelector('.session-export-btn');
    const sessionExportWrapper = sessionExportBtn?.closest('.session-actions-menu-item-wrapper');
    const sessionExportSubmenu = sessionExportWrapper?.querySelector('.session-actions-submenu');
    if (sessionExportBtn && sessionExportWrapper && sessionExportSubmenu) {
      let exportHideTimeout;

      sessionExportWrapper.addEventListener('mouseenter', () => {
        clearTimeout(exportHideTimeout);
        sessionExportSubmenu.classList.add('show');
        positionSubmenu(sessionExportSubmenu);
        sessionExportBtn.setAttribute('aria-expanded', 'true');
      });

      sessionExportWrapper.addEventListener('mouseleave', () => {
        exportHideTimeout = setTimeout(() => {
          sessionExportSubmenu.classList.remove('show');
          sessionExportBtn.setAttribute('aria-expanded', 'false');
        }, 400);
      });

      sessionExportSubmenu.addEventListener('mouseenter', () => {
        clearTimeout(exportHideTimeout);
      });

      sessionExportSubmenu.addEventListener('mouseleave', () => {
        exportHideTimeout = setTimeout(() => {
          sessionExportSubmenu.classList.remove('show');
          sessionExportBtn.setAttribute('aria-expanded', 'false');
        }, 400);
      });

      const exportFormatBtns = sessionExportSubmenu.querySelectorAll('.session-actions-submenu-item');
      exportFormatBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const format = btn.dataset.exportFormat;
          const timestamp = btn.dataset.timestamp;
          sessionExportSubmenu.classList.remove('show');
          sessionExportBtn.setAttribute('aria-expanded', 'false');
          handleSessionExport(timestamp, format, () => {
            sessionActionsMenu.classList.remove('show');
            sessionActionsMenuBtn.setAttribute('aria-expanded', 'false');
            document.body.classList.remove('session-menu-open');
            freezeClicks(250);
          });
        });
      });
    }

    // Handle "Save as Template" click
    const saveTemplateBtn = sessionActionsMenu.querySelector('.save-template-btn');
    if (saveTemplateBtn) {
      saveTemplateBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const timestamp = saveTemplateBtn.dataset.timestamp;
        sessionActionsMenu.classList.remove('show');
        sessionActionsMenuBtn.setAttribute('aria-expanded', 'false');
        document.body.classList.remove('session-menu-open');
        handleSaveAsTemplate(timestamp);
      });
    }

    // Handle "Move to Top" click
    const moveToTopBtn = sessionActionsMenu.querySelector('.move-to-top-btn');
    if (moveToTopBtn) {
      moveToTopBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const timestamp = moveToTopBtn.dataset.timestamp;
        sessionActionsMenu.classList.remove('show');
        sessionActionsMenuBtn.setAttribute('aria-expanded', 'false');
        document.body.classList.remove('session-menu-open');
        handleMoveToTop(timestamp);
      });
    }

    // Handle "Split Group" click
    const splitGroupBtn = sessionActionsMenu.querySelector('.split-group-btn');
    if (splitGroupBtn) {
      splitGroupBtn.addEventListener('click', (e) => {
        debug('[SPLIT] Split button clicked');
        // Check if button is disabled
        if (splitGroupBtn.classList.contains('disabled')) {
          debug('[SPLIT] Button is disabled, ignoring click');
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        const timestamp = splitGroupBtn.dataset.timestamp;
        debug('[SPLIT] Entering split mode for timestamp:', timestamp);
        sessionActionsMenu.classList.remove('show');
        sessionActionsMenuBtn.setAttribute('aria-expanded', 'false');
        document.body.classList.remove('session-menu-open');
        enterSplitMode(timestamp);
      });
    }

    // Handle "Duplicate Group" click
    const duplicateGroupBtn = sessionActionsMenu.querySelector('.duplicate-group-btn');
    if (duplicateGroupBtn) {
      duplicateGroupBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const timestamp = duplicateGroupBtn.dataset.timestamp;
        sessionActionsMenu.classList.remove('show');
        sessionActionsMenuBtn.setAttribute('aria-expanded', 'false');
        document.body.classList.remove('session-menu-open');
        handleDuplicateGroup(timestamp);
      });
    }

    // Handle "Pin to Top" click
    const pinToTopBtn = sessionActionsMenu.querySelector('.pin-to-top-btn');
    if (pinToTopBtn) {
      pinToTopBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const timestamp = pinToTopBtn.dataset.timestamp;
        sessionActionsMenu.classList.remove('show');
        sessionActionsMenuBtn.setAttribute('aria-expanded', 'false');
        document.body.classList.remove('session-menu-open');
        handlePinToTop(timestamp);
      });
    }

    // Handle color picker clicks
    const colorDots = sessionActionsMenu.querySelectorAll('.color-dot');
    colorDots.forEach(dot => {
      dot.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();

        const color = dot.dataset.color;

        // If custom color, open the color picker instead
        if (color === 'custom') {
          // Set colorPickerActive IMMEDIATELY, synchronously, before anything else
          // This prevents the menu mouseleave timeout from closing the menu
          const menuContainer = e.target.closest('.session-actions-menu-container');
          const currentMenu = menuContainer?.querySelector('.session-actions-menu');
          const wrapper = menuContainer?.closest('.session-wrapper');

          if (currentMenu) {
            currentMenu.dataset.colorPickerActive = 'true';
          }
          if (wrapper) {
            wrapper.classList.add('color-picker-active');
          }

          const colorInput = dot.querySelector('.color-picker-input');
          if (colorInput) {
            colorInput.click();
          }
          return;
        }

        const timestamp = dot.closest('.session-color-picker').dataset.timestamp;
        handleSessionColorChange(timestamp, color);

        // Don't close menu - let user try multiple colors
        // Menu will close on outside click or when clicking menu button again

        // Blur the button to remove focus and allow other interactions
        dot.blur();
      });
    });

    // Handle custom color picker input
    const colorInputs = sessionActionsMenu.querySelectorAll('.color-picker-input');
    colorInputs.forEach(input => {
      input.addEventListener('change', (e) => {
        e.preventDefault();
        e.stopPropagation();

        const hexColor = e.target.value;
        const timestamp = e.target.dataset.timestamp;
        handleSessionColorChange(timestamp, hexColor);

        // Clear color picker active flag after selection
        const currentMenu = e.target.closest('.session-actions-menu-container')?.querySelector('.session-actions-menu');
        if (currentMenu) {
          delete currentMenu.dataset.colorPickerActive;
        }

        // Remove wrapper class
        const wrapper = e.target.closest('.session-wrapper');
        if (wrapper) {
          wrapper.classList.remove('color-picker-active');
        }

        // Don't close menu - let user try multiple colors
        // Menu will close on outside click or when clicking menu button again
      });

      // Prevent the click from bubbling up to the button
      input.addEventListener('click', (e) => {
        e.stopPropagation();
      });

      input.addEventListener('focus', (e) => {
        // Find the current menu (in case DOM was rebuilt)
        const currentMenu = e.target.closest('.session-actions-menu-container')?.querySelector('.session-actions-menu');
        if (currentMenu) {
          currentMenu.dataset.colorPickerActive = 'true';

          // Also add class to wrapper to keep it in "hover" state for locked sessions
          const wrapper = e.target.closest('.session-wrapper');
          if (wrapper) {
            wrapper.classList.add('color-picker-active');
          }
        }
      });
    });

    // "Restore" link
    const openAllLink = document.createElement('a');
    openAllLink.href = '#';
    openAllLink.tabIndex = 0;
    openAllLink.className = 'open-session-link';
    openAllLink.title = getMessage("restoreAllTabs");
    openAllLink.setAttribute('aria-label', getMessage("restoreAllTabs") || 'Restore all tabs');
    openAllLink.innerHTML = `
      <svg version="1.1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 28.5004 38.1558" aria-hidden="true">
        <path d="M0 20.1866C0 27.9557 6.29112 34.2518 14.0652 34.2518C21.8343 34.2518 28.1254 27.9557 28.1254 20.1866C28.1254 19.1228 27.3954 18.3872 26.3615 18.3872C25.3538 18.3872 24.6558 19.1228 24.6558 20.1759C24.6558 26.0228 19.912 30.7665 14.0652 30.7665C8.21339 30.7665 3.47457 26.0228 3.47457 20.1759C3.47457 14.3241 8.21339 9.58532 14.0652 9.58532C14.9205 9.58532 15.7062 9.6386 16.3647 9.79276L12.4935 13.6277C12.1732 13.9317 12.0099 14.3145 12.0099 14.7817C12.0099 15.7439 12.7499 16.4789 13.6908 16.4789C14.1808 16.4789 14.5713 16.3035 14.8802 16.0052L21.283 9.54145C21.6536 9.18142 21.8283 8.75961 21.8283 8.27105C21.8283 7.80806 21.638 7.35996 21.283 7.00562L14.8909 0.499216C14.577 0.164749 14.1808 0 13.6908 0C12.7499 0 12.0099 0.766214 12.0099 1.7334C12.0099 2.20064 12.1789 2.5827 12.4829 2.88736L15.9627 6.30753C15.3944 6.20097 14.7401 6.1214 14.0652 6.1214C6.29112 6.1214 0 12.4175 0 20.1866Z">
      </svg>


    `;
    openAllLink.addEventListener('click', (e) => {
      e.preventDefault();

      // SHIFT + OPTION => ignore SHIFT
      let shiftKey = e.shiftKey;
      const altKey = e.altKey;
      if (altKey) {
        shiftKey = false;
      }

        chrome.runtime.sendMessage({
          action: "reopenTabs",
          tabList: session.tabs,
          timestamp: session.timestamp,
          invertDelete: shiftKey,
          invertBackground: altKey
        });
        // Trigger review prompt evaluation after positive action
      });
    actionsRow.appendChild(openAllLink);

      // "Merge" link
      const mergeLink = document.createElement('a');
      mergeLink.href = '#';
      mergeLink.tabIndex = 0;
      mergeLink.className = 'merge-session-link';
      mergeLink.title = getMessage("mergeIntoSessionBelow");
      mergeLink.setAttribute('aria-label', getMessage("mergeIntoSessionBelow") || 'Merge into session below');
      mergeLink.innerHTML = `
      <svg version="1.1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 95.3047 112.053" style="height:15px;width:15px;" aria-hidden="true">
       <g>
        <path d="M95.3047 106.169C95.3047 102.797 92.8818 100.276 89.5498 100.276L5.8437 100.276C2.46287 100.276 0 102.797 0 106.169C0 109.532 2.46287 112.053 5.8437 112.053L89.5498 112.053C92.8818 112.053 95.3047 109.532 95.3047 106.169ZM6.08392 47.6602C2.82321 47.6602 0.377914 50.1416 0.377914 53.5254C0.377914 55.0586 0.949198 56.498 2.22067 57.792L43.2178 98.4063C44.4365 99.6475 45.9648 100.383 47.6523 100.383C49.3398 100.383 50.8681 99.6475 52.0869 98.4063L93.0928 57.792C94.3642 56.498 94.9355 55.0586 94.9355 53.5254C94.9355 50.1416 92.4902 47.6602 89.2295 47.6602C87.5557 47.6602 86.0088 48.3506 84.9903 49.4092L69.291 64.9132L47.6523 88.6886L26.0049 64.9132L10.3231 49.4092C9.29581 48.3418 7.75774 47.6602 6.08392 47.6602ZM52.8662 89.0421L53.5927 69.338L53.5927 6.00581C53.5927 2.46287 51.165 0 47.6523 0C44.1309 0 41.7119 2.46287 41.7119 6.00581L41.7119 69.338L42.4297 89.0421C42.5713 91.877 44.8086 94.2247 47.6523 94.2247C50.4961 94.2247 52.7246 91.877 52.8662 89.0421Z"/>
       </g>
      </svg>

      `;

      // Determine next item (could be Smart Group or session)
      const nextItem = sessions[sessionIndex + 1];

      // Disable merge if locked or if it's the last item
      const canMerge = !session.locked &&
                       nextItem &&
                       !nextItem.locked &&
                       sessionIndex < sessions.length - 1;

      if (!canMerge) {
        mergeLink.classList.add('disabled-link');
        mergeLink.addEventListener('click', (e) => { e.preventDefault(); });
      } else {
        mergeLink.addEventListener('click', (e) => {
          e.preventDefault();
          if (session.isSmartGroup) {
            doPendingMergeSmartGroup(session.id, nextItem);
          } else {
            doPendingMerge(session.timestamp, nextItem.timestamp);
          }
        });
      }
      actionsRow.appendChild(mergeLink);

    // "Delete" link
    const deleteLink = document.createElement('a');
    deleteLink.href = '#';
    deleteLink.tabIndex = 0;
    deleteLink.className = 'delete-session-link';
    deleteLink.title = getMessage("draftDelete");
    deleteLink.setAttribute('aria-label', getMessage("draftDelete") || 'Delete session');
    deleteLink.innerHTML = `
      <svg viewBox="0 0 31.179 38.1519" aria-hidden="true">
        <path fill="currentColor" d="M10.8009 29.9681C11.4594 29.9681 11.8837 29.5509 11.8681 28.9366L11.3894 12.5553C11.3709 11.9465 10.9409 11.5422 10.3109 11.5422C9.65812 11.5422 9.23655 11.9594 9.25218 12.5709L9.71812 28.945C9.73655 29.5666 10.1694 29.9681 10.8009 29.9681ZM15.4034 29.9681C16.0506 29.9681 16.5062 29.5566 16.5062 28.9478L16.5062 12.5653C16.5062 11.9565 16.0506 11.5422 15.4034 11.5422C14.7534 11.5422 14.3106 11.9565 14.3106 12.5653L14.3106 28.9478C14.3106 29.5566 14.7534 29.9681 15.4034 29.9681ZM20.0159 29.9681C20.6375 29.9681 21.0675 29.5666 21.0859 28.945L21.5519 12.5709C21.5675 11.9594 21.1459 11.5422 20.4931 11.5422C19.8631 11.5422 19.4331 11.9465 19.4147 12.5681L18.9487 28.9366C18.9331 29.5509 19.3575 29.9681 20.0159 29.9681ZM8.305 7.18844L11.1887 7.18844L11.1887 3.94312C11.1887 3.13405 11.7547 2.61499 12.6247 2.61499L18.1537 2.61499C19.0237 2.61499 19.5897 3.13405 19.5897 3.94312L19.5897 7.18844L22.4734 7.18844L22.4734 3.79812C22.4734 1.40875 20.9484 0 18.3594 0L12.4191 0C9.83 0 8.305 1.40875 8.305 3.79812ZM1.3828 8.88842L29.434 8.88842C30.204 8.88842 30.804 8.27686 30.804 7.50686C30.804 6.74249 30.204 6.14375 29.434 6.14375L1.3828 6.14375C0.625622 6.14375 0 6.74249 0 7.50686C0 8.28967 0.625622 8.88842 1.3828 8.88842ZM8.22749 35.2581L22.5894 35.2581C24.9812 35.2581 26.5347 33.7937 26.6469 31.3991L27.7209 8.58873L24.8228 8.58873L23.7956 30.9337C23.7644 31.8712 23.1459 32.4937 22.255 32.4937L8.53624 32.4937C7.67092 32.4937 7.05248 31.8556 7.00842 30.9337L5.92998 8.58873L3.08312 8.58873L4.17 31.4119C4.285 33.8065 5.81 35.2581 8.22749 35.2581Z"/>
      </svg>

    `;
    if (session.locked) {
      deleteLink.classList.add('disabled-link');
    }
    deleteLink.addEventListener('click', (e) => {
      e.preventDefault();
      if (session.locked) return;

      if (session.isSmartGroup) {
        // Delete Smart Group (clears tabs but keeps pattern)
        doPendingDeleteSmartGroup(session.id);
      } else {
        // Delete regular session
        doPendingDeleteSession(session.timestamp);
      }
    });
    actionsRow.appendChild(deleteLink);

    // Lock/unlock
    const lockLink = document.createElement('a');
    lockLink.href = '#';
    lockLink.tabIndex = 0;
    lockLink.className = 'lock-session-link';
    if (session.locked) {
      lockLink.className = 'lock-session-link locked';
      lockLink.innerHTML = `
        <svg version="1.1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 21.5869 31.1647" aria-hidden="true">
          <path d="M3.31703 30.3269L17.8948 30.3269C19.9931 30.3269 21.2119 29.0672 21.2119 26.8213L21.2119 15.6584C21.2119 13.4125 19.9931 12.1636 17.8948 12.1636L3.31703 12.1636C1.21875 12.1636 0 13.4125 0 15.6584L0 26.8213C0 29.0672 1.21875 30.3269 3.31703 30.3269ZM2.7925 13.0809L4.71985 13.0809L4.71985 8.31313C4.71985 4.23516 7.2936 1.83141 10.5981 1.83141C13.8978 1.83141 16.5028 4.23516 16.5028 8.31313L16.5028 13.0809L18.4145 13.0809L18.4145 8.52125C18.4145 3.01922 14.842 0 10.5981 0C6.36985 0 2.7925 3.01922 2.7925 8.52125Z"/>
        </svg>

      `;
      lockLink.title = getMessage("sessionLocked");
      lockLink.setAttribute('aria-label', getMessage("sessionLocked") || 'Session locked');
    } else {
      lockLink.innerHTML = `
        <svg viewBox="0 0 22.2403 31.9312" aria-hidden="true">
           <path d="M3.61687 31.1187L18.2484 31.1187C20.6212 31.1187 21.8653 29.8462 21.8653 27.2847L21.8653 16.2181C21.8653 13.6778 20.6212 12.4053 18.2484 12.4053L3.61687 12.4053C1.24125 12.4053 0 13.6778 0 16.2181L0 27.2847C0 29.8462 1.24125 31.1187 3.61687 31.1187ZM4.06061 28.3178C3.41123 28.3178 3.04029 27.9212 3.04029 27.1837L3.04029 16.3247C3.04029 15.5844 3.41123 15.2062 4.06061 15.2062L17.8075 15.2062C18.4697 15.2062 18.8222 15.5844 18.8222 16.3247L18.8222 27.1837C18.8222 27.9212 18.4697 28.3178 17.8075 28.3178ZM2.85812 13.7181L5.78404 13.7181L5.78404 8.46093C5.78404 4.79186 8.13092 2.79811 10.9262 2.79811C13.7159 2.79811 16.0969 4.79186 16.0969 8.46093L16.0969 13.7181L19.01 13.7181L19.01 8.73844C19.01 2.97312 15.1944 0 10.9262 0C6.67093 0 2.85812 2.97312 2.85812 8.73844Z"/>
         </svg>

      `;
      lockLink.title = getMessage("lockSessionTitle");
      lockLink.setAttribute('aria-label', getMessage("lockSessionTitle") || 'Lock session');
    }
    actionsRow.appendChild(lockLink);

    lockLink.addEventListener('click', (e) => {
      e.preventDefault();
      session.locked = !session.locked;

      if (session.isSmartGroup) {
        // Update Smart Groups storage
        chrome.storage.local.get(['smartGroups'], (result) => {
          const smartGroups = result.smartGroups || [];
          const group = smartGroups.find(g => g.id === session.id);
          if (group) {
            group.locked = session.locked;
            chrome.storage.local.set({ smartGroups }, () => {
              updateSessionList(savedSessions);
            });
          }
        });
      } else {
        // Update sessions storage
        chrome.storage.local.set({ savedSessions }, () => {
          updateSessionList(savedSessions);
        });
      }
    });

    header.appendChild(actionsRow);

    const card = document.createElement('div');
    card.className = 'session-card';
    const ul = document.createElement('ul');

    // If empty, show a friendly placeholder
    if (!session.tabs || session.tabs.length === 0) {
      const placeholder = document.createElement('div');
      placeholder.className = 'empty-session-placeholder';
      const hint = getMessage('emptySessionHint') || 'Drag links here to add to this session';
      placeholder.textContent = hint;
      card.appendChild(placeholder);
    }

    session.tabs.forEach((tab, tabIndex) => {
      const li = document.createElement('li');
      li.dataset.index = tabIndex;
      const rowDiv = document.createElement('div');
      rowDiv.className = 'link-row';
      const linkArea = document.createElement('a');
      linkArea.href = tab.url;
      linkArea.tabIndex = 0;
      linkArea.setAttribute('data-url', tab.url);
      linkArea.setAttribute('data-timestamp', session.timestamp);
      // QOL: show full URL on hover
      linkArea.setAttribute('title', tab.url);
      linkArea.setAttribute('draggable', 'false');
      linkArea.setAttribute('aria-label', `Open ${tab.title || tab.url}`);
      linkArea.innerHTML = `
          <span class="favicon-wrap">
            <img src="${computeFavicon(tab.url)}" alt="">
            <span class="drag-handle" title="Drag to reorder" aria-hidden="true"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true" stroke-width=".5"><circle cx="12" cy="5" r="1"/><circle cx="19" cy="5" r="1"/><circle cx="5" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/><circle cx="12" cy="19" r="1"/><circle cx="19" cy="19" r="1"/><circle cx="5" cy="19" r="1"/></svg></span>
          </span>
          <span class="link-text">${escapeHtml(tab.title || tab.url)}</span>
        `;

      // Prevent native browser drag for anchors/images inside our custom DnD area
      linkArea.addEventListener('dragstart', (ev) => ev.preventDefault());
      const favImg = linkArea.querySelector('img');
      if (favImg) {
        favImg.setAttribute('draggable', 'false');
        favImg.addEventListener('dragstart', (ev) => ev.preventDefault());
      }

      // Regular click handler for opening the tab
      linkArea.addEventListener('click', (ev) => {
          ev.preventDefault();
          let shiftKey = ev.shiftKey;
          const altKey = ev.altKey;  // Now detect Option key instead of Command
          if (altKey) {
            shiftKey = false;
          }
          chrome.runtime.sendMessage({
            action: "openSingleTab",
            url: tab.url,
            timestamp: session.timestamp,
            invertDelete: shiftKey,
            invertBackground: altKey
          });
        });

      const dragHandle = linkArea.querySelector('.drag-handle');
      dragHandle.title = getMessage("dragToReorder");
      dragHandle.addEventListener('pointerdown', (ev) => {
        ev.preventDefault();
        startPointerDrag(ev, li, session, tabIndex, tab.url);
      });
      const rightSide = document.createElement('div');
      rightSide.className = 'link-right-side';
      const clearBtn = document.createElement('button');
      clearBtn.className = 'clear-btn';
      clearBtn.innerHTML = `<svg viewBox="0 0 31.179 38.1519" aria-hidden="true">
        <path fill="currentColor" d="M10.8009 29.9681C11.4594 29.9681 11.8837 29.5509 11.8681 28.9366L11.3894 12.5553C11.3709 11.9465 10.9409 11.5422 10.3109 11.5422C9.65812 11.5422 9.23655 11.9594 9.25218 12.5709L9.71812 28.945C9.73655 29.5666 10.1694 29.9681 10.8009 29.9681ZM15.4034 29.9681C16.0506 29.9681 16.5062 29.5566 16.5062 28.9478L16.5062 12.5653C16.5062 11.9565 16.0506 11.5422 15.4034 11.5422C14.7534 11.5422 14.3106 11.9565 14.3106 12.5653L14.3106 28.9478C14.3106 29.5566 14.7534 29.9681 15.4034 29.9681ZM20.0159 29.9681C20.6375 29.9681 21.0675 29.5666 21.0859 28.945L21.5519 12.5709C21.5675 11.9594 21.1459 11.5422 20.4931 11.5422C19.8631 11.5422 19.4331 11.9465 19.4147 12.5681L18.9487 28.9366C18.9331 29.5509 19.3575 29.9681 20.0159 29.9681ZM8.305 7.18844L11.1887 7.18844L11.1887 3.94312C11.1887 3.13405 11.7547 2.61499 12.6247 2.61499L18.1537 2.61499C19.0237 2.61499 19.5897 3.13405 19.5897 3.94312L19.5897 7.18844L22.4734 7.18844L22.4734 3.79812C22.4734 1.40875 20.9484 0 18.3594 0L12.4191 0C9.83 0 8.305 1.40875 8.305 3.79812ZM1.3828 8.88842L29.434 8.88842C30.204 8.88842 30.804 8.27686 30.804 7.50686C30.804 6.74249 30.204 6.14375 29.434 6.14375L1.3828 6.14375C0.625622 6.14375 0 6.74249 0 7.50686C0 8.28967 0.625622 8.88842 1.3828 8.88842ZM8.22749 35.2581L22.5894 35.2581C24.9812 35.2581 26.5347 33.7937 26.6469 31.3991L27.7209 8.58873L24.8228 8.58873L23.7956 30.9337C23.7644 31.8712 23.1459 32.4937 22.255 32.4937L8.53624 32.4937C7.67092 32.4937 7.05248 31.8556 7.00842 30.9337L5.92998 8.58873L3.08312 8.58873L4.17 31.4119C4.285 33.8065 5.81 35.2581 8.22749 35.2581Z"/>
      </svg>`;
      clearBtn.tabIndex = 0;
      clearBtn.setAttribute('aria-label', `Remove ${tab.title || tab.url} from session`);
      clearBtn.addEventListener('click', (ev) => {
        if (wasDraggingLink) {
          ev.preventDefault();
          return;
        }
        if (session.isSmartGroup) {
          doPendingDeleteTabFromSmartGroup(session.id, tab.url, tabIndex);
        } else {
          doPendingDeleteTab(session.timestamp, tab.url, tabIndex);
        }
      });
      rightSide.appendChild(clearBtn);

      if (session.locked) {
        clearBtn.style.display = 'none';
      }

      rowDiv.appendChild(linkArea);
      rowDiv.appendChild(rightSide);
      li.appendChild(rowDiv);
      ul.appendChild(li);
    });

    card.appendChild(ul);
    wrapper.appendChild(header);
    wrapper.appendChild(card);

  // Note: Menu closing on wrapper mouseleave removed to make interaction less finicky
  // Menus now only close via button/menu mouseleave timeout or outside click

  container.appendChild(wrapper);
  wireRowHover();
  });

  // Initialize search functionality after sessions are loaded
  initializeSearch();

  // Update dynamic menu button text
  updateCollapseExpandAllButtonText();
  updateLockUnlockAllButtonText();

  // Wire up the actions menu
  wireActionsMenu();

  // Finish session list setup (trash nav, search, fullscreen restore)
  finishRenderSessionList(sessions);
}

// Separate function to wire up the actions menu (called from renderSessionList and welcome screen)
function wireActionsMenu() {
  // View mode toggle button
  const fullScreenModeBtn = document.getElementById('fullScreenModeBtn');
  if (fullScreenModeBtn && !fullScreenModeBtn.dataset.bound) {
    fullScreenModeBtn.dataset.bound = 'true';
    fullScreenModeBtn.addEventListener('click', () => {
      if (fullScreenModeBtn.classList.contains('disabled')) return;
      debug('Advanced Mode button clicked, calling toggleViewMode()');
      toggleViewMode();
      closeActionsMenu();
    });
  }

  // View mode toggle button in header
  const viewModeToggleBtn = document.getElementById('viewModeToggleBtn');
  if (viewModeToggleBtn && !viewModeToggleBtn.dataset.bound) {
    viewModeToggleBtn.dataset.bound = 'true';

    viewModeToggleBtn.addEventListener('click', () => {
      if (viewModeToggleBtn.classList.contains('disabled')) return;
      debug('View Mode Toggle button clicked, calling toggleViewMode()');
      // Add locked class to maintain the preview icon while still hovering
      viewModeToggleBtn.classList.add('view-mode-locked');
      toggleViewMode();
    });

    // Remove locked class when mouse leaves to restore normal hover behavior
    viewModeToggleBtn.addEventListener('mouseleave', () => {
      viewModeToggleBtn.classList.remove('view-mode-locked');
    });
  }

  const actionsMenuBtn = document.getElementById('actionsMenuBtn');
  const actionsMenu = document.getElementById('actionsMenu');
  const newTabGroupBtn = document.getElementById('newTabGroupBtn');
  const pasteLinksBtn = document.getElementById('pasteLinksBtn');
  const collapseExpandAllBtn = document.getElementById('collapseExpandAllBtn');
  const lockUnlockAllBtn = document.getElementById('lockUnlockAllBtn');
  const sortSessionsBtn = document.getElementById('sortSessionsBtn');

  if (actionsMenuBtn && !actionsMenuBtn.dataset.bound) {
    actionsMenuBtn.dataset.bound = 'true';

    let actionsMenuHideTimeout;

    // Toggle menu on button click
    actionsMenuBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const isExpanded = actionsMenuBtn.getAttribute('aria-expanded') === 'true';
      if (isExpanded) {
        closeActionsMenu();
      } else {
        openActionsMenu();
      }
    });

    // Keep menu open when hovering over button (if already open)
    actionsMenuBtn.addEventListener('mouseenter', () => {
      clearTimeout(actionsMenuHideTimeout);
    });

    // Close menu when mouse leaves button
    actionsMenuBtn.addEventListener('mouseleave', () => {
      const isExpanded = actionsMenuBtn.getAttribute('aria-expanded') === 'true';
      if (isExpanded) {
        actionsMenuHideTimeout = setTimeout(() => {
          closeActionsMenu();
        }, 600);
      }
    });

    // Keep menu open when hovering over it
    if (actionsMenu) {
      actionsMenu.addEventListener('mouseenter', () => {
        clearTimeout(actionsMenuHideTimeout);
      });

      actionsMenu.addEventListener('mouseleave', () => {
        actionsMenuHideTimeout = setTimeout(() => {
          closeActionsMenu();
        }, 600);
      });
    }

    // Close menu when pressing ESC key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' || e.key === 'Esc') {
        const isMenuOpen = actionsMenuBtn.getAttribute('aria-expanded') === 'true';
        if (isMenuOpen) {
          e.preventDefault();
          closeActionsMenu();
        }
      }
    });

    // New Tab Group action
    if (newTabGroupBtn) {
      newTabGroupBtn.addEventListener('click', (e) => {
        e.preventDefault();
        closeActionsMenu();
        createEmptySession();
      });
    }

    // Paste Links action
    if (pasteLinksBtn) {
      pasteLinksBtn.addEventListener('click', (e) => {
        e.preventDefault();
        // IMPORTANT: Execute paste BEFORE closing menu to preserve user interaction context
        handlePasteLinksAction();
        closeActionsMenu();
      });
    }

    // Collapse/Expand All action
    if (collapseExpandAllBtn) {
      collapseExpandAllBtn.addEventListener('click', (e) => {
        e.preventDefault();
        closeActionsMenu();
        handleCollapseExpandAllAction();
      });
    }

    // Lock/Unlock All action
    if (lockUnlockAllBtn) {
      lockUnlockAllBtn.addEventListener('click', (e) => {
        e.preventDefault();
        closeActionsMenu();
        handleLockUnlockAllAction();
      });
    }

    // Sort submenu handling
    const sortWrapper = sortSessionsBtn?.closest('.actions-menu-item-wrapper');
    const sortSubmenu = sortWrapper?.querySelector('.actions-submenu');
    if (sortSessionsBtn && sortWrapper && sortSubmenu) {
      let sortHideTimeout;

      // Show/hide submenu on hover
      sortWrapper.addEventListener('mouseenter', () => {
        clearTimeout(sortHideTimeout);
        sortSubmenu.classList.add('show');
        positionSubmenu(sortSubmenu);
        sortSessionsBtn.setAttribute('aria-expanded', 'true');
      });

      sortWrapper.addEventListener('mouseleave', () => {
        sortHideTimeout = setTimeout(() => {
          sortSubmenu.classList.remove('show');
          sortSessionsBtn.setAttribute('aria-expanded', 'false');
        }, 400);
      });

      // Handle submenu item clicks
      const sortItems = sortSubmenu.querySelectorAll('.actions-submenu-item');
      sortItems.forEach(item => {
        item.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const direction = item.getAttribute('data-sort-direction');
          closeActionsMenu();
          handleSortSessionsAction(direction);
        });
      });
    }

    // Copy submenu handling
    const copyBtn = document.getElementById('copyBtn');
    const copyWrapper = copyBtn?.closest('.actions-menu-item-wrapper');
    const copySubmenu = copyWrapper?.querySelector('.actions-submenu');
    debug('[Actions Menu] Copy button found:', !!copyBtn, 'Wrapper found:', !!copyWrapper, 'Submenu found:', !!copySubmenu);
    if (copyBtn && copyWrapper && copySubmenu) {
      let copyHideTimeout;

      // Show/hide submenu on hover
      copyWrapper.addEventListener('mouseenter', () => {
        clearTimeout(copyHideTimeout);
        copySubmenu.classList.add('show');
        positionSubmenu(copySubmenu);
        copyBtn.setAttribute('aria-expanded', 'true');
      });

      copyWrapper.addEventListener('mouseleave', () => {
        copyHideTimeout = setTimeout(() => {
          copySubmenu.classList.remove('show');
          copyBtn.setAttribute('aria-expanded', 'false');
        }, 400);
      });

      // Handle copy format selection
      const copyFormatBtns = copySubmenu.querySelectorAll('.actions-submenu-item');
      copyFormatBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const format = btn.dataset.copyFormat;
          closeActionsMenu();
          copySubmenu.classList.remove('show');
          copyBtn.setAttribute('aria-expanded', 'false');
          handleCopy(format);
        });
      });
    }

    // Trash Duplicates action
    const trashDuplicatesBtn = document.getElementById('trashDuplicatesBtn');
    if (trashDuplicatesBtn) {
      trashDuplicatesBtn.addEventListener('click', (e) => {
        e.preventDefault();

        // Don't execute if disabled
        if (trashDuplicatesBtn.classList.contains('disabled')) {
          return;
        }

        closeActionsMenu();
        handleTrashDuplicatesAction();
      });
    }

    // Reset Group Colors action
    const resetGroupColorsBtn = document.getElementById('toolbar-reset-colors-btn');
    if (resetGroupColorsBtn) {
      resetGroupColorsBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();

        if (resetGroupColorsBtn.disabled) {
          return;
        }

        // Also close actions menu if in regular mode
        closeActionsMenu();

        handleResetGroupColors();
      });
    }

    // Export submenu handling
    const exportBtn = document.getElementById('exportBtn');
    const exportWrapper = exportBtn?.closest('.actions-menu-item-wrapper');
    const exportSubmenu = exportWrapper?.querySelector('.actions-submenu');
    debug('[Actions Menu] Export button found:', !!exportBtn, 'Wrapper found:', !!exportWrapper, 'Submenu found:', !!exportSubmenu);
    if (exportBtn && exportWrapper && exportSubmenu) {
      let exportHideTimeout;

      // Show/hide submenu on hover
      exportWrapper.addEventListener('mouseenter', () => {
        clearTimeout(exportHideTimeout);
        exportSubmenu.classList.add('show');
        positionSubmenu(exportSubmenu);
        exportBtn.setAttribute('aria-expanded', 'true');
      });

      exportWrapper.addEventListener('mouseleave', () => {
        exportHideTimeout = setTimeout(() => {
          exportSubmenu.classList.remove('show');
          exportBtn.setAttribute('aria-expanded', 'false');
        }, 400);
      });

      // Handle export format selection
      const exportFormatBtns = exportSubmenu.querySelectorAll('.actions-submenu-item');
      debug('[EXPORT] Found', exportFormatBtns.length, 'export format buttons');
      exportFormatBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
          debug('[EXPORT] Export button clicked, format:', btn.dataset.exportFormat);
          e.preventDefault();
          e.stopPropagation();
          const format = btn.dataset.exportFormat;
          exportSubmenu.classList.remove('show');
          exportBtn.setAttribute('aria-expanded', 'false');
          debug('[EXPORT] Calling handleExport with format:', format);
          // IMPORTANT: Call handleExport and pass callback to close menu AFTER download
          handleExport(format, () => {
            closeActionsMenu();
          });
        });
      });
    }

    // Templates submenu handling
    const templatesBtn = document.getElementById('templatesBtn');
    const templatesWrapper = templatesBtn?.closest('.actions-menu-item-wrapper');
    const templatesSubmenu = templatesWrapper?.querySelector('.actions-submenu');
    debug('[Actions Menu] Templates button found:', !!templatesBtn, 'Wrapper found:', !!templatesWrapper, 'Submenu found:', !!templatesSubmenu);
    if (templatesBtn && templatesWrapper && templatesSubmenu) {
      let templatesHideTimeout;

      // Populate templates submenu once on initialization
      populateTemplatesSubmenu();
      updateTemplatesButtonState();
      updateSmartGroupsButtonState();
      updateFullScreenModeButtonState();
      updateCompactOnlyButtonsState();

      // Show/hide submenu on hover
      templatesWrapper.addEventListener('mouseenter', () => {
        // Don't show submenu if button is disabled
        if (templatesBtn.classList.contains('disabled')) {
          return;
        }
        clearTimeout(templatesHideTimeout);
        templatesSubmenu.classList.add('show');
        positionSubmenu(templatesSubmenu);
        templatesBtn.setAttribute('aria-expanded', 'true');
      });

      templatesWrapper.addEventListener('mouseleave', () => {
        templatesHideTimeout = setTimeout(() => {
          templatesSubmenu.classList.remove('show');
          templatesBtn.setAttribute('aria-expanded', 'false');
        }, 150);
      });
    }

    // Filters submenu handling
    const smartGroupsParentBtn = document.getElementById('smartGroupsParentBtn');
    const filtersWrapper = smartGroupsParentBtn?.closest('.actions-menu-item-wrapper');
    const filtersSubmenu = document.getElementById('filtersSubmenu');
    if (smartGroupsParentBtn && filtersWrapper && filtersSubmenu) {
      let filtersHideTimeout;

      // Show/hide submenu on hover
      filtersWrapper.addEventListener('mouseenter', () => {
        // Don't show submenu if button is disabled
        if (smartGroupsParentBtn.classList.contains('disabled')) {
          return;
        }
        clearTimeout(filtersHideTimeout);
        filtersSubmenu.classList.add('show');
        positionSubmenu(filtersSubmenu);
        smartGroupsParentBtn.setAttribute('aria-expanded', 'true');
      });

      filtersWrapper.addEventListener('mouseleave', () => {
        filtersHideTimeout = setTimeout(() => {
          filtersSubmenu.classList.remove('show');
          smartGroupsParentBtn.setAttribute('aria-expanded', 'false');
        }, 150);
      });
    }

    // Import button handling
    const importBtn = document.getElementById('importBtn');
    const importFileInput = document.getElementById('importFileInput');
    debug('[Actions Menu] Import button found:', !!importBtn, 'File input found:', !!importFileInput);
    debug('[IMPORT] Import button found:', !!importBtn, 'File input found:', !!importFileInput);
    if (importBtn && importFileInput) {
      importBtn.addEventListener('click', (e) => {
        debug('[IMPORT] Import button clicked');
        e.preventDefault();
        // IMPORTANT: Trigger file input BEFORE closing menu to avoid click freeze
        importFileInput.click();
        closeActionsMenu();
      });

      importFileInput.addEventListener('change', (e) => {
        debug('[IMPORT] File selected:', e.target.files[0]?.name);
        handleImportFile(e.target.files[0]);
        // Reset input so same file can be imported again
        importFileInput.value = '';
      });
    }

  }
}

// Continuation of session list setup (called after wireActionsMenu in renderSessionList)
function finishRenderSessionList(sessions) {
  // Wire up the trash nav button (idempotent)
  wireTrashNav();
  
  // If search was active, re-apply the search results
  if (isSearchActive) {
    const searchInput = document.getElementById('searchInput');
    if (searchInput && searchInput.value.trim()) {
      const query = searchInput.value.trim().toLowerCase();
      const results = searchTabs(query);

      // If no results remain, clear the search entirely
      if (results.length === 0) {
        clearSearch();
      } else {
        displaySearchResults(results, query);
      }
    }
  }

  // If we're supposed to be in fullscreen mode, enter it now (without animation on page load)
  debug(`[VIEW MODE RESTORE] 🔍 Check: viewMode="${viewMode}", sessions.length=${sessions.length}, isRestoringViewMode=${isRestoringViewMode}`);

  if (viewMode === "fullscreen" && sessions.length > 0) {
    debug(`[VIEW MODE RESTORE] ✓ Entering fullscreen mode! body[data-view-mode]="${document.body?.getAttribute('data-view-mode')}"`);

    // Ensure body has the correct attribute
    if (document.body) {
      document.body.setAttribute("data-view-mode", "fullscreen");
      debug('[VIEW MODE RESTORE] ✓ Set body[data-view-mode="fullscreen"]');
    } else {
      debug('[VIEW MODE RESTORE] document.body is NULL!');
    }

    // Initialize collapsed sessions state before transforming
    initializeCollapsedSessions(() => {
      debug(`[VIEW MODE RESTORE] 📊 Transforming ${savedSessions.length} sessions to tabs...`);
      // Transform session data to flat tab list
      fullscreenData.allTabs = transformSessionsToTabs(savedSessions);
      fullscreenData.filteredTabs = [...fullscreenData.allTabs];
      debug(`[VIEW MODE RESTORE] ✓ Transformed to ${fullscreenData.allTabs.length} tabs`);

      // Populate filter dropdowns
      populateFilterDropdowns(fullscreenData.allTabs);
      updateSessionLevelFilters();
      debug('[VIEW MODE RESTORE] ✓ Populated filter dropdowns');

      // Render the fullscreen table
      debug('[VIEW MODE RESTORE] 🎨 Calling renderFullScreenTable()...');
      renderFullScreenTable(fullscreenData.filteredTabs);
      debug('[VIEW MODE RESTORE] ✓ renderFullScreenTable() completed');

      // Set up event listeners
      setupFullScreenEventListeners();
      debug('[VIEW MODE RESTORE] ✓ Set up event listeners');

      // Update button state to show "Simple Mode"
      updateFullScreenModeButtonState();
      updateCompactOnlyButtonsState();

      // Clear the restoration flag after first render
      isRestoringViewMode = false;
      debug('[VIEW MODE RESTORE] ✅ Fullscreen mode rendered successfully, cleared isRestoringViewMode flag');

      // Re-enable transitions after initial render
      requestAnimationFrame(() => {
        document.body.classList.remove('no-transitions');
        debug('[VIEW MODE RESTORE] ✓ Re-enabled transitions');
      });
    });
  } else {
    debug(`[VIEW MODE RESTORE] ⏭️ NOT entering fullscreen mode: viewMode="${viewMode}", sessions.length=${sessions.length}`);

    // Re-enable transitions even if not in fullscreen mode
    requestAnimationFrame(() => {
      document.body.classList.remove('no-transitions');
    });
  }
}

// Create a new empty session with default title (computed from timestamp)
function createEmptySession() {
  chrome.storage.local.get(["savedSessions"], (result) => {
    let sessions = result.savedSessions || [];
    const ts = new Date().toISOString();
    const newSession = {
      timestamp: ts,
      tabs: []
    };
    sessions.unshift(newSession);
    savedSessions = sessions;
    chrome.storage.local.set({ savedSessions: sessions }, () => {
      updateSessionList(sessions);
      // Animate the newly added session
      setTimeout(() => highlightAddSession(ts), 50);
    });
  });
}

function highlightAddSession(timestamp) {
  const wrapper = document.querySelector(`.session-wrapper[data-timestamp="${timestamp}"]`);
  if (!wrapper) return;
  wrapper.classList.add('scale-add');
  wrapper.classList.add('flash-change');
  setTimeout(() => {
    wrapper.classList.remove('scale-add');
    wrapper.classList.remove('flash-change');
  }, 300);
}

function markTitleGenerationInProgress(timestamp, attempt = 0) {
  if (!timestamp) return;
  const wrappers = document.querySelectorAll(`.session-wrapper[data-timestamp="${timestamp}"]`);
  if (!wrappers || wrappers.length === 0) {
    if (attempt < MAX_AI_TITLE_WORK_ATTEMPTS) {
      setTimeout(() => markTitleGenerationInProgress(timestamp, attempt + 1), 120);
    }
    return;
  }

  wrappers.forEach(wrapper => {
    const titleEl = wrapper.querySelector('.session-title-text, .session-title');
    if (titleEl) {
      titleEl.classList.remove('ai-title-update');
      titleEl.classList.add('ai-title-working');
    }
    const inputEl = wrapper.querySelector('.session-title-input');
    if (inputEl) {
      inputEl.classList.add('ai-title-working');
    }
    wrapper.dataset.pendingTitle = "true";
    const regenBtn = wrapper.querySelector('.ai-regenerate-btn');
    if (regenBtn) {
      regenBtn.classList.add('working');
    }
  });

  const sessionIdx = savedSessions.findIndex(s => s.timestamp === timestamp);
  if (sessionIdx !== -1) {
    savedSessions[sessionIdx].pendingTitle = true;
    savedSessions[sessionIdx].pendingTitleStartedAt = Date.now();
  }
}

/** ===========================
    MERGE => "Undo" approach
=========================== */
function doPendingMergeSmartGroup(sourceSmartGroupId, targetItem) {
  // Merge a Smart Group into the item below it (could be another Smart Group or a session)
  chrome.storage.local.get(['smartGroups', 'savedSessions'], (result) => {
    const smartGroups = result.smartGroups || [];
    const savedSessions = result.savedSessions || [];

    const sourceGroup = smartGroups.find(g => g.id === sourceSmartGroupId);
    if (!sourceGroup || !targetItem) return;

    const sourceTabs = [...(sourceGroup.tabs || [])];
    const sourceIdentifier = sourceGroup.timestamp || sourceGroup.id;

    if (targetItem.isSmartGroup) {
      // Merging into another Smart Group
      const targetGroup = smartGroups.find(g => g.id === targetItem.id);
      if (!targetGroup) return;

      targetGroup.tabs = sourceTabs.concat(targetGroup.tabs || []);
      sourceGroup.tabs = []; // Clear source Smart Group

      chrome.storage.local.set({ smartGroups }, () => {
        updateSessionList(savedSessions);
        highlightMergeSession(targetGroup.timestamp || targetGroup.id);
        refreshBadge();
      });

      const opId = "mergeSmartGroup-" + Math.random().toString(36).substr(2, 8);
      pendingOperations[opId] = {
        type: "mergeSmartGroup",
        sourceSmartGroupId: sourceSmartGroupId,
        targetSmartGroupId: targetGroup.id,
        sourceTabs: sourceTabs,
        wasCollapsed: !!collapsedSessions[sourceIdentifier]
      };

      const groupName = sourceGroup.name || "Smart Group";
      showUndoBubble(opId, groupName, '', { type: 'merge' });
      const timerId = setTimeout(() => {
        finalizePendingOperation(opId);
      }, UNDO_TIMEOUT_MS);
      pendingOperations[opId].timerId = timerId;

    } else {
      // Merging into a regular session
      const targetSession = savedSessions.find(s => s.timestamp === targetItem.timestamp);
      if (!targetSession) return;

      targetSession.tabs = sourceTabs.concat(targetSession.tabs);
      sourceGroup.tabs = []; // Clear source Smart Group

      chrome.storage.local.set({ smartGroups, savedSessions }, () => {
        updateSessionList(savedSessions);
        highlightMergeSession(targetSession.timestamp);
        refreshBadge();
      });

      const opId = "mergeSmartGroupToSession-" + Math.random().toString(36).substr(2, 8);
      pendingOperations[opId] = {
        type: "mergeSmartGroupToSession",
        sourceSmartGroupId: sourceSmartGroupId,
        targetSessionTimestamp: targetSession.timestamp,
        sourceTabs: sourceTabs,
        wasCollapsed: !!collapsedSessions[sourceIdentifier]
      };

      const groupName = sourceGroup.name || "Smart Group";
      showUndoBubble(opId, groupName, '', { type: 'merge' });
      const timerId = setTimeout(() => {
        finalizePendingOperation(opId);
      }, UNDO_TIMEOUT_MS);
      pendingOperations[opId].timerId = timerId;
    }
  });
}

function doPendingMerge(sourceTimestamp, targetTimestamp) {
  const sourceIndex = savedSessions.findIndex(s => s.timestamp === sourceTimestamp);
  const targetIndex = savedSessions.findIndex(s => s.timestamp === targetTimestamp);
  if (sourceIndex === -1 || targetIndex === -1) return;

  // Animate source sliding out, then perform the actual merge
  const sourceWrapper = document.querySelector(`.session-wrapper[data-timestamp="${sourceTimestamp}"]`);

  let merged = false;
  const doMerge = () => {
    if (merged) return; // Guard against double-invocation
    merged = true;

    const source = savedSessions[sourceIndex];
    const target = savedSessions[targetIndex];
    const sourceTabs = [...source.tabs];
    target.tabs = sourceTabs.concat(target.tabs);
    // Remove the merged (source) session
    savedSessions.splice(sourceIndex, 1);
    chrome.storage.local.set({ savedSessions }, () => {
      if (chrome.runtime.lastError) {
        debug('Error saving after merge:', chrome.runtime.lastError);
        return;
      }
      updateSessionList(savedSessions);
      highlightMergeSession(target.timestamp);
      refreshBadge();
      // Trigger review prompt evaluation after positive action
      setTimeout(() => evaluateReviewPrompt('merge_session'), 2000);
    });
    const opId = "merge-" + Math.random().toString(36).substr(2, 8);
      pendingOperations[opId] = {
        type: "merge",
        sourceSession: source,
        targetSessionTimestamp: target.timestamp,
        wasCollapsed: !!collapsedSessions[source.timestamp]
      };
    const dateStr = new Date(source.timestamp).toLocaleString(undefined, {
      weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: 'numeric'
    });
    const sessionTitle = source.customName || dateStr;
    showUndoBubble(opId, sessionTitle, dateStr, { type: 'merge' });
    const timerId = setTimeout(() => {
      finalizePendingOperation(opId);
    }, UNDO_TIMEOUT_MS);
    pendingOperations[opId].timerId = timerId;
  };

  if (sourceWrapper) {
    // Lock current height, then trigger slide-out transition
    sourceWrapper.style.height = sourceWrapper.offsetHeight + 'px';
    sourceWrapper.style.overflow = 'hidden';
    sourceWrapper.offsetHeight; // Force reflow
    sourceWrapper.classList.add('merge-slide-out');

    const onEnd = (e) => {
      if (e.propertyName !== 'height') return;
      sourceWrapper.removeEventListener('transitionend', onEnd);
      doMerge();
    };
    sourceWrapper.addEventListener('transitionend', onEnd);
    // Fallback in case transitionend doesn't fire (e.g. reduced motion)
    setTimeout(doMerge, 200);
  } else {
    doMerge();
  }
}

/** ===========================
    DELETE => "Undo" approach for sessions (delete via session-level delete button)
=========================== */
function doPendingDeleteSmartGroup(smartGroupId) {
  // For Smart Groups, we clear the tabs but keep the group definition
  chrome.storage.local.get(['smartGroups', 'trashedLinks'], (result) => {
    const smartGroups = result.smartGroups || [];
    const group = smartGroups.find(g => g.id === smartGroupId);

    if (!group) return;

    // Add delete animation (must match data-timestamp order: timestamp || id)
    highlightDeleteSession(group.timestamp || group.id);

    const groupName = group.name || "Unnamed Smart Group";
    let trashedLinks = result.trashedLinks || [];

    // Store original tabs for undo
    const originalTabs = [...(group.tabs || [])];

    if (group.tabs && group.tabs.length > 0) {
      const now = Date.now();
      const retentionMs = 30 * 24 * 60 * 60 * 1000; // 30 days

      // Move tabs to trash
      group.tabs.forEach(tab => {
        const trashItem = {
          id: generateDeleteId(),
          url: tab.url,
          title: tab.title,
          originalSessionName: groupName,
          sessionTimestamp: group.timestamp || group.id,
          trashedAt: now,
          expiresAt: now + retentionMs
        };
        const parsed = Date.parse(group.timestamp);
        if (!isNaN(parsed)) trashItem.originalSavedAt = parsed;
        trashedLinks.push(trashItem);
      });
    }

    // Clear the tabs array but keep the group
    group.tabs = [];

    // Save changes after animation
    setTimeout(() => {
      chrome.storage.local.set({ smartGroups, trashedLinks }, () => {
        // Reload to hide the now-empty Smart Group
        chrome.storage.local.get(['savedSessions'], (result) => {
          updateSessionList(result.savedSessions || []);
          refreshBadge();
        });
      });
    }, 160);

    // Create undo operation
    const opId = "deleteSmartGroup-" + Math.random().toString(36).substr(2, 8);
    pendingOperations[opId] = {
      type: "deleteSmartGroup",
      smartGroupId: smartGroupId,
      originalTabs: originalTabs,
      wasCollapsed: !!collapsedSessions[group.id || group.timestamp]
    };

    const dateStr = group.timestamp ? new Date(group.timestamp).toLocaleString(undefined, {
      weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: 'numeric'
    }) : '';
    showUndoBubble(opId, groupName, dateStr, { type: 'delete' });
    const timerId = setTimeout(() => {
      finalizePendingOperation(opId);
    }, UNDO_TIMEOUT_MS);
    pendingOperations[opId].timerId = timerId;
  });
}

function doPendingDeleteSession(timestamp) {
  const sessionIndex = savedSessions.findIndex(s => s.timestamp === timestamp);
  if (sessionIndex === -1) return;
  const session = savedSessions[sessionIndex];

  // Add delete animation before removing
  highlightDeleteSession(session.timestamp);

  // Cancel any pending merge operations that involve this session.
  for (const opId in pendingOperations) {
    const op = pendingOperations[opId];
    if (op.type === 'merge') {
      if (op.sourceSession.timestamp === session.timestamp ||
          op.targetSessionTimestamp === session.timestamp) {
        clearTimeout(op.timerId);
        removeUndoBubble(opId);
        delete pendingOperations[opId];
      }
    }
  }

  // CLIENT-SIDE TRASH: Move tabs to trash directly using storage, bypassing unreliable background.js
  const sessionName = session.customName || session.defaultTitle || "Untitled Session";

  if (session.tabs && session.tabs.length > 0) {
    // Get current trash data and add all session tabs
    chrome.storage.local.get(["trashedLinks"], (result) => {
      let trashedLinks = result.trashedLinks || [];

      const now = Date.now();
      const retentionMs = 30 * 24 * 60 * 60 * 1000; // 30 days
      session.tabs.forEach(tab => {
        const trashItem = {
          id: generateDeleteId(),
          url: tab.url,
          title: tab.title,
          originalSessionName: sessionName,
          sessionTimestamp: session.timestamp,
          trashedAt: now,
          expiresAt: now + retentionMs
        };
        // Record original saved time from the session timestamp if present
        const parsed = Date.parse(session.timestamp);
        if (!isNaN(parsed)) trashItem.originalSavedAt = parsed;
        trashedLinks.push(trashItem);
      });

      // First persist trash changes immediately
      chrome.storage.local.set({ trashedLinks }, () => {
        // Then, after the delete animation, remove the session and update UI
        setTimeout(() => {
          savedSessions.splice(sessionIndex, 1);
          isUpdatingFromStorage = true;
          chrome.storage.local.set({ savedSessions }, () => {
            updateSessionList(savedSessions);
            refreshBadge();
            setTimeout(() => { isUpdatingFromStorage = false; }, 100);
          });
        }, 160); // allow faster CSS animation (.scale-delete) to be visible
      });
    });
  } else {
    // No tabs to trash, just remove the session after animation delay
    setTimeout(() => {
      savedSessions.splice(sessionIndex, 1);
      isUpdatingFromStorage = true;
      chrome.storage.local.set({ savedSessions }, () => {
        updateSessionList(savedSessions);
        refreshBadge();
        setTimeout(() => { isUpdatingFromStorage = false; }, 100);
      });
    }, 160);
  }

  // Let background.js handle the actual session deletion after moving tabs to trash
  // No need to delete the session here as it creates a race condition
  const opId = "delete-" + Math.random().toString(36).substr(2, 8);
    pendingOperations[opId] = {
      type: "delete",
      sessionData: session,
      wasCollapsed: !!collapsedSessions[session.timestamp]   // NEW
    };
  const dateStr = new Date(session.timestamp).toLocaleString(undefined, {
    weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: 'numeric'
  });
  const sessionTitle = session.customName || dateStr;
  showUndoBubble(opId, sessionTitle, dateStr, { type: 'delete' });
  const timerId = setTimeout(() => {
    finalizePendingOperation(opId);
  }, UNDO_TIMEOUT_MS);
  pendingOperations[opId].timerId = timerId;
}

/** ===========================
    DELETE => "Undo" approach for individual link deletion (clear button)
=========================== */
function doPendingDeleteTabFromSmartGroup(smartGroupId, tabUrl, providedTabIndex) {
  chrome.storage.local.get(['smartGroups', 'trashedLinks', 'savedSessions'], (result) => {
    const smartGroups = result.smartGroups || [];
    const group = smartGroups.find(g => g.id === smartGroupId);
    if (!group) return;

    let tabIndex;
    if (typeof providedTabIndex === 'number' &&
        providedTabIndex >= 0 &&
        providedTabIndex < group.tabs.length) {
      tabIndex = providedTabIndex;
    } else {
      tabIndex = group.tabs.findIndex(t => t.url === tabUrl);
    }
    if (tabIndex === -1) return;

    const deletedLink = group.tabs[tabIndex];
    const groupName = group.name || "Unnamed Smart Group";
    const sanitizedDeletedLink = {
      ...deletedLink,
      title: decodeHtmlEntities(deletedLink.title || '')
    };

    // Move tab to trash
    chrome.runtime.sendMessage({
      action: "moveTabToTrash",
      tab: sanitizedDeletedLink,
      sessionName: groupName,
      sessionTimestamp: group.timestamp || group.id
    });

    // Remove tab from Smart Group
    group.tabs.splice(tabIndex, 1);

    if (group.tabs.length === 0) {
      // Group is now empty - will be hidden from list on next render
      setTimeout(() => {
        isUpdatingFromStorage = true;
        chrome.storage.local.set({ smartGroups }, () => {
          const savedSessions = result.savedSessions || [];
          updateSessionList(savedSessions);
          refreshBadge();
          setTimeout(() => { isUpdatingFromStorage = false; }, 100);
        });
      }, 220);

      const opId = "deleteTabFromSmartGroup-" + Math.random().toString(36).substr(2, 8);
      pendingOperations[opId] = {
        type: "deleteTabFromSmartGroup",
        smartGroupId: smartGroupId,
        tabIndex,
        deletedLink
      };

      const linkTitle = deletedLink.title || "";
      showUndoBubble(opId, linkTitle, "", { type: 'deleteLink', linkUrl: deletedLink.url });
      const timerId = setTimeout(() => {
        finalizePendingOperation(opId);
      }, UNDO_TIMEOUT_MS);
      pendingOperations[opId].timerId = timerId;
    } else {
      // Smart Group still has tabs
      isUpdatingFromStorage = true;
      chrome.storage.local.set({ smartGroups }, () => {
        const savedSessions = result.savedSessions || [];
        updateSessionList(savedSessions);
        refreshBadge();
        setTimeout(() => { isUpdatingFromStorage = false; }, 100);
      });

      const opId = "deleteTabFromSmartGroup-" + Math.random().toString(36).substr(2, 8);
      pendingOperations[opId] = {
        type: "deleteTabFromSmartGroup",
        smartGroupId: smartGroupId,
        tabIndex,
        deletedLink
      };

      const linkTitle = deletedLink.title || "";
      showUndoBubble(opId, linkTitle, "", { type: 'deleteLink', linkUrl: deletedLink.url });
      const timerId = setTimeout(() => {
        finalizePendingOperation(opId);
      }, UNDO_TIMEOUT_MS);
      pendingOperations[opId].timerId = timerId;
    }
  });
}

function doPendingDeleteTab(sessionTimestamp, tabUrl, providedTabIndex) {
  const sessionIndex = savedSessions.findIndex(s => s.timestamp === sessionTimestamp);
  if (sessionIndex === -1) return;
  const session = savedSessions[sessionIndex];
    // Use providedTabIndex if valid, otherwise fall back
    let tabIndex;
      if (typeof providedTabIndex === 'number' &&
          providedTabIndex >= 0 &&
          providedTabIndex < session.tabs.length) {
        tabIndex = providedTabIndex;
      } else {
        tabIndex = session.tabs.findIndex(t => t.url === tabUrl);
      }
  if (tabIndex === -1) return;
  const deletedLink = session.tabs[tabIndex];

  // NEW: Immediately move tab to trash BEFORE removing from session
  const sessionName = session.customName || session.defaultTitle || "Untitled Session";
  const sanitizedDeletedLink = {
    ...deletedLink,
    title: decodeHtmlEntities(deletedLink.title || '')
  };

  chrome.runtime.sendMessage({
    action: "moveTabToTrash",
    tab: sanitizedDeletedLink,
    sessionName: sessionName,
    sessionTimestamp: session.timestamp
  });

  session.tabs.splice(tabIndex, 1);

  if (session.tabs.length === 0) {
    // Animate session removal
    highlightDeleteSession(session.timestamp);
    const opId = "deleteEmptySession-" + Math.random().toString(36).substr(2, 8);
    const sessionCopy = Object.assign({}, session);
    sessionCopy.tabs = [deletedLink];
    // Delay actual removal to allow animation to play
    setTimeout(() => {
      savedSessions.splice(sessionIndex, 1);
      isUpdatingFromStorage = true;
      chrome.storage.local.set({ savedSessions }, () => {
        updateSessionList(savedSessions);
        refreshBadge();
        setTimeout(() => { isUpdatingFromStorage = false; }, 100);
      });
    }, 220);
    pendingOperations[opId] = {
      type: "deleteEmptySession",
      sessionData: sessionCopy,
    };
      
      const linkTitle = deletedLink.title || "";
      showUndoBubble(opId, linkTitle, "", { type: 'deleteLink', linkUrl: deletedLink.url });
    const timerId = setTimeout(() => {
      finalizePendingOperation(opId);
    }, UNDO_TIMEOUT_MS);
    pendingOperations[opId].timerId = timerId;
  } else {
    isUpdatingFromStorage = true;
    chrome.storage.local.set({ savedSessions }, () => {
      updateSessionList(savedSessions);
      refreshBadge();
      setTimeout(() => { isUpdatingFromStorage = false; }, 100);
    });
    const opId = "deleteLink-" + Math.random().toString(36).substr(2, 8);
    pendingOperations[opId] = {
      type: "deleteLink",
      sessionTimestamp: session.timestamp,
      tabIndex,
      deletedLink
    };
    const linkTitle = deletedLink.title || "";
    showUndoBubble(opId, linkTitle, "", { type: 'deleteLink', linkUrl: deletedLink.url });
    const timerId = setTimeout(() => {
      finalizePendingOperation(opId);
    }, UNDO_TIMEOUT_MS);
    pendingOperations[opId].timerId = timerId;
  }
}


/** Show an undo bubble using CSS classes.
 */
function showUndoBubble(opId, titleText, dateStr, options = {}) {
  debug('[showUndoBubble] Called with opId:', opId, 'title:', titleText, 'currentView:', currentView);

  // If user is in trash view, do not show undo UI.
  // Immediately finalize to avoid conflicting writes while restoring from trash.
  if (currentView === 'trash') {
    debug('[showUndoBubble] In trash view, finalizing immediately');
    try { finalizePendingOperation(opId); } catch (e) { debug('Finalize failed for', opId, e); }
    return;
  }
  const bubble = document.createElement('div');
  bubble.className = 'undo-bubble';
  bubble.dataset.opid = opId;
  
  if (options.type) {
    bubble.classList.add(options.type);
  }
  
  const textSpan = document.createElement('span');
  textSpan.className = 'undo-bubble-title';
  
  if (options.type === 'deleteLink' && options.linkUrl) {
    const titleSpanInner = document.createElement('span');
    titleSpanInner.textContent = titleText;
    const urlSpan = document.createElement('span');
    urlSpan.textContent = "    " + options.linkUrl;
      urlSpan.className = 'undo-button-url';
    textSpan.appendChild(titleSpanInner);
    textSpan.appendChild(urlSpan);
  } else {
    textSpan.textContent = titleText;
  }
  
    if (dateStr) {
      const dateSpan = document.createElement('span');
      dateSpan.className = 'undo-button-date';
      dateSpan.textContent = " " + dateStr;
      textSpan.appendChild(dateSpan);
    }
  
  const undoBtn = document.createElement('button');
  undoBtn.className = 'undo-bubble-btn';
  undoBtn.textContent = getMessage("undo");
  undoBtn.setAttribute('aria-label', getMessage("undo") || 'Undo');
  bubble.addEventListener('click', (e) => {
    e.stopPropagation();
    undoOperation(opId);
  });
  
  bubble.appendChild(textSpan);
  bubble.appendChild(undoBtn);
  
  undoContainer.appendChild(bubble);
  
  requestAnimationFrame(() => {
    bubble.classList.add('show');
  });
}

/** If user clicks Undo, revert changes.
 */
function undoOperation(opId) {
  const op = pendingOperations[opId];
  if (!op) return;
  if (op.timerId) {
    clearTimeout(op.timerId);
  }
  removeUndoBubble(opId);


  if (op.type === 'deleteSmartGroup') {
    // Restore Smart Group tabs from trash
    chrome.storage.local.get(['trashedLinks', 'smartGroups', 'savedSessions'], (result) => {
      let trashedLinks = result.trashedLinks || [];
      const smartGroups = result.smartGroups || [];
      const savedSessions = result.savedSessions || [];

      const group = smartGroups.find(g => g.id === op.smartGroupId);
      if (!group) {
        delete pendingOperations[opId];
        return;
      }

      // Find and remove tabs from trash
      const groupIdentifier = group.timestamp || group.id;
      trashedLinks = trashedLinks.filter(item =>
        item.sessionTimestamp !== groupIdentifier
      );

      // Restore tabs to Smart Group
      group.tabs = op.originalTabs;

      // Restore collapsed state
      if (op.wasCollapsed) {
        collapsedSessions[groupIdentifier] = true;
      } else {
        delete collapsedSessions[groupIdentifier];
      }

      // Save everything back to storage
      chrome.storage.local.set({
        trashedLinks: trashedLinks,
        smartGroups: smartGroups,
        collapsedSessions: collapsedSessions
      }, () => {
        updateSessionList(savedSessions);
        setTimeout(() => highlightAddSession(groupIdentifier), 50);
        refreshBadge();
      });
    });
  } else if (op.type === 'delete' || op.type === 'deleteEmptySession') {
    // CLIENT-SIDE RESTORE: Restore session directly using storage, bypassing background.js

    // Remove session tabs from trash and restore the session
    chrome.storage.local.get(['trashedLinks', 'savedSessions'], (result) => {
      let trashedLinks = result.trashedLinks || [];
      let savedSessions = result.savedSessions || [];

      // Find and remove all tabs belonging to this session from trash
      const sessionTabsInTrash = trashedLinks.filter(item =>
        item.sessionTimestamp === op.sessionData.timestamp
      );

      // Remove these tabs from trash
      trashedLinks = trashedLinks.filter(item =>
        item.sessionTimestamp !== op.sessionData.timestamp
      );

      // Add the session back to savedSessions
      savedSessions.push(op.sessionData);

      // Sort sessions by timestamp (newest first)
      savedSessions.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

      // Restore collapsed state
      if (op.wasCollapsed) {
        collapsedSessions[op.sessionData.timestamp] = true;
      } else {
        delete collapsedSessions[op.sessionData.timestamp];
      }

      // Save everything back to storage
      chrome.storage.local.set({
        trashedLinks: trashedLinks,
        savedSessions: savedSessions,
        collapsedSessions: collapsedSessions
      }, () => {
        // Update the UI
        updateSessionList(savedSessions);
        // Animate the restored session popping back in
        setTimeout(() => highlightAddSession(op.sessionData.timestamp), 50);
        refreshBadge();
      });
    });
  } else if (op.type === 'bulkDelete') {
    // Restore bulk deleted tabs from trash
    chrome.storage.local.get(['trashedLinks', 'savedSessions'], (result) => {
      let trashedLinks = result.trashedLinks || [];
      savedSessions = result.savedSessions || [];

      // Group deleted tabs by their original sessions
      const tabsBySession = new Map();
      op.deletedTabs.forEach(deletedTab => {
        if (!tabsBySession.has(deletedTab.sessionIndex)) {
          tabsBySession.set(deletedTab.sessionIndex, []);
        }
        tabsBySession.get(deletedTab.sessionIndex).push(deletedTab);
      });

      // First, restore any deleted sessions (these need to be re-inserted)
      if (op.deletedSessions && op.deletedSessions.length > 0) {
        // Sort by original index in ascending order
        const sortedDeletedSessions = [...op.deletedSessions].sort((a, b) => a.index - b.index);
        sortedDeletedSessions.forEach(deletedSession => {
          // Find correct insertion position (sessions may have shifted)
          // Insert at original index or at end if index is out of bounds
          const insertIndex = Math.min(deletedSession.index, savedSessions.length);
          savedSessions.splice(insertIndex, 0, deletedSession.session);

          // Restore collapsed state
          if (deletedSession.wasCollapsed) {
            collapsedSessions[deletedSession.session.timestamp] = true;
          } else {
            delete collapsedSessions[deletedSession.session.timestamp];
          }
        });
      }

      // Now restore tabs to their sessions
      // Process in ascending order of tab indices for proper insertion
      tabsBySession.forEach((tabs, originalSessionIndex) => {
        // Find the session in the restored savedSessions array
        // If the session was deleted and restored, it should be there now
        // We need to match by timestamp, not by index (since indices may have changed)
        const firstTab = tabs[0];
        const session = savedSessions.find(s => s.timestamp === firstTab.sessionTimestamp);

        if (session) {
          // Sort tabs by their original indices in ascending order
          const sortedTabs = tabs.sort((a, b) => a.tabIndex - b.tabIndex);

          // Insert each tab at its original position
          sortedTabs.forEach(deletedTab => {
            const insertIndex = Math.min(deletedTab.tabIndex, session.tabs.length);
            session.tabs.splice(insertIndex, 0, deletedTab.tab);

            // Remove this tab from trash
            trashedLinks = trashedLinks.filter(item =>
              !(item.url === deletedTab.tab.url && item.sessionTimestamp === firstTab.sessionTimestamp)
            );
          });
        }
      });

      // Save everything back to storage
      chrome.storage.local.set({
        trashedLinks: trashedLinks,
        savedSessions: savedSessions,
        collapsedSessions: collapsedSessions
      }, () => {
        // Update the UI
        updateSessionList(savedSessions);

        // If in fullscreen mode, refresh the view
        if (document.body.classList.contains('fullscreen-mode')) {
          fullscreenData.allTabs = transformSessionsToTabs(savedSessions);
          applyFiltersAndRender();
        }

        refreshBadge();
      });

      delete pendingOperations[opId];
    });
  } else if (op.type === 'bulkMerge') {
    // Undo bulk merge from advanced mode
    chrome.storage.local.get(['savedSessions'], (result) => {
      savedSessions = result.savedSessions || [];

      debug('[undoOperation] Undoing bulk merge, newSessionTimestamp:', op.newSessionTimestamp);

      // First, remove the newly created merged session
      const newSessionIndex = savedSessions.findIndex(s => s.timestamp === op.newSessionTimestamp);
      if (newSessionIndex !== -1) {
        savedSessions.splice(newSessionIndex, 1);
        debug('[undoOperation] Removed merged session at index', newSessionIndex);
      }

      // Restore any deleted sessions (in ascending order of their original indices)
      if (op.deletedSessions && op.deletedSessions.length > 0) {
        const sortedDeletedSessions = [...op.deletedSessions].sort((a, b) => a.index - b.index);
        sortedDeletedSessions.forEach(deletedSession => {
          const insertIndex = Math.min(deletedSession.index, savedSessions.length);
          savedSessions.splice(insertIndex, 0, deletedSession.session);

          // Restore collapsed state
          if (deletedSession.wasCollapsed) {
            collapsedSessions[deletedSession.session.timestamp] = true;
          } else {
            delete collapsedSessions[deletedSession.session.timestamp];
          }
        });
        debug('[undoOperation] Restored', op.deletedSessions.length, 'deleted sessions');
      }

      // Restore tabs to their original sessions
      // Group tabs by session timestamp
      const tabsBySessionTimestamp = new Map();
      op.mergedTabs.forEach(mergedTab => {
        if (!tabsBySessionTimestamp.has(mergedTab.sessionTimestamp)) {
          tabsBySessionTimestamp.set(mergedTab.sessionTimestamp, []);
        }
        tabsBySessionTimestamp.get(mergedTab.sessionTimestamp).push(mergedTab);
      });

      // Restore tabs to each session
      tabsBySessionTimestamp.forEach((tabs, sessionTimestamp) => {
        const session = savedSessions.find(s => s.timestamp === sessionTimestamp);
        if (session) {
          // Sort tabs by their original indices in ascending order
          const sortedTabs = tabs.sort((a, b) => a.tabIndex - b.tabIndex);

          // Insert each tab at its original position
          sortedTabs.forEach(mergedTab => {
            const insertIndex = Math.min(mergedTab.tabIndex, session.tabs.length);
            session.tabs.splice(insertIndex, 0, mergedTab.tab);
          });
        }
      });

      debug('[undoOperation] Restored', op.mergedTabs.length, 'tabs to original sessions');

      // Save everything back to storage
      chrome.storage.local.set({
        savedSessions: savedSessions,
        collapsedSessions: collapsedSessions
      }, () => {
        // Update the UI
        updateSessionList(savedSessions);

        // If in fullscreen mode, refresh the view
        if (document.body.classList.contains('fullscreen-mode')) {
          fullscreenData.allTabs = transformSessionsToTabs(savedSessions);
          applyFiltersAndRender();
        }

        refreshBadge();
      });

      delete pendingOperations[opId];
    });
    } else if (op.type === 'mergeSmartGroup') {
      // Undo Smart Group merge into another Smart Group
      chrome.storage.local.get(['smartGroups', 'savedSessions'], (result) => {
        const smartGroups = result.smartGroups || [];
        const savedSessions = result.savedSessions || [];

        const sourceGroup = smartGroups.find(g => g.id === op.sourceSmartGroupId);
        const targetGroup = smartGroups.find(g => g.id === op.targetSmartGroupId);

        if (sourceGroup && targetGroup) {
          // Remove tabs from target that came from source
          const movedCount = op.sourceTabs.length;
          targetGroup.tabs = targetGroup.tabs.slice(movedCount);

          // Restore tabs to source
          sourceGroup.tabs = op.sourceTabs;

          // Restore collapsed state
          const sourceIdentifier = sourceGroup.id || sourceGroup.timestamp;
          if (op.wasCollapsed) collapsedSessions[sourceIdentifier] = true;
          else delete collapsedSessions[sourceIdentifier];

          chrome.storage.local.set({ smartGroups, collapsedSessions }, () => {
            updateSessionList(savedSessions);
            setTimeout(() => highlightAddSession(sourceIdentifier), 50);
            refreshBadge();
          });
        }
      });
    } else if (op.type === 'mergeSmartGroupToSession') {
      // Undo Smart Group merge into a session
      chrome.storage.local.get(['smartGroups', 'savedSessions'], (result) => {
        const smartGroups = result.smartGroups || [];
        let savedSessions = result.savedSessions || [];

        const sourceGroup = smartGroups.find(g => g.id === op.sourceSmartGroupId);
        const targetSession = savedSessions.find(s => s.timestamp === op.targetSessionTimestamp);

        if (sourceGroup && targetSession) {
          // Remove tabs from session that came from Smart Group
          const movedCount = op.sourceTabs.length;
          targetSession.tabs = targetSession.tabs.slice(movedCount);

          // Restore tabs to Smart Group
          sourceGroup.tabs = op.sourceTabs;

          // Restore collapsed state
          const sourceIdentifier = sourceGroup.id || sourceGroup.timestamp;
          if (op.wasCollapsed) collapsedSessions[sourceIdentifier] = true;
          else delete collapsedSessions[sourceIdentifier];

          chrome.storage.local.set({ smartGroups, savedSessions, collapsedSessions }, () => {
            updateSessionList(savedSessions);
            setTimeout(() => highlightAddSession(sourceIdentifier), 50);
            refreshBadge();
          });
        }
      });
    } else if (op.type === 'merge') {
      const { sourceSession, targetSessionTimestamp } = op;

      // Find the target session by timestamp
      const targetIndex = savedSessions.findIndex(s => s.timestamp === targetSessionTimestamp);
      if (targetIndex === -1) return;

      const targetSession = savedSessions[targetIndex];
      // Re-split the merged session by removing source tabs from target
      const movedCount = sourceSession.tabs.length;
      targetSession.tabs.splice(0, movedCount);

      // Insert source session back into savedSessions
      // Insert it right before the target to restore relative positioning
      savedSessions.splice(targetIndex, 0, sourceSession);

      // Restore its previous collapsed/expanded state
      if (op.wasCollapsed) collapsedSessions[sourceSession.timestamp] = true;
      else delete collapsedSessions[sourceSession.timestamp];
      chrome.storage.local.set({ collapsedSessions });
      chrome.storage.local.set({ savedSessions }, () => {
        updateSessionList(savedSessions);
        // Animate re-split (restored) source session
        setTimeout(() => highlightAddSession(sourceSession.timestamp), 50);
        refreshBadge();
      });
  } else if (op.type === 'moveSearchResults') {
    // Undo search results move: delete the new session and restore tabs to original sessions
    chrome.storage.local.get(['savedSessions'], (result) => {
      let sessions = result.savedSessions || [];

      // Find and remove the newly created session
      const newSessionIndex = sessions.findIndex(s => s.timestamp === op.newSessionTimestamp);
      if (newSessionIndex === -1) {
        delete pendingOperations[opId];
        return;
      }

      sessions.splice(newSessionIndex, 1);

      // Restore tabs to their original sessions
      // Group search results by their original session
      const resultsBySession = new Map();
      op.searchResults.forEach(result => {
        if (!resultsBySession.has(result.sessionId)) {
          resultsBySession.set(result.sessionId, []);
        }
        resultsBySession.get(result.sessionId).push(result);
      });

      // For each original session, restore its tabs
      resultsBySession.forEach((results, sessionId) => {
        // Find or recreate the original session
        let session = sessions.find(s => s.timestamp === sessionId);

        if (!session) {
          // Session was deleted because it became empty, recreate it
          const firstResult = results[0];
          session = {
            timestamp: sessionId,
            defaultTitle: firstResult.sessionTitle || "Restored Session",
            title: firstResult.sessionTitle || "Restored Session",
            customName: "",
            tabs: [],
            pendingTitle: false,
            pendingCategorization: false
          };
          sessions.push(session);
        }

        // Sort results by original tabIndex to restore in correct order
        results.sort((a, b) => a.tabIndex - b.tabIndex);

        // Insert tabs back at their original positions
        results.forEach(result => {
          const tab = {
            title: result.title,
            url: result.url,
            favicon: result.favicon
          };
          // Insert at original index, or append if index is beyond current length
          if (result.tabIndex <= session.tabs.length) {
            session.tabs.splice(result.tabIndex, 0, tab);
          } else {
            session.tabs.push(tab);
          }
        });
      });

      // Sort sessions by timestamp (newest first)
      sessions.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

      chrome.storage.local.set({ savedSessions: sessions }, () => {
        updateSessionList(sessions);
        refreshBadge();
      });
    });
    delete pendingOperations[opId];
  } else if (op.type === 'deleteTabFromSmartGroup') {
    // Restore individual tab to Smart Group
    const { smartGroupId, tabIndex, deletedLink } = op;

    chrome.storage.local.get(['smartGroups', 'trashedLinks', 'savedSessions'], (result) => {
      const smartGroups = result.smartGroups || [];
      const group = smartGroups.find(g => g.id === smartGroupId);

      if (group) {
        // Insert the tab back to its original position
        group.tabs.splice(tabIndex, 0, deletedLink);

        let trashedLinks = result.trashedLinks || [];
        // Remove this specific tab from trash
        trashedLinks = trashedLinks.filter(item => item.url !== deletedLink.url);

        // Save updated data
        chrome.storage.local.set({
          smartGroups: smartGroups,
          trashedLinks: trashedLinks
        }, () => {
          const savedSessions = result.savedSessions || [];
          updateSessionList(savedSessions);
          refreshBadge();
        });
      }
    });
  } else if (op.type === 'deleteLink') {
    // CLIENT-SIDE UNDO: Restore individual tab to original position, bypassing background.js
    const { sessionTimestamp, tabIndex, deletedLink } = op;

    const sessionIndex = savedSessions.findIndex(s => s.timestamp === sessionTimestamp);
    if (sessionIndex !== -1) {
      // Insert the tab back to its original position
      savedSessions[sessionIndex].tabs.splice(tabIndex, 0, deletedLink);

      // Remove from trash
      chrome.storage.local.get(['trashedLinks'], (result) => {
        let trashedLinks = result.trashedLinks || [];

        // Remove this specific tab from trash
        trashedLinks = trashedLinks.filter(item => item.url !== deletedLink.url);

        // Save updated data
        chrome.storage.local.set({
          savedSessions: savedSessions,
          trashedLinks: trashedLinks
        }, () => {
          updateSessionList(savedSessions);
          refreshBadge();
        });
      });
    }
  } else if (op.type === 'trashDuplicates') {
    // Undo trash duplicates operation: restore original sessions and Smart Groups, remove from trash
    chrome.storage.local.get(['trashedLinks'], (result) => {
      let trashedLinks = result.trashedLinks || [];

      // Remove the trashed items we added
      trashedLinks = trashedLinks.filter(item => !op.trashIdsAdded.includes(item.id));

      // Restore original sessions
      savedSessions = op.originalSessions;

      // Restore original Smart Groups if they exist
      const restoreData = {
        savedSessions: savedSessions,
        trashedLinks: trashedLinks
      };

      if (op.originalSmartGroups) {
        restoreData.smartGroups = op.originalSmartGroups;
      }

      // Save updated data
      chrome.storage.local.set(restoreData, () => {
        updateSessionList(savedSessions);
        refreshBadge();
      });
    });
  }
  delete pendingOperations[opId];
}

/** If user does not undo, finalize the operation.
 */
function finalizePendingOperation(opId) {
  const op = pendingOperations[opId];
  if (!op) return;


  // Items are now immediately moved to trash when deleted, so this function
  // only needs to clean up UI state and collapsed sessions

  // Clean up collapsedSessions for operations that were *not* undone
  if (op.type === 'delete' || op.type === 'deleteEmptySession') {
    delete collapsedSessions[op.sessionData.timestamp];
  } else if (op.type === 'deleteSmartGroup') {
    // Clean up collapsed state for Smart Group
    chrome.storage.local.get(['smartGroups'], (result) => {
      const smartGroups = result.smartGroups || [];
      const group = smartGroups.find(g => g.id === op.smartGroupId);
      if (group) {
        const groupIdentifier = group.timestamp || group.id;
        delete collapsedSessions[groupIdentifier];
        chrome.storage.local.set({ collapsedSessions });
      }
    });
  } else if (op.type === 'merge') {
    delete collapsedSessions[op.sourceSession.timestamp];
  } else if (op.type === 'mergeSmartGroup' || op.type === 'mergeSmartGroupToSession') {
    // Clean up collapsed state for merged Smart Group
    chrome.storage.local.get(['smartGroups'], (result) => {
      const smartGroups = result.smartGroups || [];
      const group = smartGroups.find(g => g.id === op.sourceSmartGroupId);
      if (group) {
        const groupIdentifier = group.timestamp || group.id;
        delete collapsedSessions[groupIdentifier];
        chrome.storage.local.set({ collapsedSessions });
      }
    });
  }

  removeUndoBubble(opId);
  // Update both storage items together to avoid race conditions
  chrome.storage.local.set({ savedSessions, collapsedSessions }, () => {
    refreshBadge();
  });
  delete pendingOperations[opId];
}

/** Remove an undo bubble with fade-out.
 */
function removeUndoBubble(opId) {
  const bubble = undoContainer.querySelector(`.undo-bubble[data-opid="${opId}"]`);
  if (!bubble) return;
  bubble.style.opacity = '0';
  bubble.style.transform = 'translateX(100%)';
  setTimeout(() => {
    if (bubble.parentNode) {
      bubble.parentNode.removeChild(bubble);
    }
  }, 300);
}

/**
 * SESSION-LEVEL DRAG & DROP
 */
let isSessionDragging = false;
let dragSourceSessionIndex = -1;
let dragSourceSessionElement = null;
let sessionDragPreview = null;
let sessionOffsetX = 0;
let sessionOffsetY = 0;
let currentSessionDropTarget = null; // element currently highlighted
let currentSessionDropPos = null;    // 'above' | 'below'
let sessionDragStartX = 0;
let sessionDragStartY = 0;
let hasMovedMinDistance = false;

function startSessionDrag(e, sessionIndex, wrapper) {
  // Always clean up any existing listeners first
  document.removeEventListener('pointermove', onSessionPointerMove);
  document.removeEventListener('pointerup', onSessionPointerUp);

  isSessionDragging = true;
  hasMovedMinDistance = false;
  sessionDragStartX = e.clientX;
  sessionDragStartY = e.clientY;
  document.body.style.userSelect = 'none';
  dragSourceSessionIndex = sessionIndex;
  dragSourceSessionElement = wrapper;
  const rect = wrapper.getBoundingClientRect();
  sessionOffsetX = e.clientX - rect.left;
  sessionOffsetY = e.clientY - rect.top;
  sessionDragPreview = wrapper.cloneNode(true);
  sessionDragPreview.classList.add('drag-preview');
  sessionDragPreview.style.position = 'fixed';
  sessionDragPreview.style.zIndex = '9999';
  sessionDragPreview.style.pointerEvents = 'none';
  sessionDragPreview.style.left = (e.clientX - sessionOffsetX) + 'px';
  sessionDragPreview.style.top = (e.clientY - sessionOffsetY) + 'px';
  const actionsRow = sessionDragPreview.querySelector('.session-actions');
  if (actionsRow) {
    actionsRow.style.display = 'none';
  }
  const ghostHeader = sessionDragPreview.querySelector('.session-header');
  if (ghostHeader) {
    ghostHeader.style.opacity = '1';
  }
  // Reset session title color and drag icon color to prevent color leaking
  const ghostTitle = sessionDragPreview.querySelector('.session-title');
  if (ghostTitle) {
    ghostTitle.style.color = '';
  }
  const ghostDragIcon = sessionDragPreview.querySelector('.session-drag-handle');
  if (ghostDragIcon) {
    ghostDragIcon.style.color = '';
    const svg = ghostDragIcon.querySelector('svg');
    if (svg) {
      svg.style.fill = '';
      svg.style.stroke = '';
      const paths = svg.querySelectorAll('path, circle');
      paths.forEach(p => {
        p.style.fill = '';
        p.style.stroke = '';
      });
    }
  }
  // Reset toggle button chevron and link count colors
  const ghostToggleBtn = sessionDragPreview.querySelector('.toggle-button');
  if (ghostToggleBtn) {
    const chevronSvgs = ghostToggleBtn.querySelectorAll('svg');
    chevronSvgs.forEach(svg => {
      svg.style.fill = '';
      const paths = svg.querySelectorAll('path');
      paths.forEach(p => {
        p.style.fill = '';
        p.style.stroke = '';
      });
    });
    const linkCount = ghostToggleBtn.querySelector('.link-count');
    if (linkCount) {
      linkCount.style.color = '';
    }
  }
  document.body.appendChild(sessionDragPreview);
  wrapper.style.opacity = '0.4';
  document.body.style.cursor = 'grabbing';

  // Add listeners immediately (no setTimeout delay)
  document.addEventListener('pointermove', onSessionPointerMove);
  document.addEventListener('pointerup', onSessionPointerUp);
}

function onSessionPointerMove(e) {
  if (!isSessionDragging || !sessionDragPreview) return;

  // Track if user has moved mouse at least 5px (to distinguish click from drag)
  if (!hasMovedMinDistance) {
    const dx = e.clientX - sessionDragStartX;
    const dy = e.clientY - sessionDragStartY;
    if (Math.sqrt(dx * dx + dy * dy) > 5) {
      hasMovedMinDistance = true;
    }
  }

  // 1) Move the drag preview
  sessionDragPreview.style.left = (e.clientX - sessionOffsetX) + 'px';
  sessionDragPreview.style.top  = (e.clientY - sessionOffsetY) + 'px';

  // 2) Gather all wrappers except the one being dragged
  const wrappers = Array.from(document.querySelectorAll('.session-wrapper'))
    .filter(w => w !== dragSourceSessionElement);

  let insertIdx = null;
  let newTarget = null;
  let newPos = null;

  // 4) Find first wrapper whose midpoint is below the pointer → insert-above
  for (const w of wrappers) {
    const { top, height } = w.getBoundingClientRect();
    const midY = top + height / 2;
    if (e.clientY < midY) {
      newTarget = w;
      newPos = 'above';
      insertIdx = parseInt(w.dataset.index, 10);
      break;
    }
  }

    // 5) Fallback: pointer is below every midpoint → insert-below last wrapper
    if (insertIdx === null) {
      // find all session wrappers except the drag preview
      const realWrappers = Array.from(
        document.querySelectorAll('.session-wrapper')
      ).filter(w => !w.classList.contains('drag-preview'));

      if (realWrappers.length) {
        const lastWrapper = realWrappers[realWrappers.length - 1];
        const { top, height } = lastWrapper.getBoundingClientRect();
        const midY = top + height / 2;
        // anywhere below midpoint → valid drop
        if (e.clientY >= midY) {
          newTarget = lastWrapper;
          newPos = 'below';
          insertIdx = parseInt(lastWrapper.dataset.index, 10) + 1;
        }
      }
    }

  // 6) Update highlight only when target or position changes (reduces flicker)
  const sameTarget = (newTarget === currentSessionDropTarget && newPos === currentSessionDropPos);
  if (!sameTarget) {
    if (currentSessionDropTarget) {
      currentSessionDropTarget.classList.remove('insert-above', 'insert-below', 'drop-target-session');
    }
    if (newTarget && newPos) {
      newTarget.classList.add('drop-target-session');
      newTarget.classList.add(newPos === 'above' ? 'insert-above' : 'insert-below');
    }
    currentSessionDropTarget = newTarget;
    currentSessionDropPos = newPos;
  }

  lastSessionDropIndex = insertIdx;
  autoScroll(e);
}

function onSessionPointerUp(e) {
  if (!isSessionDragging) return;
  isSessionDragging = false;
  document.body.style.userSelect = '';
  document.body.style.cursor = '';
  if (sessionDragPreview && sessionDragPreview.parentNode) {
    sessionDragPreview.parentNode.removeChild(sessionDragPreview);
  }
  sessionDragPreview = null;
  if (dragSourceSessionElement) {
    dragSourceSessionElement.style.opacity = '';
  }
  if (currentSessionDropTarget) {
    currentSessionDropTarget.classList.remove('insert-above', 'insert-below', 'drop-target-session');
    currentSessionDropTarget = null;
    currentSessionDropPos = null;
  }
  finalizeSessionDrop(e);
  dragSourceSessionIndex = -1;
  dragSourceSessionElement = null;
  sessionOffsetX = 0;
  sessionOffsetY = 0;
  document.removeEventListener('pointermove', onSessionPointerMove);
  document.removeEventListener('pointerup', onSessionPointerUp);
}

function finalizeSessionDrop(e) {
  // Only proceed if user actually dragged (moved at least 5px)
  if (!hasMovedMinDistance) {
    return revertSessionDrag();
  }

  // Try real hit-test first…
  const elem = document.elementFromPoint(e.clientX, e.clientY);
  let targetIndex = null;

  if (elem) {
    const wrapper = elem.closest('.session-wrapper');
    if (wrapper && wrapper !== dragSourceSessionElement) {
      // compute exact above/below split
      const idx = parseInt(wrapper.dataset.index, 10);
      const midY = wrapper.getBoundingClientRect().top
                 + wrapper.getBoundingClientRect().height / 2;
      targetIndex = (e.clientY < midY) ? idx : idx + 1;
    }
  }

  // fallback to last hover if hit-test failed
  if (targetIndex === null && lastSessionDropIndex !== null) {
    targetIndex = lastSessionDropIndex;
  }

  if (targetIndex === null) {
    return revertSessionDrag();
  }

  // proceed with reordering
  reorderSessions(dragSourceIndex, targetIndex);
}

function revertSessionDrag() {
  document.body.style.userSelect = '';
  document.body.style.cursor = '';
  chrome.storage.local.get(["savedSessions"], (res) => {
    updateSessionList(res.savedSessions || []);
  });
  if (currentSessionDropTarget) {
    currentSessionDropTarget.classList.remove('insert-above', 'insert-below', 'drop-target-session');
    currentSessionDropTarget = null;
    currentSessionDropPos = null;
  }
}

function reorderSessions(sourceIndex, targetIndex) {
  if (sourceIndex < 0 || sourceIndex >= savedSessions.length) return;
  if (targetIndex < 0) targetIndex = 0;
  if (targetIndex > savedSessions.length) targetIndex = savedSessions.length;

  // Check if we're dropping in the same position (no actual reorder)
  let adjustedTarget = targetIndex;
  if (sourceIndex < targetIndex) {
    adjustedTarget = targetIndex - 1;
  }

  // If dropping in same position, just revert without animation
  if (sourceIndex === adjustedTarget) {
    return revertSessionDrag();
  }

  const [moved] = savedSessions.splice(sourceIndex, 1);
  savedSessions.splice(adjustedTarget, 0, moved);
  chrome.storage.local.set({ savedSessions }, () => {
    updateSessionList(savedSessions);
    highlightDropSession(moved.timestamp);
    refreshBadge();
  });
}

function highlightMergeSession(timestamp) {
  setTimeout(() => {
    const wrapper = document.querySelector(`.session-wrapper[data-timestamp="${timestamp}"]`);
    if (!wrapper) return;
    wrapper.classList.add('scale-merge');
    setTimeout(() => {
      wrapper.classList.remove('scale-merge');
    }, 200);
  }, 50);
}

function highlightDeleteSession(timestamp) {
  const wrapper = document.querySelector(`.session-wrapper[data-timestamp="${timestamp}"]`);
  if (!wrapper) return;
  wrapper.classList.add('scale-delete');
  setTimeout(() => {
    wrapper.classList.remove('scale-delete');
  }, 150);
}

function highlightRow(url) {
  setTimeout(() => {
    const rowLink = document.querySelector(`a[data-url="${url}"]`);
    if (!rowLink) return;
    const li = rowLink.closest('li');
    if (!li) return;
    li.classList.add('flash-saved');
    setTimeout(() => {
      li.classList.remove('flash-saved');
    }, 500);
  }, 50);
}

function highlightLinkDrop(url) {
  setTimeout(() => {
    const rowLink = document.querySelector(`a[data-url="${url}"]`);
    if (!rowLink) return;
    const li = rowLink.closest('li');
    if (!li) return;
    li.classList.add('flash-saved-emphasis');
    li.classList.add('scale-drop');
    setTimeout(() => {
      li.classList.remove('flash-saved-emphasis');
      li.classList.remove('scale-drop');
    }, 400);
  }, 50);
}

function highlightSession(timestamp) {
  setTimeout(() => {
    const wrapper = document.querySelector(`.session-wrapper[data-timestamp="${timestamp}"]`);
    if (!wrapper) return;
    wrapper.classList.add('flash-change');
    setTimeout(() => {
      wrapper.classList.remove('flash-change');
    }, 300);
  }, 50);
}

function highlightDropSession(timestamp) {
  setTimeout(() => {
    const wrapper = document.querySelector(`.session-wrapper[data-timestamp="${timestamp}"]`);
    if (!wrapper) return;
    wrapper.classList.add('flash-change');
    wrapper.classList.add('scale-drop');
    setTimeout(() => {
      wrapper.classList.remove('flash-change');
      wrapper.classList.remove('scale-drop');
    }, 250);
  }, 50);
}

function highlightLinkDropAt(sessionTimestamp, liIndex) {
  setTimeout(() => {
    const wrapper = document.querySelector(`.session-wrapper[data-timestamp="${sessionTimestamp}"]`);
    if (!wrapper) return;
    const ul = wrapper.querySelector('.session-card ul');
    if (!ul) return;
    const items = ul.querySelectorAll('li');
    const li = items[liIndex] || null;
    if (!li) return;
    li.classList.add('flash-saved-emphasis');
    li.classList.add('scale-drop');
    setTimeout(() => {
      li.classList.remove('flash-saved-emphasis');
      li.classList.remove('scale-drop');
    }, 400);
  }, 50);
}

function updateSessionName(timestamp, newName) {
  const trimmed = (newName || '').trim();
  const finalName = trimmed.substring(0, 60);
  chrome.storage.local.get(["savedSessions"], (result) => {
    let sessions = result.savedSessions || [];
    sessions = sessions.map(s => {
      if (s.timestamp === timestamp) {
        if (!finalName) {
          delete s.customName;
        } else {
          s.customName = finalName;
        }
      }
      return s;
    });
    savedSessions = sessions;
    chrome.storage.local.set({ savedSessions }, () => {
      updateSessionList(sessions);
    });
  });
}

/* =========================
   LINK-LEVEL DRAG & DROP
 ========================= */
function startPointerDrag(e, li, session, tabIndex, url) {
  if (isLinkDragging) return;
  isLinkDragging = true;
  linkDragStartX = e.clientX;
  linkDragStartY = e.clientY;
  wasDraggingLink = false;
  dragSourceLinkElement = li;
  dragSourceLinkSession = session;
  dragSourceLinkIndex = tabIndex;
  const rect = li.getBoundingClientRect();
  linkOffsetX = e.clientX - rect.left;
  linkOffsetY = e.clientY - rect.top;
  linkDragPreview = li.cloneNode(true);
  linkDragPreview.classList.add('drag-preview-link');
  linkDragPreview.style.position = 'fixed';
  linkDragPreview.style.zIndex = '10000';
  linkDragPreview.style.pointerEvents = 'none';
  linkDragPreview.style.listStyleType = 'none';
  linkDragPreview.style.textAlign = 'left';
  linkDragPreview.style.left = (e.clientX - linkOffsetX) + 'px';
  linkDragPreview.style.top = (e.clientY - linkOffsetY) + 'px';
  document.body.appendChild(linkDragPreview);
  li.style.opacity = '0.4';
  document.addEventListener('pointermove', onLinkPointerMove);
  document.addEventListener('pointerup', onLinkPointerUp);
}

function onLinkPointerMove(e) {
  if (!isLinkDragging || !linkDragPreview) return;
  const dx = e.clientX - linkDragStartX;
  const dy = e.clientY - linkDragStartY;
  if (Math.sqrt(dx * dx + dy * dy) > 5) {
    wasDraggingLink = true;
  }
  linkDragPreview.style.left = (e.clientX - linkOffsetX) + 'px';
  linkDragPreview.style.top = (e.clientY - linkOffsetY) + 'px';
  
  // Remove any previous drop indicators for list items and session cards
  document.querySelectorAll('li.drop-above, li.drop-below').forEach(li => {
    li.classList.remove('drop-above', 'drop-below');
  });
  document.querySelectorAll('.session-card.drop-target').forEach(card => {
    card.classList.remove('drop-target');
  });
  
  const elem = document.elementFromPoint(e.clientX, e.clientY);
  if (!elem) return;
  const targetLi = elem.closest('li');
  if (targetLi && targetLi !== dragSourceLinkElement) {
    const targetRect = targetLi.getBoundingClientRect();
    const midY = targetRect.top + targetRect.height / 2;
    if (e.clientY < midY) {
      targetLi.classList.add('drop-above');
    } else {
      targetLi.classList.add('drop-below');
    }
    const targetSessionCard = targetLi.closest('.session-card');
    if (targetSessionCard) {
      targetSessionCard.classList.add('drop-target');
    }
  }
  
  // Auto-scroll if near top or bottom
  autoScroll(e);
}

function onLinkPointerUp(e) {
  if (!isLinkDragging) return;
  document.removeEventListener('pointermove', onLinkPointerMove);
  document.removeEventListener('pointerup', onLinkPointerUp);
  if (linkDragPreview && linkDragPreview.parentNode) {
    linkDragPreview.parentNode.removeChild(linkDragPreview);
  }
  document.querySelectorAll('li.drop-above, li.drop-below').forEach(li => {
    li.classList.remove('drop-above', 'drop-below');
  });
  document.querySelectorAll('.session-card.drop-target').forEach(card => {
    card.classList.remove('drop-target');
  });
  dragSourceLinkElement.style.opacity = '';
  
  // If a drag occurred, set a temporary ignore window for click events.
  if (wasDraggingLink) {
    ignoreClicksUntil = Date.now() + 150;
  }
  
  const elem = document.elementFromPoint(e.clientX, e.clientY);
  let targetSession = null;
  let newIndex = -1;
  if (elem) {
    const targetLi = elem.closest('li');
    if (targetLi) {
      const targetUl = targetLi.parentElement;
      const sourceUl = dragSourceLinkElement.parentElement;
      if (targetUl === sourceUl) {
        const liElements = Array.from(targetUl.querySelectorAll('li'));
        newIndex = liElements.indexOf(targetLi);
        const targetRect = targetLi.getBoundingClientRect();
        const midY = targetRect.top + targetRect.height / 2;
        if (e.clientY > midY) {
          newIndex = liElements.indexOf(targetLi) + 1;
        }
        targetSession = dragSourceLinkSession;
      } else {
        const liElements = Array.from(targetUl.querySelectorAll('li'));
        newIndex = liElements.indexOf(targetLi);
        const targetRect = targetLi.getBoundingClientRect();
        const midY = targetRect.top + targetRect.height / 2;
        if (e.clientY > midY) {
          newIndex = liElements.indexOf(targetLi) + 1;
        }
        const targetSessionWrapper = targetUl.closest('.session-wrapper');
        if (targetSessionWrapper && targetSessionWrapper.dataset.timestamp) {
          targetSession = savedSessions.find(s => s.timestamp === targetSessionWrapper.dataset.timestamp);
        }
      }
    } else {
      const targetSessionWrapper = elem.closest('.session-wrapper');
      if (targetSessionWrapper && targetSessionWrapper.dataset.timestamp) {
        const targetUl = targetSessionWrapper.querySelector('.session-card ul');
        const liElements = targetUl ? Array.from(targetUl.querySelectorAll('li')) : [];
        newIndex = liElements.length;
        targetSession = savedSessions.find(s => s.timestamp === targetSessionWrapper.dataset.timestamp);
      }
    }
  }
  if (targetSession === null || newIndex === -1) {
    // No valid drop target found - revert the drag operation
    // The link stays in its original position
    isLinkDragging = false;
    dragSourceLinkElement = null;
    dragSourceLinkSession = null;
    dragSourceLinkIndex = -1;
    linkOffsetX = 0;
    linkOffsetY = 0;
    wasDraggingLink = false;
    return;
  }
  const sourceSessionIndex = savedSessions.findIndex(s => s.timestamp === dragSourceLinkSession.timestamp);
  if (sourceSessionIndex === -1) {
    isLinkDragging = false;
    wasDraggingLink = false;
    return;
  }
  const [movedTab] = savedSessions[sourceSessionIndex].tabs.splice(dragSourceLinkIndex, 1);
  
  if (dragSourceLinkSession.timestamp !== targetSession.timestamp && savedSessions[sourceSessionIndex].tabs.length === 0) {
    savedSessions.splice(sourceSessionIndex, 1);
  }
  
  const targetSessionIndex = savedSessions.findIndex(s => s.timestamp === targetSession.timestamp);
  if (targetSessionIndex === -1) {
    isLinkDragging = false;
    wasDraggingLink = false;
    return;
  }
  if (targetSession.timestamp === dragSourceLinkSession.timestamp && newIndex > dragSourceLinkIndex) {
    newIndex--;
  }
  savedSessions[targetSessionIndex].tabs.splice(newIndex, 0, movedTab);
  const landedSessionTs = targetSession.timestamp;
  const landedIndex = newIndex;
  chrome.storage.local.set({ savedSessions }, () => {
    updateSessionList(savedSessions);
    // Trigger landed animation on the newly dropped link row
    highlightLinkDropAt(landedSessionTs, landedIndex);
    refreshBadge();
  });
  isLinkDragging = false;
  dragSourceLinkElement = null;
  dragSourceLinkSession = null;
  dragSourceLinkIndex = -1;
  linkOffsetX = 0;
  linkOffsetY = 0;
  wasDraggingLink = false;
}

// ------------------------------------------------
// Background Title Fetching on Page Load
// ------------------------------------------------
function startBackgroundTitleFetching() {
  chrome.storage.local.get(['savedSessions'], (result) => {
    const sessions = result.savedSessions || [];
    const titleQueue = new TitleFetchQueue(3, 200);
    const tabsNeedingTitles = [];
    const pendingAISessions = new Set();

    // Find all tabs where title equals URL
    sessions.forEach((session, sessionIndex) => {
      session.tabs.forEach((tab, tabIndex) => {
        if (tab.title === tab.url || !tab.title || tab.title.trim() === '') {
          tabsNeedingTitles.push({ session, sessionIndex, tab, tabIndex });
          // Track sessions that are pending AI and have missing titles
          if (session.pendingCategorization || session.pendingTitle) {
            pendingAISessions.add(session.timestamp);
          }
        }
      });
    });

    if (tabsNeedingTitles.length === 0) {
      debug('No titles need fetching');
      return;
    }

    debug('Fetching', tabsNeedingTitles.length, 'titles in background...');
    if (pendingAISessions.size > 0) {
      debug('Deferring AI processing for', pendingAISessions.size, 'sessions until titles are fetched');
    }

    // Fetch titles with live UI updates
    const fetchPromises = tabsNeedingTitles.map(({ session, tab }) => {
      return titleQueue.addWithCallback(tab.url, tab, (title) => {
        // Update global savedSessions and storage after each title is fetched
        savedSessions = sessions;
        chrome.storage.local.set({ savedSessions: sessions }, () => {
          // Update UI to show the new title
          updateSessionList(sessions);
        });
      });
    });

    // After all titles are fetched, trigger AI processing for pending sessions
    Promise.all(fetchPromises).then(() => {
      debug('All titles fetched');
      pendingAISessions.forEach(timestamp => {
        const session = sessions.find(s => s.timestamp === timestamp);
        if (session && session.pendingCategorization) {
          debug('[Tabstract] Triggering AI categorization after title fetch for session', timestamp);
          chrome.runtime.sendMessage({
            action: 'categorizePastedSession',
            timestamp: timestamp,
            tabs: session.tabs
          });
        } else if (session && session.pendingTitle) {
          debug('[Tabstract] Triggering AI title generation after title fetch for session', timestamp);
          chrome.runtime.sendMessage({
            action: 'generateTitleForPastedSession',
            timestamp: timestamp,
            tabs: session.tabs
          });
        }
      });
    }).catch(err => {
      debug('[Tabstract] Error fetching titles:', err);
    });
  });
}

// ============================================================================
// Full Screen Mode Functions
// ============================================================================

function toggleViewMode() {
  const nextMode = viewMode === "compact" ? "fullscreen" : "compact";

  // Skip animation if we're restoring on page load
  const skipAnimation = isRestoringViewMode;
  if (skipAnimation) {
    debug("[VIEW MODE] Skipping animation - restoring on page load");
  }

  // Scroll to top when switching modes to avoid being "below the fold"
  window.scrollTo({ top: 0, behavior: skipAnimation ? 'auto' : 'smooth' });

  // Add transitioning class for visibility control during animation
  if (!skipAnimation) {
    document.body.classList.add("transitioning");
  }

  // Update mode and data attribute
  viewMode = nextMode;
  document.body.setAttribute("data-view-mode", viewMode);
  chrome.storage.local.set({ viewMode });

  // Call appropriate enter/exit function
  if (nextMode === "fullscreen") {
    enterFullScreenMode();
  } else {
    exitFullScreenMode();
  }

  // Update UI state
  updateFullScreenModeButtonState();
  updateCompactOnlyButtonsState();

  // Remove transitioning class after animation completes
  if (!skipAnimation) {
    setTimeout(() => {
      document.body.classList.remove("transitioning");
    }, 500);
  }

  // Clear restore flag if it was set
  if (isRestoringViewMode) {
    isRestoringViewMode = false;
  }
}

function enterFullScreenMode() {
  // Skip if we're restoring on page load (already handled by renderSessionList)
  if (isRestoringViewMode) {
    debug('[ENTER FULLSCREEN] ⏭️ Skipping - already restoring view mode');
    return;
  }
  debug("Entering full screen mode");

  // Initialize collapsed sessions state (sessions not in the set are expanded by default)
  initializeCollapsedSessions(() => {
    // Transform session data to hierarchical list
    fullscreenData.allTabs = transformSessionsToTabs(savedSessions);

    // Populate filter dropdowns
    populateFilterDropdowns(fullscreenData.allTabs);
    updateSessionLevelFilters();

    // Apply filters and render
    applyFiltersAndRender();

    // Update sort indicators to show initial sort
    updateSortIndicators();

    // Set up event listeners
    setupFullScreenEventListeners();
  });
}

function initializeCollapsedSessions(callback) {
  // Get saved collapsed state from storage (empty = all expanded by default)
  chrome.storage.local.get(['advancedModeCollapsed'], (result) => {
    if (result.advancedModeCollapsed && result.advancedModeCollapsed.length > 0) {
      // Use saved collapsed sessions
      fullscreenData.collapsedSessions = new Set(result.advancedModeCollapsed);
    } else {
      // Default: all expanded (no sessions collapsed)
      fullscreenData.collapsedSessions = new Set();
    }
    if (callback) callback();
  });
}

function saveCollapsedState() {
  chrome.storage.local.set({
    advancedModeCollapsed: Array.from(fullscreenData.collapsedSessions)
  });
}

function toggleSessionExpanded(sessionId, applyToAll = false) {
  // Determine the new state: if currently collapsed, expand it; if expanded, collapse it
  const isCurrentlyCollapsed = fullscreenData.collapsedSessions.has(sessionId);
  const nowExpanded = isCurrentlyCollapsed; // Will be expanded if currently collapsed

  if (applyToAll) {
    // Shift-click: apply the same expand/collapse state to all sessions
    const allSessionIds = fullscreenData.allTabs
      .filter(item => item.type === 'session')
      .map(item => item.id);

    if (nowExpanded) {
      // Expand all: remove all from collapsed set
      allSessionIds.forEach(id => fullscreenData.collapsedSessions.delete(id));
    } else {
      // Collapse all: add all to collapsed set
      allSessionIds.forEach(id => fullscreenData.collapsedSessions.add(id));
    }
  } else {
    // Normal click: toggle just this session
    if (nowExpanded) {
      // Expand: remove from collapsed set
      fullscreenData.collapsedSessions.delete(sessionId);
    } else {
      // Collapse: add to collapsed set
      fullscreenData.collapsedSessions.add(sessionId);
    }
  }

  saveCollapsedState();
  applyFiltersAndRender();
}

function setupCustomDropdowns() {
  const filterMappings = {
    "date": "date",
    "domain": "domain",
    "color": "color"
  };

  Object.entries(filterMappings).forEach(([htmlId, filterKey]) => {
    const dropdown = document.getElementById(`filter-${htmlId}-dropdown`);
    if (!dropdown) return;

    const btn = dropdown.querySelector('.custom-dropdown-btn');
    const menu = dropdown.querySelector('.custom-dropdown-menu');
    const label = dropdown.querySelector('.custom-dropdown-label');

    // Toggle dropdown
    btn.addEventListener('click', (e) => {
      e.stopPropagation();

      // Close other dropdowns
      document.querySelectorAll('.custom-dropdown.open').forEach(d => {
        if (d !== dropdown) d.classList.remove('open');
      });

      dropdown.classList.toggle('open');
    });

    // Handle item selection
    menu.addEventListener('click', (e) => {
      const item = e.target.closest('.custom-dropdown-item');
      if (!item) return;

      const value = item.dataset.value;

      // Update filter
      fullscreenData.filters[filterKey] = value;

      // Toggle has-filter class for styling active filters
      dropdown.classList.toggle('has-filter', value !== 'all');

      // Update label with category name and value (localized)
      const categoryLabels = {
        'date': getMessage('filterDate') || 'Date:',
        'domain': getMessage('filterDomain') || 'Domain:',
        'color': getMessage('filterColor') || 'Color:',
        'locked': getMessage('filterLock') || 'Lock:'
      };

      const categoryLabel = categoryLabels[filterKey];
      // Strip trailing colon for display when showing just the category name
      const categoryName = categoryLabel.replace(/:$/, '');
      const itemText = item.textContent.trim();

      if (value === 'all') {
        label.textContent = categoryName;
      } else {
        // For color, just show the swatch + category name
        if (filterKey === 'color') {
          const swatch = item.querySelector('.color-swatch');
          if (swatch) {
            label.innerHTML = `${swatch.outerHTML} ${categoryName}`;
          } else {
            label.textContent = `${categoryLabel} ${itemText}`;
          }
        } else {
          label.textContent = `${categoryLabel} ${itemText}`;
        }
      }

      // Update selected state
      menu.querySelectorAll('.custom-dropdown-item').forEach(i => {
        i.classList.toggle('selected', i === item);
      });

      // Close dropdown
      dropdown.classList.remove('open');

      // Apply filters
      updateSessionLevelFilters();
      applyFiltersAndRender();
    });
  });

  // Close dropdowns when clicking outside
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.custom-dropdown')) {
      document.querySelectorAll('.custom-dropdown.open').forEach(d => {
        d.classList.remove('open');
      });
    }
  });
}

function setupFullScreenEventListeners() {
  const container = document.getElementById("fullscreen-container");
  if (!container) return;

  // Prevent duplicate listeners
  if (container.dataset.listenersAdded) return;
  container.dataset.listenersAdded = "true";

  // Toolbar quick action buttons
  const collapseExpandBtn = document.getElementById("toolbar-collapse-expand-all");
  if (collapseExpandBtn) {
    collapseExpandBtn.addEventListener("click", (e) => {
      e.preventDefault();
      handleCollapseExpandAllAction();
    });
  }

  // Column header sorting
  const sortableHeaders = container.querySelectorAll("th.sortable");
  sortableHeaders.forEach(th => {
    th.addEventListener("click", () => {
      const column = th.dataset.column;

      // Session-level columns (these sort the groups themselves)
      const isSessionColumn = column === 'title' || column === 'dateCreated' || column === 'color' || column === 'locked';
      // Tab-level columns (these sort tabs within groups)
      // Title sorts both sessions AND tabs within sessions
      const isTabColumn = column === 'domain' || column === 'title';

      // Toggle direction if same column, else default to desc
      if (fullscreenData.sortConfig.column === column) {
        fullscreenData.sortConfig.direction =
          fullscreenData.sortConfig.direction === "asc" ? "desc" : "asc";
      } else {
        fullscreenData.sortConfig.column = column;
        fullscreenData.sortConfig.direction = "desc";
      }

      // Update sessionSortConfig when sorting by a session-level column
      // This preserves the session order when later sorting by domain
      if (isSessionColumn) {
        fullscreenData.sessionSortConfig.column = column;
        fullscreenData.sessionSortConfig.direction = fullscreenData.sortConfig.direction;
      }

      // Update tabSortConfig when sorting by a tab-level column
      // This preserves the tab order when later sorting by session columns
      if (isTabColumn) {
        fullscreenData.tabSortConfig.column = column;
        fullscreenData.tabSortConfig.direction = fullscreenData.sortConfig.direction;
      }

      // Update UI
      updateSortIndicators();
      applyFiltersAndRender();
    });
  });

  // Custom dropdown handlers
  setupCustomDropdowns();

  // Search input with debounce
  const searchInput = document.getElementById("fullscreen-search");
  if (searchInput) {
    let searchTimeout;
    searchInput.addEventListener("input", (e) => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => {
        fullscreenData.filters.search = e.target.value;
        applyFiltersAndRender();
      }, 250); // Debounce 250ms
    });

    // ESC key to clear search and unfocus
    searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        searchInput.value = "";
        fullscreenData.filters.search = "";
        applyFiltersAndRender();
        searchInput.blur();
      }
    });
  }

  // Selection: Individual checkboxes (using event delegation)
  const tbody = document.getElementById("fullscreen-table-body");
  if (tbody) {
    tbody.addEventListener("change", (e) => {
      if (e.target.classList.contains("tab-checkbox")) {
        const tabId = e.target.dataset.tabId;
        const isChecked = e.target.checked;

        // Find the item in filteredTabs to check if it's a session
        const item = fullscreenData.filteredTabs.find(t => t.id === tabId);

        if (item && item.type === 'session') {
          // This is a session checkbox - check/uncheck all tabs in this session
          if (isChecked) {
            fullscreenData.selectedTabIds.add(tabId);
          } else {
            fullscreenData.selectedTabIds.delete(tabId);
          }

          // Find all tabs that belong to this session
          const sessionTabs = fullscreenData.filteredTabs.filter(
            t => t.type === 'tab' && t.parentSessionId === item.id
          );

          // Check/uncheck all tabs in the session
          sessionTabs.forEach(tab => {
            if (isChecked) {
              fullscreenData.selectedTabIds.add(tab.id);
            } else {
              fullscreenData.selectedTabIds.delete(tab.id);
            }
          });

          // Re-render to update all checkboxes
          renderFullScreenTable(fullscreenData.filteredTabs);
        } else {
          // This is a regular tab checkbox
          if (isChecked) {
            fullscreenData.selectedTabIds.add(tabId);
          } else {
            fullscreenData.selectedTabIds.delete(tabId);
          }

          // Update this tab row's selection visual
          const tabRow = e.target.closest('tr');
          if (tabRow) {
            if (isChecked) {
              tabRow.classList.add('selected');
            } else {
              tabRow.classList.remove('selected');
            }
          }

          // Update parent session checkbox state (indeterminate if partial selection)
          updateSessionCheckboxes();
        }

        updateBulkActionsBar();
        updateSelectAllCheckbox();
      }
    });

    // Prevent text selection on shift-click (happens on mousedown)
    tbody.addEventListener("mousedown", (e) => {
      const sessionTitleWrapper = e.target.closest(".session-title-wrapper");
      if (sessionTitleWrapper && e.shiftKey) {
        e.preventDefault(); // Prevent text selection on shift-click
      }
    });

    // Session expand/collapse click handler
    tbody.addEventListener("click", (e) => {
      // Don't expand/collapse if clicking the edit icon or input
      if (e.target.closest(".edit-icon") || e.target.closest(".session-title-input")) {
        return;
      }

      // Check if clicking on session title wrapper (for expand/collapse)
      const sessionTitleWrapper = e.target.closest(".session-title-wrapper");
      if (sessionTitleWrapper) {
        const sessionTitleCell = sessionTitleWrapper.closest("td[data-session-id]");
        if (sessionTitleCell) {
          const sessionId = sessionTitleCell.dataset.sessionId;
          if (sessionId) {
            e.preventDefault();
            e.stopPropagation();
            toggleSessionExpanded(sessionId, e.shiftKey);
            return;
          }
        }
      }
    });

    // Make checkbox cell clickable (increase hit target)
    tbody.addEventListener("click", (e) => {
      // Check if we clicked on the checkbox cell but not on the checkbox itself
      const checkboxCell = e.target.closest(".col-checkbox");
      if (checkboxCell && e.target.tagName !== "INPUT") {
        const checkbox = checkboxCell.querySelector(".tab-checkbox");
        if (checkbox) {
          e.preventDefault();
          e.stopPropagation();
          checkbox.checked = !checkbox.checked;
          checkbox.dispatchEvent(new Event("change", { bubbles: true }));
        }
      } else {
      }
    });

    // Tab link click handler - uses shared openSingleTab action
    tbody.addEventListener("click", (e) => {
      const titleLink = e.target.closest(".title-link");
      if (titleLink) {
        e.preventDefault();
        e.stopPropagation();

        const url = titleLink.href;
        const tabRow = titleLink.closest("tr.tab-row");
        if (!tabRow) return;

        const tabId = tabRow.dataset.tabId;
        const tab = fullscreenData.filteredTabs.find(t => t.id === tabId);
        if (!tab) return;

        // Extract timestamp from parentSessionId (format: "session-{timestamp}")
        const timestamp = tab.parentSessionId ? tab.parentSessionId.replace('session-', '') : null;

        // Use shared openSingleTab action (same as simple mode)
        chrome.runtime.sendMessage({
          action: "openSingleTab",
          url: url,
          timestamp: timestamp,
          invertDelete: e.shiftKey,
          invertBackground: e.altKey
        });
      }
    });

    // Lock/Pin toggle click handlers (session rows only)
    tbody.addEventListener("click", (e) => {
      const clickableIcon = e.target.closest(".clickable-icon");
      if (clickableIcon) {
        const action = clickableIcon.dataset.action;
        const sessionIndex = parseInt(clickableIcon.dataset.sessionIndex, 10);

        if (!isNaN(sessionIndex) && (action === 'toggle-lock' || action === 'toggle-pin')) {
          e.preventDefault();
          e.stopPropagation();

          // Get the actual session from savedSessions using the index directly
          chrome.storage.local.get(['savedSessions'], (result) => {
            let savedSessions = result.savedSessions || [];
            const session = savedSessions[sessionIndex];
            if (!session) return;

            if (action === 'toggle-lock') {
              session.locked = !session.locked;
            } else if (action === 'toggle-pin') {
              session.pinned = !session.pinned;
            }

            // Save to storage
            isUpdatingFromStorage = true;
            chrome.storage.local.set({ savedSessions }, () => {
              if (viewMode === 'fullscreen') {
                fullscreenData.allTabs = transformSessionsToTabs(savedSessions);
                applyFiltersAndRender();
              } else {
                updateSessionList(savedSessions);
              }
              setTimeout(() => { isUpdatingFromStorage = false; }, 100);
            });
          });
        }
      }

      // Edit session title click handler
      const editIcon = e.target.closest(".edit-icon");
      if (editIcon) {
        e.preventDefault();
        e.stopPropagation();

        const sessionId = editIcon.dataset.sessionId;
        const titleCell = editIcon.closest(".col-title");
        const sessionNameSpan = titleCell.querySelector(".session-name");

        if (!sessionNameSpan || titleCell.querySelector("input.session-title-input")) return; // Already editing

        const currentValue = sessionNameSpan.textContent;

        // Create input field that matches the cell height
        const input = document.createElement("input");
        input.type = "text";
        input.className = "session-title-input";
        input.value = currentValue;

        // Hide the session name span and edit icon
        sessionNameSpan.style.display = "none";
        editIcon.style.display = "none";

        // Insert input after the folder icon
        const titleWrapper = titleCell.querySelector(".session-title-wrapper");
        const folderIcon = titleWrapper.querySelector(".folder-icon");
        folderIcon.after(input);

        input.focus();
        input.select();

        let isHandled = false;

        // Save function
        const saveEdit = () => {
          if (isHandled) return;
          isHandled = true;

          const newValue = input.value.trim();

          // Clean up UI first
          sessionNameSpan.style.display = "";
          editIcon.style.display = "";
          input.remove();

          // Save if changed
          if (newValue && newValue !== currentValue) {
            // Find the session in allTabs
            const sessionItem = fullscreenData.allTabs.find(item => item.id === sessionId && item.type === 'session');
            if (!sessionItem) return;

            // Update the session title
            chrome.storage.local.get(['savedSessions'], (result) => {
              let savedSessions = result.savedSessions || [];
              const session = savedSessions[sessionItem.sessionIndex];
              if (!session) return;

              session.customName = newValue;

              // Save to storage
              isUpdatingFromStorage = true;
              chrome.storage.local.set({ savedSessions }, () => {
                if (viewMode === 'fullscreen') {
                  fullscreenData.allTabs = transformSessionsToTabs(savedSessions);
                  applyFiltersAndRender();
                } else {
                  updateSessionList(savedSessions);
                }
                setTimeout(() => { isUpdatingFromStorage = false; }, 100);
              });
            });
          }
        };

        // Cancel function
        const cancelEdit = () => {
          if (isHandled) return;
          isHandled = true;

          sessionNameSpan.style.display = "";
          editIcon.style.display = "";
          input.remove();
        };

        // Event handlers
        input.addEventListener("blur", saveEdit);
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            saveEdit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            cancelEdit();
          }
        });
      }

      // Color column click handler
      const colorCell = e.target.closest(".clickable-color");
      if (colorCell) {
        e.preventDefault();
        e.stopPropagation();

        const sessionId = colorCell.dataset.sessionId;

        // Find the session in allTabs
        const sessionItem = fullscreenData.allTabs.find(item => item.id === sessionId && item.type === 'session');
        if (!sessionItem) return;

        // Get the actual session from savedSessions
        chrome.storage.local.get(['savedSessions'], (result) => {
          let savedSessions = result.savedSessions || [];
          const session = savedSessions[sessionItem.sessionIndex];
          if (!session) return;

          // Create or update color picker menu
          let colorMenu = document.getElementById('inline-color-picker');
          const colorPickerHTML = `
            <div class="color-picker-container">
              <button class="color-dot color-dot-none" data-color="none" title="None" aria-label="No color"></button>
              <button class="color-dot" data-color="blue" style="background-color: #007AFF;" title="Blue"></button>
              <button class="color-dot" data-color="green" style="background-color: #53b559;" title="Green"></button>
              <button class="color-dot" data-color="yellow" style="background-color: #ffc400;" title="Yellow"></button>
              <button class="color-dot" data-color="orange" style="background-color: #fa6a22;" title="Orange"></button>
              <button class="color-dot" data-color="red" style="background-color: #FF0000;" title="Red"></button>
              <button class="color-dot" data-color="pink" style="background-color: #ff66ad;" title="Pink"></button>
              <button class="color-dot" data-color="purple" style="background-color: #924ff6;" title="Purple"></button>
              <button class="color-dot color-dot-custom" data-color="custom" title="Custom color">
                <input type="color" class="color-picker-input">
              </button>
            </div>
          `;

          if (!colorMenu) {
            colorMenu = document.createElement('div');
            colorMenu.id = 'inline-color-picker';
            colorMenu.className = 'inline-color-picker';
            colorMenu.innerHTML = colorPickerHTML;
            document.body.appendChild(colorMenu);

            // Add event handlers for color selection
            colorMenu.addEventListener('click', (e) => {
              const colorDot = e.target.closest('.color-dot');
              if (!colorDot) return;

              const color = colorDot.dataset.color;
              const sessionTimestamp = colorMenu.dataset.sessionTimestamp;

              if (color === 'custom') {
                const colorInput = colorDot.querySelector('.color-picker-input');
                if (colorInput) {
                  colorInput.click();
                }
                return;
              }

              handleSessionColorChange(sessionTimestamp, color);
              colorMenu.classList.remove('show');
              colorMenu.removeAttribute('data-session-timestamp');
            });

            // Custom color input handler
            const colorInput = colorMenu.querySelector('.color-picker-input');
            if (colorInput) {
              colorInput.addEventListener('change', (e) => {
                const hexColor = e.target.value;
                const sessionTimestamp = colorMenu.dataset.sessionTimestamp;
                handleSessionColorChange(sessionTimestamp, hexColor);
                colorMenu.classList.remove('show');
                colorMenu.removeAttribute('data-session-timestamp');
              });
              colorInput.addEventListener('click', (e) => {
                e.stopPropagation();
              });
            }

            // Close menu when clicking outside
            document.addEventListener('click', (e) => {
              if (!colorMenu.contains(e.target) && !e.target.closest('.clickable-color')) {
                colorMenu.classList.remove('show');
                colorMenu.removeAttribute('data-session-timestamp');
              }
            });
          } else {
            // Update existing color picker with new colors
            colorMenu.innerHTML = colorPickerHTML;

            // Re-attach event handlers for the new color input element
            const colorInput = colorMenu.querySelector('.color-picker-input');
            if (colorInput) {
              colorInput.addEventListener('change', (e) => {
                const hexColor = e.target.value;
                const sessionTimestamp = colorMenu.dataset.sessionTimestamp;
                handleSessionColorChange(sessionTimestamp, hexColor);
                colorMenu.classList.remove('show');
                colorMenu.removeAttribute('data-session-timestamp');
              });
              colorInput.addEventListener('click', (e) => {
                e.stopPropagation();
              });
            }
          }

          // Position and show the color menu
          const rect = colorCell.getBoundingClientRect();
          colorMenu.style.top = `${rect.bottom + window.scrollY + 4}px`;
          colorMenu.style.left = `${rect.left + window.scrollX}px`;
          colorMenu.dataset.sessionTimestamp = session.timestamp;
          colorMenu.classList.add('show');
        });
      }
    });

    // Inline editing: Double-click to edit (using event delegation)
    tbody.addEventListener("dblclick", (e) => {
      const cell = e.target.closest(".editable-cell");
      if (!cell || cell.querySelector("input.inline-edit")) return; // Already editing

      const field = cell.dataset.field;
      const tabId = cell.dataset.tabId;
      const contentSpan = cell.querySelector(".editable-content");
      if (!contentSpan) return;

      const currentValue = contentSpan.textContent;

      // Create input field
      const input = document.createElement("input");
      input.type = "text";
      input.className = "inline-edit";
      input.value = currentValue;

      // Replace span with input
      contentSpan.style.display = "none";
      cell.appendChild(input);
      input.focus();
      input.select();

      let isHandled = false; // Prevent duplicate saves

      // Save function
      const saveEdit = () => {
        if (isHandled) return;
        isHandled = true;

        const newValue = input.value.trim();

        // Clean up UI first
        contentSpan.style.display = "";
        input.remove();

        // Then save if changed
        if (newValue && newValue !== currentValue) {
          saveInlineEdit(tabId, field, newValue);
        }
      };

      // Cancel function
      const cancelEdit = () => {
        if (isHandled) return;
        isHandled = true;

        contentSpan.style.display = "";
        input.remove();
      };

      // Event handlers
      input.addEventListener("blur", saveEdit);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          saveEdit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          cancelEdit();
        }
      });
    });
  }

  // Selection: Select All checkbox
  const selectAllCheckbox = document.getElementById("header-select-all");
  if (selectAllCheckbox) {
    selectAllCheckbox.addEventListener("change", (e) => {
      if (e.target.checked) {
        // Select all visible tabs
        fullscreenData.filteredTabs.forEach(tab => {
          fullscreenData.selectedTabIds.add(tab.id);
        });
      } else {
        // Deselect all
        fullscreenData.selectedTabIds.clear();
      }
      renderFullScreenTable(fullscreenData.filteredTabs);
      updateBulkActionsBar();
    });

    // Make header checkbox cell clickable too
    const headerCheckboxCell = selectAllCheckbox.closest("th.col-checkbox");
    if (headerCheckboxCell) {
      headerCheckboxCell.addEventListener("click", (e) => {
        if (e.target.tagName !== "INPUT") {
          e.preventDefault();
          e.stopPropagation();
          selectAllCheckbox.checked = !selectAllCheckbox.checked;
          selectAllCheckbox.dispatchEvent(new Event("change", { bubbles: true }));
        }
      });
    }
  }

  // Bulk Actions
  const bulkRestoreBtn = document.getElementById("bulk-restore");
  if (bulkRestoreBtn) {
    bulkRestoreBtn.addEventListener("click", (e) => handleBulkRestore(e));
  }

  const bulkCreateGroupBtn = document.getElementById("bulk-create-group");
  if (bulkCreateGroupBtn) {
    bulkCreateGroupBtn.addEventListener("click", handleBulkCreateGroup);
  }

  const bulkTrashBtn = document.getElementById("bulk-trash");
  if (bulkTrashBtn) {
    bulkTrashBtn.addEventListener("click", handleBulkTrash);
  }

  const toolbarLockBtn = document.getElementById("toolbar-lock-unlock-all");
  if (toolbarLockBtn) {
    toolbarLockBtn.addEventListener("click", handleLockUnlockSelectedAction);
  }

  // Copy button dropdown menu - format selection
  const toolbarCopyContainer = document.querySelector(".toolbar-copy-container");
  const toolbarCopyMenu = document.getElementById("toolbar-copy-menu");
  const toolbarCopyBtn = document.getElementById("toolbar-copy-btn");
  if (toolbarCopyMenu && toolbarCopyContainer) {
    toolbarCopyMenu.addEventListener("click", (e) => {
      const menuItem = e.target.closest(".toolbar-copy-menu-item");
      if (menuItem) {
        const format = menuItem.dataset.copyFormat;
        handleBulkCopy(format);

        // Flash the menu item then hide menu
        menuItem.classList.add("copy-item-flash");
        setTimeout(() => {
          menuItem.classList.remove("copy-item-flash");
          toolbarCopyContainer.classList.add("copy-done");
          setTimeout(() => toolbarCopyContainer.classList.remove("copy-done"), 300);
        }, 250);
      }
    });
  }

  // Export button dropdown menu - format selection
  const toolbarExportContainer = document.querySelector(".toolbar-export-container");
  const toolbarExportMenu = document.getElementById("toolbar-export-menu");
  if (toolbarExportMenu && toolbarExportContainer) {
    toolbarExportMenu.addEventListener("click", (e) => {
      const menuItem = e.target.closest(".toolbar-export-menu-item");
      if (menuItem) {
        const format = menuItem.dataset.exportFormat;
        handleBulkExport(format);
      }
    });
  }

  // Save as Routine toolbar button
  const toolbarSaveRoutineBtn = document.getElementById("toolbar-save-routine-btn");
  if (toolbarSaveRoutineBtn) {
    toolbarSaveRoutineBtn.addEventListener("click", (e) => {
      e.preventDefault();
      if (toolbarSaveRoutineBtn.disabled) return;
      handleBulkSaveAsTemplate();
    });
  }

  const bulkDuplicateBtn = document.getElementById("bulk-duplicate");
  if (bulkDuplicateBtn) {
    bulkDuplicateBtn.addEventListener("click", handleBulkDuplicate);
  }

  // Clear Filters button
  const clearFiltersBtn = document.getElementById("clear-filters-btn");
  if (clearFiltersBtn) {
    clearFiltersBtn.addEventListener("click", clearAllFilters);
  }

  // Table scroll detection for header shadow
  const tableContainer = document.querySelector(".fullscreen-table-container");
  if (tableContainer) {
    tableContainer.addEventListener("scroll", () => {
      if (tableContainer.scrollTop > 10) {
        tableContainer.classList.add("scrolled");
      } else {
        tableContainer.classList.remove("scrolled");
      }
    });
  }
}

function updateSortIndicators() {
  const container = document.getElementById("fullscreen-container");
  if (!container) return;

  // Remove all sort classes
  container.querySelectorAll("th.sortable").forEach(th => {
    th.classList.remove("sort-asc", "sort-desc");
  });

  // Add current sort class
  const currentTh = container.querySelector(`th.sortable[data-column="${fullscreenData.sortConfig.column}"]`);
  if (currentTh) {
    currentTh.classList.add(`sort-${fullscreenData.sortConfig.direction}`);
  }
}

// Transform sessions into hierarchical list with session rows and tab rows
function transformSessionsToTabs(sessions) {
  const items = [];

  for (const session of sessions) {
    const sessionTimestamp = session.timestamp;
    const sessionName = session.customName || session.defaultTitle || formatSessionDate(sessionTimestamp);
    const sessionHasCustomName = Boolean(session.customName);
    const sessionColor = session.color || getDefaultSessionColor();
    const sessionLocked = Boolean(session.locked);
    const sessionPinned = Boolean(session.pinned);

    if (!session.tabs || !Array.isArray(session.tabs)) continue;

    const dateCreated = new Date(sessionTimestamp);
    const relativeDate = getRelativeDate(dateCreated);
    const sessionIndex = sessions.indexOf(session);

    // Add session row
    const sessionId = `session-${sessionTimestamp}`;

    // Initialize collapsedSessions for advanced mode if not already set
    if (!fullscreenData.collapsedSessions) {
      fullscreenData.collapsedSessions = new Set();
    }

    // Session is expanded unless explicitly collapsed
    // (New sessions are not in collapsedSessions, so they're expanded by default)
    const isExpanded = !fullscreenData.collapsedSessions.has(sessionId);

    items.push({
      id: sessionId,
      type: 'session',
      sessionTimestamp,
      sessionName,
      sessionHasCustomName,
      sessionColor,
      sessionLocked,
      sessionPinned,
      dateCreated,
      relativeDate,
      sessionIndex,
      tabCount: session.tabs.length,
      expanded: isExpanded
    });

    // Add tab rows (children of session)
    session.tabs.forEach((tab, index) => {
      const domain = extractDomain(tab.url);

      items.push({
        id: `${sessionTimestamp}-${index}`,
        type: 'tab',
        url: tab.url,
        title: tab.title || tab.url,

        // Session metadata
        sessionTimestamp,
        sessionName,
        sessionHasCustomName,
        sessionColor,
        sessionLocked,
        sessionPinned,

        // Tab metadata
        domain,
        dateCreated,
        relativeDate,
        favicon: getFaviconUrl(tab.url),

        // Original indices for updates
        sessionIndex,
        tabIndex: index,
        parentSessionId: sessionId
      });
    });
  }

  return items;
}

function extractDomain(url) {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname.replace(/^www\./, "");
  } catch {
    return "unknown";
  }
}

function getRelativeDate(date) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dateOnly = new Date(date.getFullYear(), date.getMonth(), date.getDate());

  const diffMs = today - dateOnly;
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return "This Week";
  if (diffDays < 14) return "Last Week";
  if (diffDays < 30) return "This Month";
  if (diffDays < 60) return "Last Month";
  return "Older";
}

function formatDateForTable(date) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  const dateOnly = new Date(date.getFullYear(), date.getMonth(), date.getDate());

  // Use effective locale for formatting
  const locale = getEffectiveLocale ? getEffectiveLocale() : undefined;

  const timeStr = date.toLocaleString(locale, {
    hour: 'numeric',
    minute: '2-digit'
  });

  if (dateOnly.getTime() === today.getTime()) {
    return getMessage('todayAt', [timeStr]) || `Today, ${timeStr}`;
  } else if (dateOnly.getTime() === yesterday.getTime()) {
    return getMessage('yesterdayAt', [timeStr]) || `Yesterday, ${timeStr}`;
  } else {
    return date.toLocaleString(locale, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    });
  }
}

function getFaviconUrl(url) {
  try {
    const urlObj = new URL(url);
    return `https://favicone.com/${urlObj.hostname}?s=32`;
  } catch {
    return chrome.runtime.getURL('images/icon-128.png');
  }
}

function getDefaultSessionColor() {
  // Get computed value of --text-secondary
  return getComputedStyle(document.documentElement).getPropertyValue('--text-secondary').trim();
}

function formatSessionDate(timestamp) {
  const date = new Date(timestamp);
  return date.toLocaleString('en-US', {
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
}

function updateDomainDropdown(filteredTabs) {
  const domainSelect = document.getElementById("filter-domain");
  if (!domainSelect) return;

  const currentValue = domainSelect.value;
  const domains = [...new Set(filteredTabs.map(t => t.domain))].sort();

  domainSelect.innerHTML = '<option value="all">Domain: All</option>';
  domains.forEach(domain => {
    const option = document.createElement("option");
    option.value = domain;
    option.textContent = `Domain: ${domain}`;
    domainSelect.appendChild(option);
  });

  // Restore selection if it still exists in filtered set
  if (currentValue !== "all" && domains.includes(currentValue)) {
    domainSelect.value = currentValue;
  } else if (currentValue !== "all") {
    // Previously selected domain no longer available, reset
    domainSelect.value = "all";
    fullscreenData.filters.domain = "all";
  }
}

function updateSessionLevelFilters() {
  // This function is no longer needed since we removed the group filter
  // that was disabling color and lock filters
}

// Populate filter dropdowns with unique values
function populateFilterDropdowns(items) {
  // Set localized button labels (strip trailing colons from locale keys)
  const dateBtnLabel = document.querySelector('#filter-date-dropdown .custom-dropdown-label');
  const domainBtnLabel = document.querySelector('#filter-domain-dropdown .custom-dropdown-label');
  const colorBtnLabel = document.querySelector('#filter-color-dropdown .custom-dropdown-label');

  if (dateBtnLabel && fullscreenData.filters.date === 'all') {
    dateBtnLabel.textContent = (getMessage('filterDate') || 'Date:').replace(/:$/, '');
  }
  if (domainBtnLabel && fullscreenData.filters.domain === 'all') {
    domainBtnLabel.textContent = (getMessage('filterDomain') || 'Domain:').replace(/:$/, '');
  }
  if (colorBtnLabel && fullscreenData.filters.color === 'all') {
    colorBtnLabel.textContent = (getMessage('filterColor') || 'Color:').replace(/:$/, '');
  }

  // Date filter
  const dateMenu = document.querySelector('#filter-date-dropdown .custom-dropdown-menu');
  if (dateMenu) {
    const allLabel = getMessage('filterAll') || 'All';
    const todayLabel = getMessage('filterDateToday') || 'Today';
    const yesterdayLabel = getMessage('filterDateYesterday') || 'Yesterday';
    const weekLabel = getMessage('filterDateWeek') || 'This Week';
    const monthLabel = getMessage('filterDateMonth') || 'This Month';
    const lastWeekLabel = getMessage('filterDateLastWeek') || 'Last Week';
    const lastMonthLabel = getMessage('filterDateLastMonth') || 'Last Month';
    dateMenu.innerHTML = `
      <div class="custom-dropdown-item" data-value="all">${allLabel}</div>
      <div class="custom-dropdown-item" data-value="Today">${todayLabel}</div>
      <div class="custom-dropdown-item" data-value="Yesterday">${yesterdayLabel}</div>
      <div class="custom-dropdown-item" data-value="This Week">${weekLabel}</div>
      <div class="custom-dropdown-item" data-value="This Month">${monthLabel}</div>
      <div class="custom-dropdown-item" data-value="Last Week">${lastWeekLabel}</div>
      <div class="custom-dropdown-item" data-value="Last Month">${lastMonthLabel}</div>
    `;
  }

  // Domain filter (only tabs have domains, filter out sessions)
  // Include both full domains and root domains (e.g., both "stuff.wordpress.com" and "wordpress.com")
  const tabsOnly = items.filter(item => item.type === 'tab');
  const allDomains = new Set();

  tabsOnly.forEach(tab => {
    if (tab.domain) {
      // Add the full domain
      allDomains.add(tab.domain);

      // Extract and add root domain (e.g., "wordpress.com" from "stuff.wordpress.com")
      const parts = tab.domain.split('.');
      if (parts.length >= 2) {
        const rootDomain = parts.slice(-2).join('.');
        allDomains.add(rootDomain);
      }
    }
  });

  const domains = [...allDomains].filter(Boolean).sort();
  const domainMenu = document.querySelector('#filter-domain-dropdown .custom-dropdown-menu');
  if (domainMenu) {
    const allLabel = getMessage('filterAll') || 'All';
    let html = `<div class="custom-dropdown-item" data-value="all">${allLabel}</div>`;
    domains.forEach(domain => {
      html += `<div class="custom-dropdown-item" data-value="${domain}">${domain}</div>`;
    });
    domainMenu.innerHTML = html;
  }

  // Color filter (with swatches) - both sessions and tabs have sessionColor
  const colorMenu = document.querySelector('#filter-color-dropdown .custom-dropdown-menu');
  if (colorMenu) {
    // Canonical color map with names (localized)
    const colorPalette = [
      { name: getMessage('colorBlue') || 'Blue', value: 'blue', hex: '#007AFF' },
      { name: getMessage('colorGreen') || 'Green', value: 'green', hex: '#53b559' },
      { name: getMessage('colorYellow') || 'Yellow', value: 'yellow', hex: '#ffc400' },
      { name: getMessage('colorOrange') || 'Orange', value: 'orange', hex: '#fa6a22' },
      { name: getMessage('colorRed') || 'Red', value: 'red', hex: '#FF0000' },
      { name: getMessage('colorPink') || 'Pink', value: 'pink', hex: '#ff66ad' },
      { name: getMessage('colorPurple') || 'Purple', value: 'purple', hex: '#924ff6' }
    ];

    // Get the default color (computed value of --text-secondary)
    const defaultColor = getDefaultSessionColor();

    // Get all unique colors from the data
    const allColors = items.map(t => t.sessionColor).filter(Boolean);

    // Check if any sessions have the default color
    const hasDefaultColor = allColors.some(c => c === defaultColor || c.startsWith('rgb'));

    // Get non-default colors
    const usedColors = new Set(
      allColors.filter(c => c !== defaultColor && !c.startsWith('rgb'))
    );

    // Build menu: All + Default (if used) + palette colors (if used) + custom colors (if used)
    const allLabel = getMessage('filterAll') || 'All';
    const defaultLabel = getMessage('colorDefault') || 'Default';
    let html = `<div class="custom-dropdown-item" data-value="all">${allLabel}</div>`;

    // Add Default option only if there are sessions with default color
    if (hasDefaultColor) {
      html += `<div class="custom-dropdown-item" data-value="none">
        <span class="color-swatch" style="background-color: var(--text-secondary);"></span>
        <span class="color-label">${defaultLabel}</span>
      </div>`;
    }

    // Add palette colors (only if used)
    colorPalette.forEach(({ name, value, hex }) => {
      if (usedColors.has(value) || usedColors.has(hex)) {
        html += `<div class="custom-dropdown-item" data-value="${value}">
          <span class="color-swatch" style="background-color: ${hex};"></span>
          <span class="color-label">${name}</span>
        </div>`;
      }
    });

    // Add custom hex colors (if any)
    const paletteHexValues = new Set(colorPalette.map(c => c.hex.toLowerCase()));
    usedColors.forEach(color => {
      // If it's a hex color and not in the palette
      if (color.startsWith('#') && !paletteHexValues.has(color.toLowerCase())) {
        html += `<div class="custom-dropdown-item" data-value="${color}">
          <span class="color-swatch" style="background-color: ${color};"></span>
          <span class="color-label">Custom</span>
        </div>`;
      }
    });

    colorMenu.innerHTML = html;
  }

}

function clearAllFilters() {
  // Reset all filters to default
  fullscreenData.filters = {
    date: "all",
    domain: "all",
    color: "all",
    search: ""
  };

  // Reset UI elements (with localized labels, stripping trailing colons)
  const dropdowns = [
    { id: 'filter-date-dropdown', label: (getMessage('filterDate') || 'Date:').replace(/:$/, '') },
    { id: 'filter-domain-dropdown', label: (getMessage('filterDomain') || 'Domain:').replace(/:$/, '') },
    { id: 'filter-color-dropdown', label: (getMessage('filterColor') || 'Color:').replace(/:$/, '') }
  ];

  dropdowns.forEach(({ id, label }) => {
    const dropdown = document.getElementById(id);
    if (dropdown) {
      const labelEl = dropdown.querySelector('.custom-dropdown-label');
      if (labelEl) labelEl.textContent = label;

      // Clear selected states
      dropdown.querySelectorAll('.custom-dropdown-item').forEach(item => {
        item.classList.toggle('selected', item.dataset.value === 'all');
      });

      // Remove has-filter class
      dropdown.classList.remove('has-filter');
    }
  });

  document.getElementById("fullscreen-search").value = "";

  // Re-render
  applyFiltersAndRender();
}

function hasActiveFilters() {
  const f = fullscreenData.filters;
  return f.date !== "all" ||
         f.domain !== "all" ||
         f.color !== "all" ||
         f.search !== "";
}

function updateClearFiltersButton() {
  const clearBtn = document.getElementById("clear-filters-btn");
  if (clearBtn) {
    clearBtn.disabled = !hasActiveFilters();
  }
}

// Apply filters and render table
function applyFiltersAndRender() {
  // Start with all items (sessions and tabs)
  let filtered = [...fullscreenData.allTabs];

  // Apply each filter
  const f = fullscreenData.filters;

  // Track which sessions should be included
  const includedSessionIds = new Set();
  const includedTabIds = new Set();

  // Filter by date (session-level)
  if (f.date !== "all") {
    filtered = filtered.filter(item => {
      const relDate = item.relativeDate;
      let matches = false;

      // "This Week" includes Today, Yesterday, This Week
      if (f.date === "This Week") {
        matches = relDate === "Today" || relDate === "Yesterday" || relDate === "This Week";
      }
      // "This Month" includes Today, Yesterday, This Week, Last Week, This Month
      else if (f.date === "This Month") {
        matches = relDate === "Today" || relDate === "Yesterday" || relDate === "This Week" || relDate === "Last Week" || relDate === "This Month";
      }
      // "Last Week" is exact match only
      else if (f.date === "Last Week") {
        matches = relDate === "Last Week";
      }
      // "Last Month" is exact match only
      else if (f.date === "Last Month") {
        matches = relDate === "Last Month";
      }
      // Otherwise exact match (Today, Yesterday)
      else {
        matches = relDate === f.date;
      }

      if (matches) {
        if (item.type === 'session') {
          includedSessionIds.add(item.id);
        } else {
          includedTabIds.add(item.id);
          includedSessionIds.add(item.parentSessionId);
        }
      }
      return matches;
    });
  }

  // Update domain dropdown based on filtered tabs so far (only tabs, not sessions)
  const tabsForDomainDropdown = filtered.filter(item => item.type === 'tab');
  updateDomainDropdown(tabsForDomainDropdown);

  // Filter by domain (tab-level - need to keep parent sessions)
  // Matches both exact subdomain and root domain
  // e.g., selecting "wordpress.com" matches "wordpress.com", "stuff.wordpress.com", "more.wordpress.com"
  if (f.domain !== "all") {
    const matchingTabIds = new Set();
    const matchingSessionIds = new Set();

    filtered.forEach(item => {
      if (item.type === 'tab') {
        // Match if exact match OR if the selected domain is a root domain of the tab
        // (i.e., tab domain ends with ".{selected domain}" OR tab domain equals selected domain)
        const exactMatch = item.domain === f.domain;
        const subdomainMatch = f.domain && item.domain && item.domain.endsWith('.' + f.domain);

        if (exactMatch || subdomainMatch) {
          matchingTabIds.add(item.id);
          matchingSessionIds.add(item.parentSessionId);
        }
      }
    });

    filtered = filtered.filter(item => {
      if (item.type === 'session') {
        return matchingSessionIds.has(item.id);
      } else {
        return matchingTabIds.has(item.id);
      }
    });
  }

  // Filter by color (session-level)
  if (f.color !== "all") {
    filtered = filtered.filter(item => {
      let matches = false;

      if (f.color === "none") {
        // Filter for default color - check if it's the default or an rgb value
        const defaultColor = getDefaultSessionColor();
        matches = item.sessionColor === defaultColor ||
                  (item.sessionColor && item.sessionColor.startsWith('rgb'));
      } else {
        // Normal color matching
        matches = item.sessionColor === f.color;
      }

      if (matches) {
        if (item.type === 'session') {
          includedSessionIds.add(item.id);
        } else {
          includedTabIds.add(item.id);
          includedSessionIds.add(item.parentSessionId);
        }
      }
      return matches;
    });
  }

  // Search filter (can match session name or tab title/url)
  if (f.search) {
    const searchLower = f.search.toLowerCase();
    const matchingTabIds = new Set();
    const matchingSessionIds = new Set();

    filtered.forEach(item => {
      if (item.type === 'session') {
        if (item.sessionName.toLowerCase().includes(searchLower)) {
          matchingSessionIds.add(item.id);
        }
      } else if (item.type === 'tab') {
        if (item.title.toLowerCase().includes(searchLower) ||
            item.url.toLowerCase().includes(searchLower) ||
            item.sessionName.toLowerCase().includes(searchLower)) {
          matchingTabIds.add(item.id);
          matchingSessionIds.add(item.parentSessionId);
        }
      }
    });

    filtered = filtered.filter(item => {
      if (item.type === 'session') {
        return matchingSessionIds.has(item.id);
      } else {
        return matchingTabIds.has(item.id);
      }
    });
  }

  // Apply sort
  filtered = sortTabs(filtered, fullscreenData.sortConfig, fullscreenData.sessionSortConfig, fullscreenData.tabSortConfig);

  // Store and render
  fullscreenData.filteredTabs = filtered;
  renderFullScreenTable(filtered);

  // Update clear filters button visibility
  updateClearFiltersButton();
}

function sortTabs(items, sortConfig, sessionSortConfig, tabSortConfig) {
  // Hierarchical sorting: sort sessions first, then tabs within each session
  // This matches macOS Finder behavior where folders are sorted, then files within folders
  // Session sorting and tab sorting are independent - changing one doesn't reset the other

  // Separate sessions and tabs
  const sessions = items.filter(item => item.type === 'session');
  const tabs = items.filter(item => item.type === 'tab');

  // Helper function to compare values
  const compareValues = (valA, valB, column, direction) => {
    // Handle different types
    if (column === "dateCreated") {
      valA = valA.getTime();
      valB = valB.getTime();
    } else if (typeof valA === "string") {
      valA = valA.toLowerCase();
      valB = valB.toLowerCase();
    } else if (typeof valA === "boolean") {
      valA = valA ? 1 : 0;
      valB = valB ? 1 : 0;
    }

    let result = 0;
    if (valA < valB) result = -1;
    else if (valA > valB) result = 1;

    return direction === "asc" ? result : -result;
  };

  // Sort sessions using sessionSortConfig (preserves session order when sorting by domain)
  const sortedSessions = sessions.sort((a, b) => {
    let valA, valB;

    // Map column names to session properties
    if (sessionSortConfig.column === 'title') {
      // Sessions don't have title, use sessionName instead
      valA = a.sessionName;
      valB = b.sessionName;
    } else {
      valA = a[sessionSortConfig.column];
      valB = b[sessionSortConfig.column];
    }

    return compareValues(valA, valB, sessionSortConfig.column, sessionSortConfig.direction);
  });

  // Build result: for each sorted session, add session then its sorted tabs
  const result = [];
  sortedSessions.forEach(session => {
    result.push(session);

    // Get tabs for this session
    const sessionTabs = tabs.filter(tab => tab.parentSessionId === session.id);

    // Sort tabs within session using tabSortConfig (preserves tab order when sorting by session columns)
    const sortedSessionTabs = sessionTabs.sort((a, b) => {
      let valA = a[tabSortConfig.column];
      let valB = b[tabSortConfig.column];

      return compareValues(valA, valB, tabSortConfig.column, tabSortConfig.direction);
    });

    result.push(...sortedSessionTabs);
  });

  return result;
}

// Helper function to normalize color names to canonical hex values
function normalizeSessionColor(color) {
  if (!color) {
    return getComputedStyle(document.documentElement).getPropertyValue('--text-secondary').trim();
  }

  // If already hex, return as-is
  if (color.startsWith('#')) {
    return color;
  }

  // Map color names to canonical hex values
  const colorNameToHex = {
    'blue': '#007AFF',
    'green': '#53b559',
    'yellow': '#ffc400',
    'orange': '#fa6a22',
    'red': '#FF0000',
    'pink': '#ff66ad',
    'purple': '#924ff6'
  };

  return colorNameToHex[color] || color;
}

function renderFullScreenTable(items) {
  const tbody = document.getElementById("fullscreen-table-body");
  if (!tbody) return;

  tbody.innerHTML = "";

  if (items.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" class="empty-state">
          No results
        </td>
      </tr>
    `;
    return;
  }

  items.forEach(item => {
    if (item.type === 'session') {
      // Render session row
      renderSessionRow(tbody, item);
    } else if (item.type === 'tab') {
      // Only render tab if parent session is expanded
      const isExpanded = !fullscreenData.collapsedSessions.has(item.parentSessionId);
      if (isExpanded) {
        renderTabRow(tbody, item);
      }
    }
  });

  // Update bulk actions bar
  updateBulkActionsBar();

  // Set indeterminate state for filtered session checkboxes that are checked
  const filteredSessionCheckboxes = tbody.querySelectorAll('.session-checkbox[data-is-filtered="true"]:checked');
  filteredSessionCheckboxes.forEach(checkbox => {
    checkbox.indeterminate = true;
  });
}

function renderSessionRow(tbody, session) {
  const row = document.createElement("tr");
  row.dataset.tabId = session.id;
  row.dataset.type = "session";
  row.classList.add("session-row");

  if (fullscreenData.selectedTabIds.has(session.id)) {
    row.classList.add("selected");
  }

  const isExpanded = !fullscreenData.collapsedSessions.has(session.id);
  const displayColor = normalizeSessionColor(session.sessionColor);

  // Determine if session has a custom color (not default/none)
  // Custom colors are named colors (blue, green, etc.) or hex values
  // Exclude the default text-secondary colors (#8B949E dark, #6E6E73/#555 light)
  const hasCustomSessionColor = session.sessionColor &&
                                 session.sessionColor !== 'none' &&
                                 !session.sessionColor.startsWith('rgb') &&
                                 session.sessionColor.toLowerCase() !== '#8b949e' &&
                                 session.sessionColor.toLowerCase() !== '#6e6e73' &&
                                 session.sessionColor.toLowerCase() !== '#555' &&
                                 session.sessionColor.toLowerCase() !== '#555555';

  // Calculate filtered tab count for this session
  const filteredTabCount = fullscreenData.filteredTabs.filter(
    item => item.type === 'tab' && item.parentSessionId === session.id
  ).length;
  const totalTabCount = session.tabCount;
  const hasActiveFilters = fullscreenData.filters.domain !== 'all' ||
                           fullscreenData.filters.color !== 'all' ||
                           fullscreenData.filters.date !== 'all' ||
                           fullscreenData.filters.search !== '';

  // Show "X of Y tabs" when filtered, otherwise just "X tabs" (localized)
  const tabWord = (count) => count === 1
    ? (getMessage('tabSingular') || 'tab')
    : (getMessage('tabPlural') || 'tabs');

  let tabCountDisplay;
  if (hasActiveFilters && filteredTabCount !== totalTabCount) {
    const template = getMessage('tabCountOfTotal') || '$1 of $2 $3';
    tabCountDisplay = template
      .replace('$1', filteredTabCount)
      .replace('$2', totalTabCount)
      .replace('$3', tabWord(totalTabCount));
  } else {
    tabCountDisplay = `${totalTabCount} ${tabWord(totalTabCount)}`;
  }

  // Chevron icon for expand/collapse
  const chevronIcon = isExpanded
    ? '<svg width="12" height="12" viewBox="0 0 12 12" class="chevron-icon expanded"><path fill="currentColor" d="M6 8L2 4h8z"/></svg>'
    : '<svg width="12" height="12" viewBox="0 0 12 12" class="chevron-icon"><path fill="currentColor" d="M4 2l4 4-4 4z"/></svg>';

  // Domain summary for collapsed sessions
  let domainSummary = '<span class="placeholder-text">—</span>';
  if (!isExpanded) {
    // Get all tabs for this session
    const sessionTabs = fullscreenData.filteredTabs.filter(
      item => item.type === 'tab' && item.parentSessionId === session.id
    );
    // Extract unique domains and sort alphabetically
    const uniqueDomains = [...new Set(sessionTabs.map(tab => tab.domain).filter(Boolean))].sort();
    if (uniqueDomains.length > 0) {
      const maxLength = 50;
      let domainText = uniqueDomains.join(', ');
      if (domainText.length > maxLength) {
        domainText = domainText.substring(0, maxLength).replace(/,\s*$/, '') + '…';
      }
      domainSummary = `<span class="domain-summary" title="${escapeHtml(uniqueDomains.join(', '))}">${escapeHtml(domainText)}</span>`;
    }
  }

  // Determine if this session has filtered tabs (for indeterminate checkbox state)
  const isFiltered = hasActiveFilters && filteredTabCount !== totalTabCount;
  const checkboxTitle = isFiltered
    ? `${filteredTabCount} ${tabWord(filteredTabCount)} (${totalTabCount} total)`
    : '';

  row.innerHTML = `
    <td class="col-checkbox" data-tab-id="${session.id}">
      <input type="checkbox"
             class="tab-checkbox session-checkbox"
             data-tab-id="${session.id}"
             data-is-filtered="${isFiltered}"
             ${checkboxTitle ? `title="${checkboxTitle}"` : ''}
             ${fullscreenData.selectedTabIds.has(session.id) ? "checked" : ""}>
    </td>
    <td class="col-title" data-session-id="${session.id}">
      <div class="session-title-wrapper">
        ${chevronIcon}
        <svg width="16" height="16" viewBox="0 0 35.3895 28.235" class="folder-icon">
          <g>
            <path ${hasCustomSessionColor ? `style="fill: ${displayColor} !important"` : ''} d="M4.60594 28.0803L30.7175 28.0803C33.4563 28.0803 35.0145 26.5183 35.0145 23.5127L35.0145 7.44156C35.0145 4.43594 33.4455 2.87875 30.4086 2.87875L14.7823 2.87875C13.5939 2.87875 12.9678 2.65781 12.1527 1.92781L11.2528 1.15625C10.2264 0.247344 9.51672 0 7.95047 0L4.02188 0C1.42797 0 0 1.41719 0 4.27203L0 23.5127C0 26.5436 1.55828 28.0803 4.60594 28.0803ZM2.51766 7.6886L2.51766 7.08C2.51766 6.06875 3.19438 5.39641 4.49703 5.39641L30.4792 5.39641C31.7711 5.39641 32.4538 6.06875 32.4538 7.08L32.4538 7.6886Z"/>
          </g>
        </svg>
        <span class="session-name ${session.sessionHasCustomName ? '' : 'default-name'}">${escapeHtml(session.sessionName)}</span>
        <svg class="edit-icon" width="14" height="14" viewBox="0 0 38.0391 37.2865" data-session-id="${session.id}">
           <g>
            <path d="M27.5173 5.40329L25.0977 7.82296L11.5195 7.82296C8.95703 7.82296 7.50391 9.27608 7.50391 11.8386L7.50391 26.4636C7.50391 29.0417 8.95703 30.4792 11.5195 30.4792L26.1445 30.4792C28.7227 30.4792 30.1602 29.0417 30.1602 26.4636L30.1602 13.0073L32.5907 10.5724C32.6491 10.9749 32.6758 11.4039 32.6758 11.8542L32.6758 26.4636C32.6758 30.6667 30.3477 32.9948 26.1445 32.9948L11.5195 32.9948C7.33203 32.9948 4.98828 30.6667 4.98828 26.4636L4.98828 11.8542C4.98828 7.65108 7.33203 5.30733 11.5195 5.30733L26.1445 5.30733C26.6282 5.30733 27.087 5.33837 27.5173 5.40329Z" fill="currentColor"/>
            <path d="M15.582 22.8698L18.6289 21.5417L33.2227 6.96358L31.082 4.85421L16.5039 19.4323L15.0977 22.3698C14.9727 22.6355 15.2852 22.9948 15.582 22.8698ZM34.3789 5.82296L35.5039 4.66671C36.0352 4.10421 36.0352 3.35421 35.5039 2.83858L35.1445 2.46358C34.6602 1.97921 33.8945 2.04171 33.3789 2.54171L32.2383 3.66671Z" fill="currentColor"/>
           </g>
          </svg>

        <span class="tab-count">${tabCountDisplay}</span>
      </div>
    </td>
    <td class="col-domain">${domainSummary}</td>
    <td class="col-date">${escapeHtml(formatDateForTable(session.dateCreated))}</td>
    <td class="col-color clickable-color" data-session-id="${session.id}" title="Change color">
      <span class="color-dot" style="background-color: ${displayColor}"></span>
    </td>
    <td class="col-lock clickable-icon" data-session-id="${session.id}" data-session-index="${session.sessionIndex}" data-action="toggle-lock">
      ${session.sessionLocked
        ? `<svg class="lock-icon locked" viewBox="0 0 21.5869 31.1647" width="16" height="16"${hasCustomSessionColor ? ` style="color: ${displayColor} !important"` : ''}><path d="M3.31703 30.3269L17.8948 30.3269C19.9931 30.3269 21.2119 29.0672 21.2119 26.8213L21.2119 15.6584C21.2119 13.4125 19.9931 12.1636 17.8948 12.1636L3.31703 12.1636C1.21875 12.1636 0 13.4125 0 15.6584L0 26.8213C0 29.0672 1.21875 30.3269 3.31703 30.3269ZM2.7925 13.0809L4.71985 13.0809L4.71985 8.31313C4.71985 4.23516 7.2936 1.83141 10.5981 1.83141C13.8978 1.83141 16.5028 4.23516 16.5028 8.31313L16.5028 13.0809L18.4145 13.0809L18.4145 8.52125C18.4145 3.01922 14.842 0 10.5981 0C6.36985 0 2.7925 3.01922 2.7925 8.52125Z" fill="currentColor"/></svg>`
        : `<svg class="lock-icon unlocked" viewBox="0 0 21.5869 31.1238" width="16" height="16"${hasCustomSessionColor ? ` style="color: ${displayColor} !important"` : ''}><g><path d="M3.31703 30.3113L17.8948 30.3113C19.9931 30.3113 21.2119 29.0516 21.2119 26.8056L21.2119 15.6477C21.2119 13.4077 19.9931 12.1528 17.8948 12.1528L3.31703 12.1528C1.21875 12.1528 0 13.4077 0 15.6477L0 26.8056C0 29.0516 1.21875 30.3113 3.31703 30.3113ZM3.34188 28.4798C2.50047 28.4798 1.95485 27.8836 1.95485 26.9339L1.95485 15.5194C1.95485 14.5648 2.50047 13.9794 3.34188 13.9794L17.87 13.9794C18.7222 13.9794 19.2522 14.5648 19.2522 15.5194L19.2522 26.9339C19.2522 27.8836 18.7222 28.4798 17.87 28.4798ZM2.7925 13.0653L4.71985 13.0653L4.71985 8.30828C4.71985 4.22438 7.2936 1.82657 10.5981 1.82657C13.8978 1.82657 16.5028 4.22438 16.5028 8.30828L16.5028 13.0653L18.4145 13.0653L18.4145 8.50563C18.4145 3.00844 14.842 0 10.5981 0C6.36985 0 2.7925 3.00844 2.7925 8.50563Z" fill="currentColor"/></g></svg>`
      }
    </td>
    <td class="col-pinned clickable-icon" data-session-id="${session.id}" data-session-index="${session.sessionIndex}" data-action="toggle-pin">
      ${session.sessionPinned
        ? `<svg class="pin-icon pinned" viewBox="0 0 23.6864 36.9547" width="16" height="16"${hasCustomSessionColor ? ` style="color: ${displayColor} !important"` : ''}><path d="M0 23.1814C0 24.3206 0.788907 25.0745 2.03047 25.0745L10.5417 25.0745L10.5417 33.3208C10.5417 35.2852 11.3383 36.9547 11.6611 36.9547C11.978 36.9547 12.7745 35.2852 12.7745 33.3208L12.7745 25.0745L21.2809 25.0745C22.5225 25.0745 23.3114 24.3206 23.3114 23.1814C23.3114 19.8458 20.6805 16.4825 16.4255 14.9808L15.9244 7.71203C17.9005 6.54594 19.7755 5.09172 20.5928 3.99641C20.9506 3.51844 21.1392 3.04531 21.1392 2.63469C21.1392 1.79297 20.492 1.17219 19.5097 1.17219L3.8125 1.17219C2.81937 1.17219 2.18297 1.79297 2.18297 2.63469C2.18297 3.04531 2.36078 3.51844 2.71859 3.99641C3.54078 5.09172 5.41578 6.55078 7.38703 7.71203L6.88594 14.9808C2.63094 16.4825 0 19.8458 0 23.1814Z" fill="currentColor"/></svg>`
        : `<svg class="pin-icon unpinned" viewBox="0 0 23.6864 36.9547" width="16" height="16"${hasCustomSessionColor ? ` style="color: ${displayColor} !important"` : ''}><path d="M11.6611 36.9547C11.978 36.9547 12.7745 35.2852 12.7745 33.3208L12.7745 24.1081L10.5417 24.1081L10.5417 33.3208C10.5417 35.2852 11.3383 36.9547 11.6611 36.9547ZM2.03047 25.0745L21.2809 25.0745C22.5225 25.0745 23.3114 24.3206 23.3114 23.1814C23.3114 18.6313 18.3995 14.1989 11.6611 14.1989C4.91672 14.1989 0 18.6313 0 23.1814C0 24.3206 0.788907 25.0745 2.03047 25.0745ZM2.44235 23.248C2.07329 23.248 1.87829 23.0255 1.92141 22.6133C2.14891 19.3455 6.07203 15.9764 11.6611 15.9764C17.2394 15.9764 21.1625 19.3455 21.39 22.6133C21.4331 23.0255 21.243 23.248 20.8691 23.248ZM2.18297 2.63469C2.18297 3.02484 2.35594 3.49313 2.70406 3.96625C3.50094 5.07234 5.40609 6.54594 7.18109 7.71203L6.63203 15.8361L8.55079 15.8361L9.11922 6.87547C9.13485 6.67609 9.10844 6.60281 8.97157 6.52953C6.79735 5.37969 4.74751 3.70109 4.6661 3.23844C4.58469 3.03531 4.7 2.90063 4.91063 2.90063L18.4056 2.90063C18.6114 2.90063 18.7267 3.03531 18.6453 3.23844C18.5639 3.70109 16.5141 5.37969 14.3447 6.52953C14.2138 6.60281 14.1766 6.67609 14.2078 6.87547L14.7606 15.8361L16.6842 15.8361L16.1303 7.71203C17.9161 6.54594 19.8105 5.07234 20.6074 3.96625C20.9663 3.49313 21.1392 3.02484 21.1392 2.63469C21.1392 1.79297 20.492 1.17219 19.5097 1.17219L3.8125 1.17219C2.81937 1.17219 2.18297 1.79297 2.18297 2.63469Z" fill="currentColor"/></svg>`
      }
    </td>
  `;

  tbody.appendChild(row);
}

function renderTabRow(tbody, tab) {
  const row = document.createElement("tr");
  row.dataset.tabId = tab.id;
  row.dataset.type = "tab";
  row.classList.add("tab-row");

  if (fullscreenData.selectedTabIds.has(tab.id)) {
    row.classList.add("selected");
  }

  // Normalize color to canonical hex value
  const displayColor = normalizeSessionColor(tab.sessionColor);
  const hasCustomSessionColor = tab.sessionColor &&
                                 tab.sessionColor !== 'none' &&
                                 !tab.sessionColor.startsWith('rgb') &&
                                 tab.sessionColor.toLowerCase() !== '#8b949e' &&
                                 tab.sessionColor.toLowerCase() !== '#6e6e73' &&
                                 tab.sessionColor.toLowerCase() !== '#555' &&
                                 tab.sessionColor.toLowerCase() !== '#555555';

  row.innerHTML = `
    <td class="col-checkbox" data-tab-id="${tab.id}">
      <input type="checkbox"
             class="tab-checkbox"
             data-tab-id="${tab.id}"
             ${fullscreenData.selectedTabIds.has(tab.id) ? "checked" : ""}>
    </td>
    <td class="col-title">
      <img src="${tab.favicon}" class="favicon" width="16" height="16" onerror="this.src='${chrome.runtime.getURL('images/icon-128.png')}'">
      <a href="${escapeHtml(tab.url)}" class="title-link" target="_blank" rel="noopener noreferrer">${escapeHtml(tab.title)}</a>
    </td>
    <td class="col-domain">
      <a href="https://${escapeHtml(tab.domain)}" class="domain-link" target="_blank" rel="noopener noreferrer">${escapeHtml(tab.domain)}</a>
    </td>
    <td class="col-date">${escapeHtml(formatDateForTable(tab.dateCreated))}</td>
    <td class="col-color">
      <span class="color-dot" style="background-color: ${displayColor}"></span>
    </td>
    <td class="col-lock">
      ${tab.sessionLocked
        ? `<svg class="lock-icon locked" viewBox="0 0 21.5869 31.1647" width="16" height="16"${hasCustomSessionColor ? ` style="color: ${displayColor} !important"` : ''}><path d="M3.31703 30.3269L17.8948 30.3269C19.9931 30.3269 21.2119 29.0672 21.2119 26.8213L21.2119 15.6584C21.2119 13.4125 19.9931 12.1636 17.8948 12.1636L3.31703 12.1636C1.21875 12.1636 0 13.4125 0 15.6584L0 26.8213C0 29.0672 1.21875 30.3269 3.31703 30.3269ZM2.7925 13.0809L4.71985 13.0809L4.71985 8.31313C4.71985 4.23516 7.2936 1.83141 10.5981 1.83141C13.8978 1.83141 16.5028 4.23516 16.5028 8.31313L16.5028 13.0809L18.4145 13.0809L18.4145 8.52125C18.4145 3.01922 14.842 0 10.5981 0C6.36985 0 2.7925 3.01922 2.7925 8.52125Z" fill="currentColor"/></svg>`
        : `<svg class="lock-icon unlocked" viewBox="0 0 21.5869 31.1238" width="16" height="16"${hasCustomSessionColor ? ` style="color: ${displayColor} !important"` : ''}><g><path d="M3.31703 30.3113L17.8948 30.3113C19.9931 30.3113 21.2119 29.0516 21.2119 26.8056L21.2119 15.6477C21.2119 13.4077 19.9931 12.1528 17.8948 12.1528L3.31703 12.1528C1.21875 12.1528 0 13.4077 0 15.6477L0 26.8056C0 29.0516 1.21875 30.3113 3.31703 30.3113ZM3.34188 28.4798C2.50047 28.4798 1.95485 27.8836 1.95485 26.9339L1.95485 15.5194C1.95485 14.5648 2.50047 13.9794 3.34188 13.9794L17.87 13.9794C18.7222 13.9794 19.2522 14.5648 19.2522 15.5194L19.2522 26.9339C19.2522 27.8836 18.7222 28.4798 17.87 28.4798ZM2.7925 13.0653L4.71985 13.0653L4.71985 8.30828C4.71985 4.22438 7.2936 1.82657 10.5981 1.82657C13.8978 1.82657 16.5028 4.22438 16.5028 8.30828L16.5028 13.0653L18.4145 13.0653L18.4145 8.50563C18.4145 3.00844 14.842 0 10.5981 0C6.36985 0 2.7925 3.00844 2.7925 8.50563Z" fill="currentColor"/></g></svg>`
      }
    </td>
    <td class="col-pinned">
      ${tab.sessionPinned
        ? `<svg class="pin-icon pinned" viewBox="0 0 23.6864 36.9547" width="16" height="16"${hasCustomSessionColor ? ` style="color: ${displayColor} !important"` : ''}><path d="M0 23.1814C0 24.3206 0.788907 25.0745 2.03047 25.0745L10.5417 25.0745L10.5417 33.3208C10.5417 35.2852 11.3383 36.9547 11.6611 36.9547C11.978 36.9547 12.7745 35.2852 12.7745 33.3208L12.7745 25.0745L21.2809 25.0745C22.5225 25.0745 23.3114 24.3206 23.3114 23.1814C23.3114 19.8458 20.6805 16.4825 16.4255 14.9808L15.9244 7.71203C17.9005 6.54594 19.7755 5.09172 20.5928 3.99641C20.9506 3.51844 21.1392 3.04531 21.1392 2.63469C21.1392 1.79297 20.492 1.17219 19.5097 1.17219L3.8125 1.17219C2.81937 1.17219 2.18297 1.79297 2.18297 2.63469C2.18297 3.04531 2.36078 3.51844 2.71859 3.99641C3.54078 5.09172 5.41578 6.55078 7.38703 7.71203L6.88594 14.9808C2.63094 16.4825 0 19.8458 0 23.1814Z" fill="currentColor"/></svg>`
        : `<svg class="pin-icon unpinned" viewBox="0 0 23.6864 36.9547" width="16" height="16"${hasCustomSessionColor ? ` style="color: ${displayColor} !important"` : ''}><path d="M11.6611 36.9547C11.978 36.9547 12.7745 35.2852 12.7745 33.3208L12.7745 24.1081L10.5417 24.1081L10.5417 33.3208C10.5417 35.2852 11.3383 36.9547 11.6611 36.9547ZM2.03047 25.0745L21.2809 25.0745C22.5225 25.0745 23.3114 24.3206 23.3114 23.1814C23.3114 18.6313 18.3995 14.1989 11.6611 14.1989C4.91672 14.1989 0 18.6313 0 23.1814C0 24.3206 0.788907 25.0745 2.03047 25.0745ZM2.44235 23.248C2.07329 23.248 1.87829 23.0255 1.92141 22.6133C2.14891 19.3455 6.07203 15.9764 11.6611 15.9764C17.2394 15.9764 21.1625 19.3455 21.39 22.6133C21.4331 23.0255 21.243 23.248 20.8691 23.248ZM2.18297 2.63469C2.18297 3.02484 2.35594 3.49313 2.70406 3.96625C3.50094 5.07234 5.40609 6.54594 7.18109 7.71203L6.63203 15.8361L8.55079 15.8361L9.11922 6.87547C9.13485 6.67609 9.10844 6.60281 8.97157 6.52953C6.79735 5.37969 4.74751 3.70109 4.6661 3.23844C4.58469 3.03531 4.7 2.90063 4.91063 2.90063L18.4056 2.90063C18.6114 2.90063 18.7267 3.03531 18.6453 3.23844C18.5639 3.70109 16.5141 5.37969 14.3447 6.52953C14.2138 6.60281 14.1766 6.67609 14.2078 6.87547L14.7606 15.8361L16.6842 15.8361L16.1303 7.71203C17.9161 6.54594 19.8105 5.07234 20.6074 3.96625C20.9663 3.49313 21.1392 3.02484 21.1392 2.63469C21.1392 1.79297 20.492 1.17219 19.5097 1.17219L3.8125 1.17219C2.81937 1.17219 2.18297 1.79297 2.18297 2.63469Z" fill="currentColor"/></svg>`
      }
    </td>
  `;

  tbody.appendChild(row);
}

function updateBulkActionsBar() {
  const bulkRestore = document.getElementById("bulk-restore");
  const bulkCreateGroup = document.getElementById("bulk-create-group");
  const bulkTrash = document.getElementById("bulk-trash");
  const toolbarCopyBtn = document.getElementById("toolbar-copy-btn");
  const toolbarSaveRoutineBtn = document.getElementById("toolbar-save-routine-btn");
  const bulkDuplicate = document.getElementById("bulk-duplicate");
  const toolbarLockBtn = document.getElementById("toolbar-lock-unlock-all");
  const resetColorsBtn = document.getElementById("toolbar-reset-colors-btn");

  if (!bulkRestore || !bulkCreateGroup || !bulkTrash) return;

  // Get selected tabs (only visible/filtered, excluding session items)
  const selectedTabs = fullscreenData.filteredTabs.filter(item =>
    item.type === 'tab' && fullscreenData.selectedTabIds.has(item.id)
  );
  const visibleSelectedCount = selectedTabs.length;


  // Check if any selected tabs are in locked sessions
  const hasLockedTabs = selectedTabs.some(tab => tab.sessionLocked);


  // Actions menu button follows selection state (like other toolbar buttons)
  // Individual menu items inside no longer need their own disabled logic

  if (visibleSelectedCount > 0) {
    // Get base text from localization (use getMessage wrapper for custom language support)
    const restoreBase = getMessage("bulkActionRestore") || "Restore";
    const createGroupBase = getMessage("bulkActionCreateGroup") || "Merge";
    const trashBase = getMessage("draftDelete") || "Delete";
    const duplicateBase = getMessage("bulkActionDuplicate") || "Duplicate";

    // Restore is always enabled when tabs are selected
    bulkRestore.disabled = false;
    bulkRestore.title = `${restoreBase} (${visibleSelectedCount})`;
    bulkRestore.setAttribute('aria-label', `${restoreBase} (${visibleSelectedCount})`);

    // Copy button is enabled when tabs are selected
    if (toolbarCopyBtn) {
      toolbarCopyBtn.disabled = false;
    }

    // Export button is enabled when tabs are selected
    const toolbarExportBtn = document.getElementById("toolbar-export-btn");
    if (toolbarExportBtn) {
      toolbarExportBtn.disabled = false;
    }

    // Save as Routine button - always enabled when tabs are selected
    if (toolbarSaveRoutineBtn) {
      toolbarSaveRoutineBtn.disabled = false;
    }

    // Duplicate is always enabled when tabs are selected
    if (bulkDuplicate) {
      bulkDuplicate.disabled = false;
      bulkDuplicate.title = `${duplicateBase} (${visibleSelectedCount})`;
      bulkDuplicate.setAttribute('aria-label', `${duplicateBase} (${visibleSelectedCount})`);
    }

    // Lock/Unlock is always enabled when tabs are selected
    if (toolbarLockBtn) {
      // Count unique selected sessions (only sessions can be locked)
      const selectedSessionIds = new Set();
      selectedTabs.forEach(tab => {
        if (tab.sessionTimestamp) selectedSessionIds.add(tab.sessionTimestamp);
      });
      const sessionCount = selectedSessionIds.size;
      // Check if all selected sessions are locked
      const allSelectedLocked = savedSessions && savedSessions
        .filter(s => selectedSessionIds.has(s.timestamp))
        .every(s => s.locked);
      const lockLabel = allSelectedLocked
        ? getMessage('unlockSession') || 'Unlock'
        : getMessage('lockSession') || 'Lock';
      toolbarLockBtn.disabled = false;
      toolbarLockBtn.title = `${lockLabel} (${sessionCount})`;
      toolbarLockBtn.setAttribute('aria-label', `${lockLabel} (${sessionCount})`);
    }

    // Reset Colors is enabled only if selected sessions have colors
    if (resetColorsBtn) {
      // Get unique session IDs from selected items
      const selectedSessionIds = new Set();
      selectedTabs.forEach(tab => {
        if (tab.type === 'session') {
          selectedSessionIds.add(tab.timestamp);
        } else if (tab.type === 'tab') {
          selectedSessionIds.add(tab.sessionTimestamp);
        }
      });

      // Check if any selected sessions have colors
      const hasColors = savedSessions.some(session =>
        selectedSessionIds.has(session.timestamp) && session.color
      );

      resetColorsBtn.disabled = !hasColors;
    }

    // Merge and Trash are disabled if any selected tabs are locked
    if (hasLockedTabs) {
      bulkCreateGroup.disabled = true;
      bulkTrash.disabled = true;
      bulkCreateGroup.title = createGroupBase;
      bulkCreateGroup.setAttribute('aria-label', createGroupBase);
      bulkTrash.title = trashBase;
      bulkTrash.setAttribute('aria-label', trashBase);
    } else {
      bulkCreateGroup.disabled = false;
      bulkTrash.disabled = false;
      bulkCreateGroup.title = `${createGroupBase} (${visibleSelectedCount})`;
      bulkCreateGroup.setAttribute('aria-label', `${createGroupBase} (${visibleSelectedCount})`);
      bulkTrash.title = `${trashBase} (${visibleSelectedCount})`;
      bulkTrash.setAttribute('aria-label', `${trashBase} (${visibleSelectedCount})`);
    }
  } else {
    // Disable all buttons when nothing is selected
    bulkRestore.disabled = true;
    bulkCreateGroup.disabled = true;
    bulkTrash.disabled = true;

    const restoreBase = getMessage("bulkActionRestore") || "Restore";
    const createGroupBase = getMessage("bulkActionCreateGroup") || "Merge";
    const trashBase = getMessage("draftDelete") || "Delete";
    const duplicateBase = getMessage("bulkActionDuplicate") || "Duplicate";

    bulkRestore.title = restoreBase;
    bulkRestore.setAttribute('aria-label', restoreBase);
    bulkCreateGroup.title = createGroupBase;
    bulkCreateGroup.setAttribute('aria-label', createGroupBase);
    bulkTrash.title = trashBase;
    bulkTrash.setAttribute('aria-label', trashBase);

    // Disable Copy button
    if (toolbarCopyBtn) {
      toolbarCopyBtn.disabled = true;
    }

    // Disable Export button
    const toolbarExportBtn = document.getElementById("toolbar-export-btn");
    if (toolbarExportBtn) {
      toolbarExportBtn.disabled = true;
    }

    // Disable Save as Routine button
    if (toolbarSaveRoutineBtn) {
      toolbarSaveRoutineBtn.disabled = true;
    }

    if (bulkDuplicate) {
      bulkDuplicate.disabled = true;
      bulkDuplicate.title = duplicateBase;
      bulkDuplicate.setAttribute('aria-label', duplicateBase);
    }

    // Disable Lock/Unlock button
    if (toolbarLockBtn) {
      const lockUnlockBase = (getMessage('lockSession') || 'Lock') + '/' + (getMessage('unlockSession') || 'Unlock');
      toolbarLockBtn.disabled = true;
      toolbarLockBtn.title = lockUnlockBase;
      toolbarLockBtn.setAttribute('aria-label', lockUnlockBase);
    }

    // Disable Reset Colors button
    if (resetColorsBtn) {
      resetColorsBtn.disabled = true;
    }
  }
}

function updateSelectAllCheckbox() {
  const selectAllCheckbox = document.getElementById("header-select-all");
  if (!selectAllCheckbox) return;

  const visibleCount = fullscreenData.filteredTabs.length;

  // Count only visible tabs that are selected
  const visibleSelectedCount = fullscreenData.filteredTabs.filter(tab =>
    fullscreenData.selectedTabIds.has(tab.id)
  ).length;

  if (visibleSelectedCount === 0) {
    selectAllCheckbox.checked = false;
    selectAllCheckbox.indeterminate = false;
  } else if (visibleSelectedCount === visibleCount && visibleCount > 0) {
    selectAllCheckbox.checked = true;
    selectAllCheckbox.indeterminate = false;
  } else {
    selectAllCheckbox.checked = false;
    selectAllCheckbox.indeterminate = true;
  }
}

// Update session checkboxes to show indeterminate state when some (but not all) tabs are selected
function updateSessionCheckboxes() {
  // Get all session items from filtered tabs
  const sessions = fullscreenData.filteredTabs.filter(item => item.type === 'session');

  sessions.forEach(session => {
    const sessionCheckbox = document.querySelector(`.session-checkbox[data-tab-id="${session.id}"]`);
    if (!sessionCheckbox) return;

    // Find all tabs that belong to this session (visible in filtered tabs)
    const sessionTabs = fullscreenData.filteredTabs.filter(
      item => item.type === 'tab' && item.parentSessionId === session.id
    );

    if (sessionTabs.length === 0) return;

    // Count how many tabs in this session are selected
    const selectedCount = sessionTabs.filter(tab =>
      fullscreenData.selectedTabIds.has(tab.id)
    ).length;

    // Update checkbox state
    if (selectedCount === 0) {
      sessionCheckbox.checked = false;
      sessionCheckbox.indeterminate = false;
      fullscreenData.selectedTabIds.delete(session.id);
    } else if (selectedCount === sessionTabs.length) {
      sessionCheckbox.checked = true;
      sessionCheckbox.indeterminate = false;
      fullscreenData.selectedTabIds.add(session.id);
    } else {
      // Some but not all tabs selected - show indeterminate state
      sessionCheckbox.checked = false;
      sessionCheckbox.indeterminate = true;
      fullscreenData.selectedTabIds.delete(session.id);
    }

    // Update row selection visual
    const sessionRow = sessionCheckbox.closest('tr');
    if (sessionRow) {
      if (selectedCount === sessionTabs.length) {
        sessionRow.classList.add('selected');
      } else {
        sessionRow.classList.remove('selected');
      }
    }
  });
}

function handleBulkRestore(event) {
  const selectedTabs = getSelectedTabs();
  if (selectedTabs.length === 0) return;

  // Check if shift key was held (to invert deleteAfterRestore setting)
  const invertDelete = event && event.shiftKey;

  chrome.storage.local.get(['deleteAfterRestore', 'savedSessions', 'opentabsBackground'], (result) => {
    let effectiveDelete = !!result.deleteAfterRestore;
    if (invertDelete) {
      effectiveDelete = !effectiveDelete;
    }

    // Respect opentabsBackground setting
    const openInBackground = result.opentabsBackground !== false;

    // Open all selected tabs
    selectedTabs.forEach(tab => {
      chrome.tabs.create({ url: tab.url, active: !openInBackground });
    });

    // If deleteAfterRestore is enabled, remove the tabs from their sessions
    if (effectiveDelete) {
      let savedSessions = result.savedSessions || [];

      // Group tabs by their parent session
      const tabsBySession = new Map();
      selectedTabs.forEach(tab => {
        if (tab.type === 'tab' && tab.parentSessionId) {
          if (!tabsBySession.has(tab.parentSessionId)) {
            tabsBySession.set(tab.parentSessionId, new Set());
          }
          tabsBySession.get(tab.parentSessionId).add(tab.url);
        }
      });

      // Remove tabs from their sessions (skip locked sessions)
      savedSessions = savedSessions.map(session => {
        const sessionId = `session-${session.timestamp}`;
        if (tabsBySession.has(sessionId) && !session.locked) {
          const urlsToRemove = tabsBySession.get(sessionId);
          session.tabs = session.tabs.filter(tab => !urlsToRemove.has(tab.url));
        }
        return session;
      }).filter(session => session.tabs.length > 0); // Remove empty sessions

      // Save updated sessions
      isUpdatingFromStorage = true;
      chrome.storage.local.set({ savedSessions }, () => {
        // Update advanced mode data
        fullscreenData.allTabs = transformSessionsToTabs(savedSessions);
        fullscreenData.selectedTabIds.clear();
        applyFiltersAndRender();
        updateSelectAllCheckbox();
        setTimeout(() => { isUpdatingFromStorage = false; }, 100);

        // Refresh badge
        refreshBadge();
      });
    } else {
      // Just clear selection without deleting
      fullscreenData.selectedTabIds.clear();
      applyFiltersAndRender();
      updateSelectAllCheckbox();
    }
  });
}

function handleBulkCreateGroup() {
  const selectedTabs = getSelectedTabs();
  if (selectedTabs.length === 0) return;

  // Filter to only include actual tabs (not session rows)
  const actualTabs = selectedTabs.filter(item => item.type === 'tab');
  if (actualTabs.length === 0) return;

  debug('[handleBulkCreateGroup] Merging', actualTabs.length, 'tabs');

  // Get savedSessions from storage to ensure we have latest data
  chrome.storage.local.get(['savedSessions'], (result) => {
    savedSessions = result.savedSessions || [];

    // Store information for undo
    const mergedTabsData = [];
    const deletedSessionsData = [];

    // Create a new session with the selected tabs
    const newSession = {
      timestamp: new Date().toISOString(),
      defaultTitle: "Merged Tabs",
      tabs: actualTabs.map(tab => ({
        url: tab.url,
        title: tab.title
      }))
    };

    // Remove selected tabs from their original sessions
    // Group actual tabs by session
    const tabsBySession = new Map();
    actualTabs.forEach(tab => {
      if (!tabsBySession.has(tab.sessionIndex)) {
        tabsBySession.set(tab.sessionIndex, []);
      }
      tabsBySession.get(tab.sessionIndex).push(tab.tabIndex);
    });

    // Store original tabs for undo
    tabsBySession.forEach((tabIndices, sessionIndex) => {
      const session = savedSessions[sessionIndex];
      if (!session) return;

      tabIndices.forEach(tabIndex => {
        mergedTabsData.push({
          sessionIndex,
          sessionTimestamp: session.timestamp,
          tabIndex,
          tab: { ...session.tabs[tabIndex] }
        });
      });
    });

    // Process sessions in descending order to avoid index shifting when removing empty sessions
    const sessionIndices = Array.from(tabsBySession.keys()).sort((a, b) => b - a);

    sessionIndices.forEach(sessionIndex => {
      const session = savedSessions[sessionIndex];
      if (!session) return;

      const tabIndices = tabsBySession.get(sessionIndex);

      // Sort tab indices in descending order to avoid index shifting when removing tabs
      const sortedIndices = tabIndices.sort((a, b) => b - a);

      // Remove tabs
      sortedIndices.forEach(tabIndex => {
        session.tabs.splice(tabIndex, 1);
      });

      // If session is now empty, store it for undo and remove it
      if (session.tabs.length === 0) {
        deletedSessionsData.push({
          index: sessionIndex,
          session: { ...session },
          wasCollapsed: !!collapsedSessions[session.timestamp]
        });
        savedSessions.splice(sessionIndex, 1);
      }
    });

    // Add new merged session to savedSessions
    savedSessions.unshift(newSession);

    // Ensure the new merged session is expanded (not collapsed)
    delete collapsedSessions[newSession.timestamp];

    isUpdatingFromStorage = true;
    chrome.storage.local.set({ savedSessions, collapsedSessions }, () => {
      debug('[handleBulkCreateGroup] Saved, refreshing UI');

      // Highlight the new merged session
      highlightMergeSession(newSession.timestamp);

      // Clear selection
      fullscreenData.selectedTabIds.clear();

      // Ensure the new merged session is expanded in fullscreen mode
      const newSessionId = `session-${newSession.timestamp}`;
      if (!fullscreenData.collapsedSessions) {
        fullscreenData.collapsedSessions = new Set();
      }
      // Remove from collapsed set to ensure it's expanded (expanded is the default)
      fullscreenData.collapsedSessions.delete(newSessionId);
      saveCollapsedState(); // Persist the collapsed state

      if (viewMode === 'fullscreen') {
        fullscreenData.allTabs = transformSessionsToTabs(savedSessions);
        applyFiltersAndRender();
      } else {
        updateSessionList(savedSessions);
      }
      updateSelectAllCheckbox();
      refreshBadge();
      setTimeout(() => { isUpdatingFromStorage = false; }, 100);

      // Create undo operation
      const opId = "bulkMerge-" + Math.random().toString(36).substr(2, 8);
      pendingOperations[opId] = {
        type: "bulkMerge",
        newSessionTimestamp: newSession.timestamp,
        mergedTabs: mergedTabsData,
        deletedSessions: deletedSessionsData
      };

      debug('[handleBulkCreateGroup] Created undo operation:', opId);

      // Show undo bubble
      const message = actualTabs.length === 1
        ? getMessage("mergedOneTab") || "Merged 1 tab"
        : (getMessage("mergedMultipleTabs") || "Merged {count} tabs").replace("{count}", actualTabs.length);

      debug('[handleBulkCreateGroup] Showing undo bubble with message:', message);
      showUndoBubble(opId, message, '', { type: 'merge' });

      // Set timer to finalize
      const timerId = setTimeout(() => {
        finalizePendingOperation(opId);
      }, UNDO_TIMEOUT_MS);
      pendingOperations[opId].timerId = timerId;
    });
  });
}

function handleBulkTrash() {
  const selectedTabs = getSelectedTabs();
  if (selectedTabs.length === 0) return;

  debug('[handleBulkTrash] Starting bulk trash with', selectedTabs.length, 'tabs');

  // Get current trash AND savedSessions from storage to ensure we have latest data
  chrome.storage.local.get(['trashedLinks', 'savedSessions'], (result) => {
    let trashedLinks = result.trashedLinks || [];
    savedSessions = result.savedSessions || [];

    debug('[handleBulkTrash] Got from storage:', savedSessions.length, 'sessions,', trashedLinks.length, 'trashed items');

    const now = Date.now();
    const retentionMs = 30 * 24 * 60 * 60 * 1000; // 30 days

    // Store tabs to be deleted for undo operation
    const deletedTabData = [];
    const sessionsToDelete = new Set();

    // Group selected tabs by session
    const tabsBySession = new Map();
    selectedTabs.forEach(tab => {
      if (!tabsBySession.has(tab.sessionIndex)) {
        tabsBySession.set(tab.sessionIndex, []);
      }
      tabsBySession.get(tab.sessionIndex).push(tab.tabIndex);
    });

    debug('[handleBulkTrash] Grouped tabs by session:', tabsBySession);

    // Process each session and move tabs to trash
    tabsBySession.forEach((tabIndices, sessionIndex) => {
      const session = savedSessions[sessionIndex];
      if (!session) {
        debug('[handleBulkTrash] Session not found at index', sessionIndex);
        return;
      }

      debug('[handleBulkTrash] Processing session', sessionIndex, ':', session.customName || session.defaultTitle);

      const sessionName = session.customName || session.defaultTitle || "Untitled Session";
      const sessionTimestamp = session.timestamp;

      // Sort indices in descending order
      const sortedIndices = tabIndices.sort((a, b) => b - a);

      debug('[handleBulkTrash] Tab indices to delete:', sortedIndices);

      // Move each tab to trash and store for undo
      sortedIndices.forEach(tabIndex => {
        const tab = session.tabs[tabIndex];

        if (!tab) {
          debug('[handleBulkTrash] Tab not found at index', tabIndex, 'in session', sessionIndex);
          return;
        }

        debug('[handleBulkTrash] Moving tab to trash:', tab.title);

        // Create trash item
        const trashItem = {
          id: generateDeleteId(),
          url: tab.url,
          title: tab.title,
          originalSessionName: sessionName,
          sessionTimestamp: sessionTimestamp,
          trashedAt: now,
          expiresAt: now + retentionMs
        };
        const parsed = Date.parse(sessionTimestamp);
        if (!isNaN(parsed)) trashItem.originalSavedAt = parsed;
        trashedLinks.push(trashItem);

        // Store for undo
        deletedTabData.push({
          sessionIndex,
          tabIndex,
          tab: { ...tab },
          sessionTimestamp
        });

        // Remove tab from session
        session.tabs.splice(tabIndex, 1);
      });

      // Check if session is now empty
      if (session.tabs.length === 0) {
        sessionsToDelete.add(sessionIndex);
      }
    });

    // Remove empty sessions in descending order to avoid index shifting
    const sortedSessionIndices = Array.from(sessionsToDelete).sort((a, b) => b - a);
    const deletedSessions = [];
    sortedSessionIndices.forEach(sessionIndex => {
      deletedSessions.push({
        index: sessionIndex,
        session: { ...savedSessions[sessionIndex] },
        wasCollapsed: !!collapsedSessions[savedSessions[sessionIndex].timestamp]
      });
      savedSessions.splice(sessionIndex, 1);
    });

    // Save to storage
    isUpdatingFromStorage = true;
    chrome.storage.local.set({ savedSessions, trashedLinks }, () => {
      // Update UI
      fullscreenData.selectedTabIds.clear();
      if (viewMode === 'fullscreen') {
        fullscreenData.allTabs = transformSessionsToTabs(savedSessions);
        applyFiltersAndRender();
      } else {
        updateSessionList(savedSessions);
      }
      updateSelectAllCheckbox();
      refreshBadge();
      setTimeout(() => { isUpdatingFromStorage = false; }, 100);

      debug('[handleBulkTrash] Moved', deletedTabData.length, 'tabs to trash, deleted', deletedSessions.length, 'sessions');

      // Create undo operation
      const opId = "bulkDelete-" + Math.random().toString(36).substr(2, 8);
      pendingOperations[opId] = {
        type: "bulkDelete",
        deletedTabs: deletedTabData,
        deletedSessions: deletedSessions
      };

      debug('[handleBulkTrash] Created undo operation:', opId);

      // Show undo bubble
      const message = selectedTabs.length === 1
        ? getMessage("deletedOneTab") || "Deleted 1 tab"
        : (getMessage("deletedMultipleTabs") || "Deleted {count} tabs").replace("{count}", selectedTabs.length);

      debug('[handleBulkTrash] Showing undo bubble with message:', message);
      showUndoBubble(opId, message, '', { type: 'delete' });

      // Set timer to finalize
      const timerId = setTimeout(() => {
        finalizePendingOperation(opId);
      }, UNDO_TIMEOUT_MS);
      pendingOperations[opId].timerId = timerId;
    });
  });
}

function handleBulkCopy(format) {
  const selectedTabs = getSelectedTabs();
  if (selectedTabs.length === 0) return;

  debug('[handleBulkCopy] Copying', selectedTabs.length, 'tabs in format:', format);

  // Track which sessions are explicitly selected (session checkbox checked)
  const selectedSessionIds = new Set();
  fullscreenData.filteredTabs.forEach(item => {
    if (item.type === 'session' && fullscreenData.selectedTabIds.has(item.id)) {
      selectedSessionIds.add(item.id);
    }
  });

  // Group tabs by session
  const sessionMap = new Map();
  selectedTabs.forEach(tab => {
    const sessionId = `session-${tab.sessionTimestamp}`;
    if (!sessionMap.has(sessionId)) {
      // Include session name if the session row itself was selected
      const includeSessionName = selectedSessionIds.has(sessionId);
      sessionMap.set(sessionId, {
        timestamp: tab.sessionTimestamp,
        customName: includeSessionName ? tab.sessionName : null,
        defaultTitle: includeSessionName ? tab.sessionName : null,
        skipSessionHeader: !includeSessionName, // Flag to skip session header in export
        tabs: [],
        locked: tab.sessionLocked,
        pinned: tab.sessionPinned,
        color: tab.sessionColor
      });
    }
    sessionMap.get(sessionId).tabs.push({
      url: tab.url,
      title: tab.title,
      favicon: tab.favicon
    });
  });

  // Convert map to array of sessions
  const sessionsToCopy = Array.from(sessionMap.values());

  // Use existing copy logic
  if (format === "rich") {
    const htmlContent = generateHTMLExport(sessionsToCopy);
    const plainContent = generatePlainTextExport(sessionsToCopy);
    copyRichText(htmlContent, plainContent)
      .then(() => {
        debug('[handleBulkCopy] Successfully copied as rich text');
      })
      .catch(err => {
        debug('Failed to copy rich text to clipboard:', err);
      });
  } else {
    let copyText = "";
    switch (format) {
      case "markdown":
        copyText = generateMarkdownExport(sessionsToCopy);
        break;
      case "plain":
        copyText = generatePlainTextExport(sessionsToCopy);
        break;
      default:
        copyText = generateMarkdownExport(sessionsToCopy);
    }

    copyToClipboard(copyText)
      .then(() => {
        debug('[handleBulkCopy] Successfully copied as', format);
      })
      .catch(err => {
        debug('Failed to copy to clipboard:', err);
      });
  }
}

function handleBulkExport(format) {
  const selectedTabs = getSelectedTabs();
  if (selectedTabs.length === 0) return;

  debug('[handleBulkExport] Exporting', selectedTabs.length, 'tabs in format:', format);

  // Track which sessions are explicitly selected (session checkbox checked)
  const selectedSessionIds = new Set();
  fullscreenData.filteredTabs.forEach(item => {
    if (item.type === 'session' && fullscreenData.selectedTabIds.has(item.id)) {
      selectedSessionIds.add(item.id);
    }
  });

  const sessionMap = new Map();
  selectedTabs.forEach(tab => {
    const sessionId = `session-${tab.sessionTimestamp}`;
    if (!sessionMap.has(sessionId)) {
      const includeSessionName = selectedSessionIds.has(sessionId);
      sessionMap.set(sessionId, {
        timestamp: tab.sessionTimestamp,
        customName: includeSessionName ? tab.sessionName : null,
        defaultTitle: includeSessionName ? tab.sessionName : null,
        skipSessionHeader: !includeSessionName,
        tabs: [],
        locked: tab.sessionLocked,
        pinned: tab.sessionPinned,
        color: tab.sessionColor
      });
    }
    sessionMap.get(sessionId).tabs.push({
      url: tab.url,
      title: tab.title,
      favicon: tab.favicon
    });
  });

  const sessions = Array.from(sessionMap.values());

  let exportText = "";
  let mimeType = "text/plain";
  let fileExtension = "txt";

  switch (format) {
    case "plain":
      exportText = generatePlainTextExport(sessions);
      fileExtension = "txt";
      break;
    case "rtf":
      exportText = generateRTFExport(sessions);
      mimeType = "application/rtf";
      fileExtension = "rtf";
      break;
    case "markdown":
      exportText = generateMarkdownExport(sessions);
      fileExtension = "md";
      break;
    case "html":
      exportText = generateHTMLExport(sessions);
      mimeType = "text/html";
      fileExtension = "html";
      break;
    case "json":
      exportText = JSON.stringify(sessions, null, 2);
      mimeType = "application/json";
      fileExtension = "json";
      break;
    case "opml":
      exportText = generateOPMLExport(sessions);
      mimeType = "text/xml";
      fileExtension = "opml";
      break;
    default:
      exportText = generateMarkdownExport(sessions);
      fileExtension = "md";
  }

  const blob = new Blob([exportText], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;

  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  a.download = `tabstract-export-${year}${month}${day}.${fileExtension}`;

  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  debug('[handleBulkExport] Export complete:', a.download);
}

function handleBulkDuplicate() {
  const selectedTabs = getSelectedTabs();
  if (selectedTabs.length === 0) return;

  debug('[handleBulkDuplicate] Duplicating', selectedTabs.length, 'tabs');

  chrome.storage.local.get(['savedSessions', 'collapsedSessions'], (result) => {
    let sessions = result.savedSessions || [];
    let collapsed = result.collapsedSessions || {};

    // Group selected tabs by session
    const tabsBySession = new Map();
    selectedTabs.forEach(tab => {
      if (!tabsBySession.has(tab.sessionIndex)) {
        tabsBySession.set(tab.sessionIndex, {
          sessionIndex: tab.sessionIndex,
          tabIndices: []
        });
      }
      tabsBySession.get(tab.sessionIndex).tabIndices.push(tab.tabIndex);
    });

    const newSessions = [];
    let timestampOffset = 0; // Track offset to ensure unique timestamps

    // Process each session
    tabsBySession.forEach(({sessionIndex, tabIndices}) => {
      const originalSession = sessions[sessionIndex];
      if (!originalSession) return;

      // Create a new session with only the selected tabs
      // Add offset to ensure unique timestamps when creating multiple duplicates
      const duplicatedSession = {
        timestamp: new Date(Date.now() + timestampOffset).toISOString(),
        tabs: [],
        locked: originalSession.locked || false,
        color: originalSession.color || null
      };
      timestampOffset++; // Increment for next duplicate

      // Copy selected tabs
      tabIndices.forEach(tabIndex => {
        const tab = originalSession.tabs[tabIndex];
        if (tab) {
          duplicatedSession.tabs.push(JSON.parse(JSON.stringify(tab)));
        }
      });

      if (duplicatedSession.tabs.length === 0) return;

      // Generate name for duplicated session
      const originalName = originalSession.customName || originalSession.defaultTitle || 'Untitled Session';
      const tabCountSuffix = duplicatedSession.tabs.length === originalSession.tabs.length
        ? ''
        : ` (${duplicatedSession.tabs.length} tabs)`;
      duplicatedSession.customName = getIncrementedName(originalName) + tabCountSuffix;

      // Copy pinned status if original was pinned
      if (originalSession.pinned) {
        duplicatedSession.pinned = true;
        duplicatedSession.pinnedAt = Date.now();
      }

      // Copy smart group ID if it exists
      if (originalSession.smartGroupId) {
        duplicatedSession.smartGroupId = originalSession.smartGroupId;
      }

      newSessions.push({
        session: duplicatedSession,
        insertIndex: sessionIndex,
        originalTimestamp: originalSession.timestamp
      });
    });

    // Insert new sessions (in reverse order to maintain correct positions)
    newSessions.reverse().forEach(({session, insertIndex}) => {
      sessions.splice(insertIndex, 0, session);
    });

    // Preserve collapsed state from original sessions
    newSessions.forEach(({session, originalTimestamp}) => {
      // If original session was collapsed, collapse the duplicate too
      const originalSessionId = `session-${originalTimestamp}`;
      const duplicateSessionId = `session-${session.timestamp}`;
      if (fullscreenData.collapsedSessions && fullscreenData.collapsedSessions.has(originalSessionId)) {
        fullscreenData.collapsedSessions.add(duplicateSessionId);
      }
    });

    // Save updated sessions and collapsed state
    const saveData = { savedSessions: sessions, collapsedSessions: collapsed };
    if (fullscreenData.collapsedSessions) {
      saveData.advancedModeCollapsed = Array.from(fullscreenData.collapsedSessions);
    }

    chrome.storage.local.set(saveData, () => {
      debug('Duplicated', newSessions.length, 'session(s)');
      savedSessions = sessions;

      // Update compact mode
      updateSessionList(sessions);

      // Update advanced mode
      fullscreenData.selectedTabIds.clear();
      fullscreenData.allTabs = transformSessionsToTabs(sessions);
      applyFiltersAndRender();
      updateSelectAllCheckbox();

      refreshBadge();

      // Highlight the first new session
      if (newSessions.length > 0) {
        highlightDropSession(newSessions[newSessions.length - 1].session.timestamp);
      }
    });
  });
}

function saveInlineEdit(tabId, field, newValue) {
  // Find the tab in allTabs
  const tab = fullscreenData.allTabs.find(t => t.id === tabId);
  if (!tab) return;

  const sessionIndex = tab.sessionIndex;
  const tabIndex = tab.tabIndex;
  const session = savedSessions[sessionIndex];
  if (!session) return;

  // Update the appropriate field
  if (field === "title") {
    // Update tab title
    session.tabs[tabIndex].title = newValue;
    tab.title = newValue; // Update in-memory data
  } else if (field === "sessionName") {
    // Moving tab to a different session (or creating new one)
    const tabData = session.tabs[tabIndex];

    // Remove tab from current session
    session.tabs.splice(tabIndex, 1);

    // Find existing session with matching name (check both customName and defaultTitle)
    let targetSession = savedSessions.find(s =>
      (s.customName && s.customName === newValue) ||
      (s.defaultTitle && s.defaultTitle === newValue)
    );

    if (targetSession) {
      // Add to existing session
      targetSession.tabs.push(tabData);
    } else {
      // Create new session with this tab
      const newSession = {
        timestamp: new Date().toISOString(),
        customName: newValue,
        tabs: [tabData]
      };
      savedSessions.unshift(newSession); // Add to beginning
    }

    // Clean up: remove original session if now empty
    if (session.tabs.length === 0) {
      const indexToRemove = savedSessions.indexOf(session);
      if (indexToRemove !== -1) {
        savedSessions.splice(indexToRemove, 1);
      }
    }
  }

  // Save to storage and refresh
  isUpdatingFromStorage = true;
  chrome.storage.local.set({ savedSessions }, () => {
    // Reload from storage to ensure consistency
    chrome.storage.local.get(['savedSessions'], (result) => {
      const updatedSessions = result.savedSessions || [];
      savedSessions = updatedSessions;

      if (viewMode === 'fullscreen') {
        fullscreenData.allTabs = transformSessionsToTabs(updatedSessions);
        applyFiltersAndRender();
      } else {
        updateSessionList(updatedSessions);
      }
      setTimeout(() => { isUpdatingFromStorage = false; }, 100);
    });
  });
}

function getSelectedTabs() {
  // Only return selected tabs (not sessions) that are currently visible/filtered
  return fullscreenData.filteredTabs.filter(item =>
    item.type === 'tab' && fullscreenData.selectedTabIds.has(item.id)
  );
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function exitFullScreenMode() {
  // Skip if we're restoring on page load
  if (isRestoringViewMode) {
    debug('[EXIT FULLSCREEN] ⏭️ Skipping - currently restoring view mode');
    return;
  }
  debug("Exiting full screen mode");

  // Clear selection
  fullscreenData.selectedTabIds.clear();
  updateSelectAllCheckbox();

  // Hide fullscreen container
  const fullscreenContainer = document.getElementById("fullscreen-container");
  if (fullscreenContainer) {
    fullscreenContainer.style.display = "none";
  }

  // Re-fetch sessions from storage and re-render compact view
  // (lock/pin changes made in advanced mode suppress the storage listener,
  // so compact view may be stale)
  chrome.storage.local.get(['savedSessions'], (result) => {
    const sessions = result.savedSessions || [];
    updateSessionList(sessions);
  });
}

// Note: View mode is now loaded in the initial storage.get call (line ~1365) to avoid race conditions

document.addEventListener('DOMContentLoaded', () => {
    applyDarkModeSetting();
    startPendingSessionWatchdog();

    // Initialize feature UI state
    initializeFeatureState();

    // Custom tooltips for toolbar icon buttons
    (function initToolbarTooltips() {
      const tooltip = document.createElement('div');
      tooltip.className = 'toolbar-tooltip';
      document.body.appendChild(tooltip);
      let hoverTimer = null;

      document.querySelectorAll('.fullscreen-toolbar .toolbar-icon-btn').forEach(btn => {
        btn.addEventListener('mouseenter', () => {
          // Suppress native tooltip by stashing and removing title
          const title = btn.getAttribute('title');
          if (title) {
            btn.dataset.tooltipTitle = title;
            btn.removeAttribute('title');
          }
          // Skip tooltip for copy/export buttons when enabled (dropdown menu handles it)
          if (btn.id === 'toolbar-copy-btn' && !btn.disabled) return;
          if (btn.id === 'toolbar-export-btn' && !btn.disabled) return;
          // Use localized title for tooltip text (title is set by i18n system)
          const text = btn.dataset.tooltipTitle || btn.getAttribute('aria-label');
          if (!text) return;
          tooltip.textContent = text;
          hoverTimer = setTimeout(() => {
            const rect = btn.getBoundingClientRect();
            let left = rect.left + rect.width / 2 - tooltip.offsetWidth / 2;
            const top = rect.bottom + 6;
            // Viewport clamping
            if (left + tooltip.offsetWidth > window.innerWidth - 4) {
              left = window.innerWidth - tooltip.offsetWidth - 4;
            }
            if (left < 4) left = 4;
            tooltip.style.top = top + 'px';
            tooltip.style.left = left + 'px';
            tooltip.classList.add('visible');
          }, 300);
        });

        btn.addEventListener('mouseleave', () => {
          clearTimeout(hoverTimer);
          tooltip.classList.remove('visible');
          // Restore title only if it wasn't already updated dynamically while hovering
          if (btn.dataset.tooltipTitle) {
            if (!btn.getAttribute('title')) {
              btn.setAttribute('title', btn.dataset.tooltipTitle);
            }
            delete btn.dataset.tooltipTitle;
          }
        });

        btn.addEventListener('mousedown', () => {
          clearTimeout(hoverTimer);
          tooltip.classList.remove('visible');
        });
      });
    })();

    // Custom tooltips for session action buttons (simple mode)
    (function initSessionActionTooltips() {
      const tooltip = document.createElement('div');
      tooltip.className = 'toolbar-tooltip';
      document.body.appendChild(tooltip);
      let hoverTimer = null;
      let currentTarget = null;

      const SELECTORS = '.session-actions > a';

      document.addEventListener('mouseover', (e) => {
        const link = e.target.closest(SELECTORS);
        if (!link || link === currentTarget) return;

        // Clean up previous target
        if (currentTarget) {
          clearTimeout(hoverTimer);
          tooltip.classList.remove('visible');
          if (currentTarget.dataset.tooltipTitle && !currentTarget.getAttribute('title')) {
            currentTarget.setAttribute('title', currentTarget.dataset.tooltipTitle);
            delete currentTarget.dataset.tooltipTitle;
          }
        }

        currentTarget = link;

        // Suppress native tooltip by stashing and removing title
        const title = link.getAttribute('title');
        if (title) {
          link.dataset.tooltipTitle = title;
          link.removeAttribute('title');
        }

        const text = link.dataset.tooltipTitle || link.getAttribute('aria-label');
        if (!text) return;
        tooltip.textContent = text;

        hoverTimer = setTimeout(() => {
          const rect = link.getBoundingClientRect();
          let left = rect.left + rect.width / 2 - tooltip.offsetWidth / 2;
          const top = rect.bottom + 6;
          if (left + tooltip.offsetWidth > window.innerWidth - 4) {
            left = window.innerWidth - tooltip.offsetWidth - 4;
          }
          if (left < 4) left = 4;
          tooltip.style.top = top + 'px';
          tooltip.style.left = left + 'px';
          tooltip.classList.add('visible');
        }, 300);
      });

      document.addEventListener('mouseout', (e) => {
        const link = e.target.closest(SELECTORS);
        if (!link || link !== currentTarget) return;

        // Check if we're moving to a child of the same link
        if (e.relatedTarget && link.contains(e.relatedTarget)) return;

        clearTimeout(hoverTimer);
        tooltip.classList.remove('visible');
        currentTarget = null;

        if (link.dataset.tooltipTitle) {
          if (!link.getAttribute('title')) {
            link.setAttribute('title', link.dataset.tooltipTitle);
          }
          delete link.dataset.tooltipTitle;
        }
      });

      document.addEventListener('mousedown', (e) => {
        if (e.target.closest(SELECTORS)) {
          clearTimeout(hoverTimer);
          tooltip.classList.remove('visible');
        }
      });
    })();

    // Pre-cache AI availability status for instant title editing UI
    chrome.runtime.sendMessage({ action: "checkAIStatus" }, (response) => {
      if (!chrome.runtime.lastError && response) {
        recordAIAvailability(response.available === true);
      }
    });

    // Start background title fetching after a short delay to let UI load first
    setTimeout(() => startBackgroundTitleFetching(), 500);

    // Global keyboard handler for shortcuts
    document.addEventListener('keydown', (e) => {
        // A key (without modifiers): Toggle view mode
        if ((e.key === 'a' || e.key === 'A') && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
            const isTyping = e.target.tagName === 'INPUT' ||
                           e.target.tagName === 'TEXTAREA' ||
                           e.target.isContentEditable;

            // Check if any modal is open
            const templatesModal = document.getElementById('templatesModal');
            const smartGroupsModal = document.getElementById('smartGroupsModal');
            const smartGroupEditorModal = document.getElementById('smartGroupEditorModal');
            const scheduleEditorModal = document.getElementById('scheduleEditorModal');
            const isModalOpen = (templatesModal && templatesModal.style.display === 'flex') ||
                               (smartGroupsModal && smartGroupsModal.style.display === 'flex') ||
                               (smartGroupEditorModal && smartGroupEditorModal.style.display === 'flex') ||
                               (scheduleEditorModal && scheduleEditorModal.style.display === 'flex');

            // Check if there are any sessions (required to enter advanced mode)
            const hasSessions = document.querySelectorAll('#tabList .session-wrapper:not(.trash-group)').length > 0;

            if (!isTyping && !isModalOpen && (hasSessions || viewMode === 'fullscreen')) {
                e.preventDefault();
                toggleViewMode();
                return;
            }
        }

        // Command+A: Null in compact mode, Select All checkboxes in advanced mode
        // But allow default behavior when an input is focused (to select all text)
        if ((e.key === 'a' || e.key === 'A') && e.metaKey) {
            const activeEl = document.activeElement;
            const isInputFocused = activeEl && (
                activeEl.tagName === 'INPUT' ||
                activeEl.tagName === 'TEXTAREA' ||
                activeEl.contentEditable === 'true'
            );

            // Allow default Cmd+A behavior in inputs (select all text)
            if (isInputFocused) {
                return;
            }

            e.preventDefault(); // Prevent default select all behavior

            if (viewMode === 'compact') {
                // In compact mode: do nothing (null)
                return;
            } else if (viewMode === 'fullscreen') {
                // In advanced mode: select all checkboxes using the header checkbox mechanism
                const selectAllCheckbox = document.getElementById("header-select-all");
                if (selectAllCheckbox) {
                    // Toggle the checkbox and trigger change event
                    selectAllCheckbox.checked = !selectAllCheckbox.checked;
                    selectAllCheckbox.dispatchEvent(new Event("change", { bubbles: true }));
                }
            }
            return;
        }

        // ESC key handler to close any open modal
        if (e.key === 'Escape' || e.key === 'Esc') {
            // Check for open modals and close them
            const templatesModal = document.getElementById('templatesModal');
            const smartGroupsModal = document.getElementById('smartGroupsModal');
            const smartGroupEditorModal = document.getElementById('smartGroupEditorModal');
            const scheduleEditorModal = document.getElementById('scheduleEditorModal');

            if (smartGroupEditorModal && smartGroupEditorModal.style.display === 'flex') {
                // Close Smart Group editor - simulate X button click to trigger proper cleanup
                const closeBtn = document.getElementById('smartGroupEditorClose');
                if (closeBtn) closeBtn.click();
            } else if (scheduleEditorModal && scheduleEditorModal.style.display === 'flex') {
                // Close schedule editor
                const closeBtn = document.getElementById('scheduleEditorClose');
                if (closeBtn) closeBtn.click();
            } else if (smartGroupsModal && smartGroupsModal.style.display === 'flex') {
                // Close Smart Groups modal
                smartGroupsModal.style.display = 'none';
                document.body.classList.remove('modal-open');
            } else if (templatesModal && templatesModal.style.display === 'flex') {
                // Close templates modal
                templatesModal.style.display = 'none';
                document.body.classList.remove('modal-open');
            }
        }
    });

    // Global click handler to close session action menus when clicking outside
    document.addEventListener('click', (e) => {
        // Check if click is inside any session actions menu container
        const clickedInsideMenu = e.target.closest('.session-actions-menu-container');
        const clickedColorPicker = e.target.closest('.color-picker-input') || e.target.classList.contains('color-picker-input');

        if (!clickedInsideMenu && !clickedColorPicker) {
            // Clear any active color pickers before closing
            document.querySelectorAll('.session-actions-menu[data-color-picker-active="true"]').forEach(menu => {
                delete menu.dataset.colorPickerActive;
            });
            // Remove color-picker-active class from any wrappers
            document.querySelectorAll('.session-wrapper.color-picker-active').forEach(wrapper => {
                wrapper.classList.remove('color-picker-active');
            });
            // Close all open session action menus
            document.querySelectorAll('.session-actions-menu.show').forEach(menu => {
                menu.classList.remove('show');
                const btn = menu.previousElementSibling;
                if (btn) btn.setAttribute('aria-expanded', 'false');
            });
            document.body.classList.remove('session-menu-open');
        }
    });

    // Block native dragstart within our list UI to avoid Safari link/image drags
    // But explicitly allow template card drags
    document.addEventListener('dragstart', (e) => {
      const t = e.target;
      if (!t) return;
      // Allow template drags
      if (t.closest && t.closest('.template-item-card')) {
        return;
      }
      // Block session drags (we use custom pointer-based drag for sessions)
      if (t.closest && (t.closest('.session-card') || t.closest('.session-wrapper'))) {
        e.preventDefault();
      }
    }, true);
    // -----------------------------------
    // Use the <div id="…"> itself as the storage key
    // -----------------------------------
    const banner = document.querySelector('.banner');
    if (banner) {
      // Localize banner text
      const bannerTitle = document.getElementById('banner-title');
      const bannerDesc = document.getElementById('banner-description');
      if (bannerTitle) bannerTitle.textContent = getMessage('bannerTitle') || 'Tabstract 3.1';
      if (bannerDesc) bannerDesc.textContent = getMessage('bannerText') || '';

      const key = banner.id;
      const dismissed = localStorage.getItem(key) === 'true';
      // Decide visibility early (avoid flash). Also ensure there are sessions.
      chrome.storage.local.get(['installDate','savedSessions'], (result) => {
        const installDate = (typeof result.installDate === 'number' && result.installDate > 0)
          ? result.installDate
          : Date.now();
        const daysSinceInstall = (Date.now() - installDate) / (1000 * 60 * 60 * 24);
        const hasSessions = Array.isArray(result.savedSessions) && result.savedSessions.length > 0;
        const eligible = !dismissed && daysSinceInstall >= 3 && hasSessions;
        if (eligible) banner.classList.add('is-visible');
        else banner.classList.remove('is-visible');
      });

      const dismissBtn = document.getElementById('banner-dismiss');
      if (dismissBtn) {
        dismissBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          banner.classList.remove('is-visible');
          if (key) localStorage.setItem(key, 'true');
        });
      }
    }
});

window.addEventListener('beforeunload', () => {
  if (pendingWatchdogId) {
    clearInterval(pendingWatchdogId);
    pendingWatchdogId = null;
  }
});

// Re-apply dark mode automatically if system theme changes while in Auto mode
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  chrome.storage.local.get('darkMode', (result) => {
    if ((result.darkMode || 'Auto') === 'Auto') {
      applyDarkModeSetting();
    }
  });
});

function applyDarkModeSetting() {
  chrome.storage.local.get("darkMode", (result) => {
    const mode = result.darkMode || "Auto";
    // Sync to localStorage for instant access on next page load
    localStorage.setItem('tabstract_darkMode', mode);

    if (mode === "Dark") {
      document.documentElement.classList.add("dark-mode");
    } else if (mode === "Light") {
      document.documentElement.classList.remove("dark-mode");
    } else {
      if (window.matchMedia("(prefers-color-scheme: dark)").matches) {
        document.documentElement.classList.add("dark-mode");
      } else {
        document.documentElement.classList.remove("dark-mode");
      }
    }
    // Update welcome video source to match current theme, if present
    const vid = document.querySelector('.welcome-demo-video');
    if (vid) setWelcomeVideoSrc(vid);
  });
}

// Choose appropriate welcome video for current theme
function setWelcomeVideoSrc(videoEl) {
  try {
    const isDark = document.documentElement.classList.contains('dark-mode');
    const darkSrc = 'https://tabstract.app/app-assets/welcome-drag-to-toolbar-dark-optimized.mp4';
    const lightSrc = 'https://tabstract.app/app-assets/welcome-drag-to-toolbar-optimized.mp4';
    const darkPoster = chrome.runtime.getURL('images/welcome-drag-to-toolbar-dark-poster.jpg');
    const lightPoster = chrome.runtime.getURL('images/welcome-drag-to-toolbar-poster.jpg');
    const desired = isDark ? darkSrc : lightSrc;
    const desiredPoster = isDark ? darkPoster : lightPoster;

    if (videoEl.getAttribute('src') !== desired) {
      videoEl.setAttribute('src', desired);
      videoEl.setAttribute('poster', desiredPoster);
      // Reload video - autoplay attribute will handle playback smoothly
      if (videoEl.load) videoEl.load();
      // Don't manually call play() - let autoplay handle it to avoid flash
    }
  } catch (_) {}
}

function wireRowHover() {
  const rows = document.querySelectorAll('.link-row');
  rows.forEach((row) => {
    // Only add listeners if not already bound
    if (!row.dataset.hoverBound) {
      row.dataset.hoverBound = 'true';
      row.addEventListener('mouseenter', () => {
        row.classList.add('js-hover');
      });
      row.addEventListener('mouseleave', () => {
        row.classList.remove('js-hover');
      });
    }
  });
}

// Global flag to track if keyboard shortcuts are already initialized
let keyboardShortcutsInitialized = false;
let clipboardPasteInitialized = false;
let pendingWatchdogId = null;

// Search functionality
function initializeSearch() {
  const searchInput = document.getElementById('searchInput');
  const searchClear = document.getElementById('searchClear');

  if (!searchInput || !searchClear) return;


  // Store all tabs data for searching
  allTabsData = extractAllTabsData();

  // Only add these event listeners once per page load, not on every render
  if (!searchInput.dataset.bound) {
    searchInput.dataset.bound = 'true';
    searchInput.addEventListener('input', handleSearchInput);

    // When focusing search in trash view, prefill trash filter only for English locales
    searchInput.addEventListener('focus', () => {
      if (currentView === 'trash') {
        if (shouldPrefillTrashFilter) {
          const currentVal = searchInput.value || '';
          if (!hasTrashFilterPrefix(currentVal)) {
            searchInput.value = addTrashFilterPrefix(currentVal.trim());
            // Move caret to end
            const len = searchInput.value.length;
            try { searchInput.setSelectionRange(len, len); } catch (_) {}
          }
          const searchClearBtn = document.getElementById('searchClear');
          if (searchClearBtn) searchClearBtn.classList.add('visible');
        } else if (hasTrashFilterPrefix(searchInput.value || '')) {
          searchInput.value = removeTrashFilterPrefix(searchInput.value || '');
        }
      }
    });

    // ESC key to clear search
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        clearSearch();
        searchInput.blur();
      }
    });

    // Show/hide clear button based on input
    searchInput.addEventListener('input', () => {
      if (searchInput.value.trim()) {
        searchClear.classList.add('visible');
      } else {
        searchClear.classList.remove('visible');
      }
    });
  }

  if (!searchClear.dataset.bound) {
    searchClear.dataset.bound = 'true';
    searchClear.addEventListener('click', clearSearch);
  }

  // Search toggle button and container
  const searchToggleBtn = document.getElementById('searchToggleBtn');
  const navSearchContainer = document.getElementById('navSearchContainer');

  if (searchToggleBtn && navSearchContainer && !searchToggleBtn.dataset.bound) {
    searchToggleBtn.dataset.bound = 'true';

    // Toggle search container visibility
    searchToggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isExpanded = navSearchContainer.classList.contains('visible');
      if (isExpanded) {
        navSearchContainer.classList.remove('visible');
        searchToggleBtn.setAttribute('aria-expanded', 'false');
      } else {
        navSearchContainer.classList.add('visible');
        searchToggleBtn.setAttribute('aria-expanded', 'true');
        // Focus input when opening
        setTimeout(() => searchInput.focus(), 50);
      }
    });

    // Close when clicking outside
    document.addEventListener('click', (e) => {
      if (!navSearchContainer.contains(e.target) && !searchToggleBtn.contains(e.target)) {
        navSearchContainer.classList.remove('visible');
        searchToggleBtn.setAttribute('aria-expanded', 'false');
      }
    });

    // Close on Escape (in addition to clearing)
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !searchInput.value.trim()) {
        navSearchContainer.classList.remove('visible');
        searchToggleBtn.setAttribute('aria-expanded', 'false');
      }
    });
  }

  // Initial visibility check for clear button
  if (searchInput.value.trim()) {
    searchClear.classList.add('visible');
  } else {
    searchClear.classList.remove('visible');
  }

  // Global shortcuts: "/" focuses search; "N" creates a new session
  // Only add this listener ONCE per page load to prevent memory leaks
  if (!keyboardShortcutsInitialized) {
    keyboardShortcutsInitialized = true;
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const activeElement = document.activeElement;
      const isInputFocused = activeElement && (
        activeElement.tagName === 'INPUT' ||
        activeElement.tagName === 'TEXTAREA' ||
        activeElement.contentEditable === 'true'
      );

      if (isInputFocused) return;

      if (e.key === '/') {
        e.preventDefault();
        const isAdvancedMode = viewMode === 'fullscreen';

        if (isAdvancedMode) {
          // Focus advanced mode search
          const advancedSearchInput = document.getElementById('fullscreen-search');
          if (advancedSearchInput) {
            advancedSearchInput.focus();
          }
        } else {
          // Focus simple mode search
          const currentSearchInput = document.getElementById('searchInput');
          const currentSearchContainer = document.getElementById('navSearchContainer');
          const currentSearchToggle = document.getElementById('searchToggleBtn');
          if (currentSearchInput) {
            // Open search container if it exists
            if (currentSearchContainer && currentSearchToggle) {
              currentSearchContainer.classList.add('visible');
              currentSearchToggle.setAttribute('aria-expanded', 'true');
            }
            currentSearchInput.focus();
          }
        }
        return;
      }
      if (e.code === 'KeyN' && currentView !== 'trash') {
        e.preventDefault();
        createEmptySession();
        // Trigger review prompt evaluation after keyboard shortcut usage
        return;
      }
      // Removed: 'T' keyboard shortcut for toggling trash view (no longer needed)
    });
  }

  // Initialize paste-to-session handler once
  if (!clipboardPasteInitialized) {
    clipboardPasteInitialized = true;
    document.addEventListener('paste', handleClipboardPaste);
  }

}

// -------- Actions Menu Helpers --------

function openActionsMenu() {
  const actionsMenuBtn = document.getElementById('actionsMenuBtn');
  const toolbarActionsMenuBtn = document.getElementById('toolbarActionsMenuBtn');
  const actionsMenu = document.getElementById('actionsMenu');
  if (actionsMenu) {
    // Close all session menus first
    document.querySelectorAll('.session-actions-menu.show').forEach(menu => {
      menu.classList.remove('show');
      const btn = menu.previousElementSibling;
      if (btn) btn.setAttribute('aria-expanded', 'false');
    });

    actionsMenu.classList.add('show');
    if (actionsMenuBtn) actionsMenuBtn.setAttribute('aria-expanded', 'true');
    if (toolbarActionsMenuBtn) toolbarActionsMenuBtn.setAttribute('aria-expanded', 'true');
    document.body.classList.add('actions-menu-open');

    // Update Trash Duplicates button state based on locked sessions
    updateTrashDuplicatesState();

    // Update Rainbow sort option visibility (easter egg: shows when 4+ unique colors exist)
    updateRainbowSortState();
  }
}

function updateTrashDuplicatesState() {
  const trashDuplicatesBtn = document.getElementById('trashDuplicatesBtn');
  if (!trashDuplicatesBtn) return;

  chrome.storage.local.get(['savedSessions'], (result) => {
    const sessions = result.savedSessions || [];

    // Check if all sessions are locked
    const allLocked = sessions.length > 0 && sessions.every(session => session.locked);

    // Check if there are any trashable duplicates
    const hasDuplicates = checkForDuplicates(sessions);

    if (allLocked || !hasDuplicates) {
      trashDuplicatesBtn.classList.add('disabled');
      trashDuplicatesBtn.setAttribute('aria-disabled', 'true');
    } else {
      trashDuplicatesBtn.classList.remove('disabled');
      trashDuplicatesBtn.setAttribute('aria-disabled', 'false');
    }
  });
}

function updateRainbowSortState() {
  const rainbowBtn = document.getElementById('sortRainbowBtn');
  if (!rainbowBtn) return;

  chrome.storage.local.get(['savedSessions'], (result) => {
    const sessions = result.savedSessions || [];
    const unpinnedSessions = sessions.filter(s => !s.pinned);

    // Count unique colors (excluding 'none', null, undefined)
    const uniqueColors = new Set();
    unpinnedSessions.forEach(session => {
      if (session.color && session.color !== 'none') {
        uniqueColors.add(session.color);
      }
    });

    // Show rainbow option if 4+ unique colors exist
    if (uniqueColors.size >= 4) {
      rainbowBtn.style.display = 'block';
      debug('[Rainbow] Showing rainbow sort option - found', uniqueColors.size, 'unique colors');
    } else {
      rainbowBtn.style.display = 'none';
      debug('[Rainbow] Hiding rainbow sort option - only', uniqueColors.size, 'unique colors');
    }
  });
}

function checkForDuplicates(sessions) {
  if (!sessions || sessions.length === 0) return false;

  const urlInfo = new Map(); // url -> Array of { isLocked }

  // Collect all occurrences of each URL from sessions
  sessions.forEach((session) => {
    if (!session.tabs || !Array.isArray(session.tabs)) return;

    session.tabs.forEach((tab) => {
      const url = tab.url;
      if (!url) return;

      if (!urlInfo.has(url)) {
        urlInfo.set(url, []);
      }
      urlInfo.get(url).push({
        isLocked: session.locked
      });
    });
  });

  // Check if there are any removable duplicates
  for (const [url, occurrences] of urlInfo) {
    if (occurrences.length <= 1) continue; // No duplicates

    const hasLockedOccurrence = occurrences.some(occ => occ.isLocked);

    if (hasLockedOccurrence) {
      // If any occurrence is locked, we can delete unlocked duplicates
      if (occurrences.some(occ => !occ.isLocked)) {
        return true;
      }
    } else {
      // No locked occurrences - we can keep oldest and delete the rest
      if (occurrences.length > 1) {
        return true;
      }
    }
  }

  return false;
}

function closeActionsMenu() {
  const actionsMenuBtn = document.getElementById('actionsMenuBtn');
  const toolbarActionsMenuBtn = document.getElementById('toolbarActionsMenuBtn');
  const actionsMenu = document.getElementById('actionsMenu');
  if (actionsMenu) {
    actionsMenu.classList.remove('show');
    if (actionsMenuBtn) actionsMenuBtn.setAttribute('aria-expanded', 'false');
    if (toolbarActionsMenuBtn) toolbarActionsMenuBtn.setAttribute('aria-expanded', 'false');
    document.body.classList.remove('actions-menu-open');

    // Also hide any open submenus
    const submenus = actionsMenu.querySelectorAll('.actions-submenu');
    submenus.forEach(submenu => submenu.classList.remove('show'));
    const exportBtn = document.getElementById('exportBtn');
    if (exportBtn) {
      exportBtn.setAttribute('aria-expanded', 'false');
    }

    // Freeze clicks to prevent accidental clicks on underlying content
    freezeClicks(250);
  }
}

// Paste Links action - triggers a programmatic paste without permission prompts
// This uses document.execCommand('paste') which Safari allows without prompts
// because it's triggered by a user click event
function handlePasteLinksAction() {
  try {
    if (currentView === 'trash') {
      debug('[Tabstract] Cannot paste links in trash view');
      return;
    }

    // Create a temporary contenteditable element to receive the paste
    const pasteTarget = document.createElement('div');
    pasteTarget.contentEditable = 'true';
    pasteTarget.setAttribute('data-tabstract-paste-target', 'true'); // Mark as our paste target
    pasteTarget.style.position = 'fixed';
    pasteTarget.style.left = '-9999px';
    pasteTarget.style.opacity = '0';
    pasteTarget.style.pointerEvents = 'none';
    document.body.appendChild(pasteTarget);

    // Focus the element
    pasteTarget.focus();

    // Execute paste command - this triggers the 'paste' event which our
    // existing handleClipboardPaste listener will catch
    const success = document.execCommand('paste');

    // Clean up the temporary element after a brief delay
    setTimeout(() => {
      if (pasteTarget && pasteTarget.parentNode) {
        pasteTarget.parentNode.removeChild(pasteTarget);
      }
    }, 100);

    if (!success) {
      debug('[Tabstract] Paste command failed - clipboard may be empty or inaccessible');
    }
  } catch (err) {
    debug('[Tabstract] Paste links action failed:', err);
  }
}

// Update Collapse/Expand All button text based on current state
function updateCollapseExpandAllButtonText() {
  const collapseExpandAllBtn = document.getElementById('collapseExpandAllBtn');
  if (!collapseExpandAllBtn) return;

  const sessionWrappers = document.querySelectorAll('.session-wrapper');
  if (sessionWrappers.length === 0) return;

  // Check if all sessions are collapsed
  // In advanced mode, check fullscreenData.collapsedSessions (compact DOM wrappers may be stale)
  let allCollapsed;
  if (viewMode === 'fullscreen' && fullscreenData.collapsedSessions) {
    const sessionCount = savedSessions ? savedSessions.length : 0;
    allCollapsed = sessionCount > 0 && fullscreenData.collapsedSessions.size >= sessionCount;
  } else {
    allCollapsed = Array.from(sessionWrappers).every(wrapper => wrapper.classList.contains('collapsed'));
  }

  const textSpan = collapseExpandAllBtn.querySelector('span');
  if (textSpan) {
    textSpan.textContent = allCollapsed ? getMessage('expandAll') || 'Expand All' : getMessage('collapseAll') || 'Collapse All';
  }

  // Also update toolbar icon button title/aria-label
  const toolbarBtn = document.getElementById('toolbar-collapse-expand-all');
  if (toolbarBtn) {
    const label = allCollapsed ? getMessage('expandAll') || 'Expand All' : getMessage('collapseAll') || 'Collapse All';
    toolbarBtn.title = label;
    toolbarBtn.setAttribute('aria-label', label);
  }
}

// Update Lock/Unlock All button text based on current state
function updateLockUnlockAllButtonText() {
  const lockUnlockAllBtn = document.getElementById('lockUnlockAllBtn');
  if (!lockUnlockAllBtn) return;

  if (!savedSessions || savedSessions.length === 0) return;

  // Check if all sessions are locked
  const allLocked = savedSessions.every(session => session.locked);

  const textSpan = lockUnlockAllBtn.querySelector('span');
  if (textSpan) {
    textSpan.textContent = allLocked ? getMessage('unlockAll') || 'Unlock All' : getMessage('lockAll') || 'Lock All';
  }
}

// Collapse/Expand All action - toggles all sessions
function handleCollapseExpandAllAction() {
  const sessionWrappers = document.querySelectorAll('.session-wrapper');
  if (sessionWrappers.length === 0) return;

  // Check if all sessions are collapsed - if so, we should expand; otherwise collapse
  // In advanced mode, check fullscreenData.collapsedSessions (compact DOM wrappers may be stale)
  let allCollapsed;
  if (viewMode === 'fullscreen' && fullscreenData.collapsedSessions) {
    const sessionCount = savedSessions ? savedSessions.length : 0;
    allCollapsed = sessionCount > 0 && fullscreenData.collapsedSessions.size >= sessionCount;
  } else {
    allCollapsed = Array.from(sessionWrappers).every(wrapper => wrapper.classList.contains('collapsed'));
  }
  const shouldCollapse = !allCollapsed;

  // Apply the same state to all sessions
  sessionWrappers.forEach(wrapper => {
    wrapper.classList.toggle('collapsed', shouldCollapse);
    wrapper.classList.toggle('closed', shouldCollapse);

    const toggleButton = wrapper.querySelector('.toggle-button');
    if (toggleButton) {
      toggleButton.setAttribute('aria-expanded', shouldCollapse ? 'false' : 'true');
      toggleButton.setAttribute('aria-label', shouldCollapse ? (getMessage('expandSession') || 'Expand session') : (getMessage('collapseSession') || 'Collapse session'));
    }

    // Update storage
    const timestamp = wrapper.dataset.timestamp;
    if (timestamp) {
      collapsedSessions[timestamp] = shouldCollapse;
    }
  });

  // Save to storage
  chrome.storage.local.set({ collapsedSessions });

  // If advanced mode is active, also update the expanded sessions state
  if (viewMode === "fullscreen") {
    chrome.storage.local.get(['savedSessions'], (result) => {
      const sessions = result.savedSessions || [];

      if (shouldCollapse) {
        // Collapse all: add all sessions to the collapsed set
        sessions.forEach(session => {
          const sessionId = `session-${session.timestamp}`;
          fullscreenData.collapsedSessions.add(sessionId);
        });
      } else {
        // Expand all: clear the collapsed sessions set
        fullscreenData.collapsedSessions.clear();
      }

      // Save the collapsed state and re-render
      saveCollapsedState();
      applyFiltersAndRender();
    });
  }

  // Update button text — shouldCollapse tells us what just happened,
  // so next action is the opposite
  updateCollapseExpandAllButtonText();
  const toolbarBtn = document.getElementById('toolbar-collapse-expand-all');
  if (toolbarBtn) {
    const nextLabel = shouldCollapse
      ? getMessage('expandAll') || 'Expand All'
      : getMessage('collapseAll') || 'Collapse All';
    toolbarBtn.title = nextLabel;
    toolbarBtn.setAttribute('aria-label', nextLabel);
  }
}

function handleLockUnlockAllAction() {
  if (!savedSessions || savedSessions.length === 0) return;

  // Check if all sessions are locked - if so, we should unlock; otherwise lock
  const allLocked = savedSessions.every(session => session.locked);
  const shouldLock = !allLocked;

  // Apply the same lock state to all sessions
  savedSessions.forEach(session => {
    session.locked = shouldLock;
  });

  // Save to storage and update UI
  isUpdatingFromStorage = true;
  chrome.storage.local.set({ savedSessions }, () => {
    if (viewMode === 'fullscreen') {
      fullscreenData.allTabs = transformSessionsToTabs(savedSessions);
      applyFiltersAndRender();
    } else {
      updateSessionList(savedSessions);
    }
    updateLockUnlockAllButtonText();
    setTimeout(() => { isUpdatingFromStorage = false; }, 100);
  });
}

function handleLockUnlockSelectedAction() {
  const selectedTabs = getSelectedTabs();
  if (selectedTabs.length === 0) return;

  // Get unique session timestamps from selected items
  const sessionTimestamps = new Set();
  selectedTabs.forEach(item => {
    if (item.type === 'session') {
      sessionTimestamps.add(item.timestamp);
    } else if (item.type === 'tab') {
      // If tab is selected, lock its parent session
      sessionTimestamps.add(item.sessionTimestamp);
    }
  });

  if (sessionTimestamps.size === 0) return;

  chrome.storage.local.get(['savedSessions'], (result) => {
    let sessions = result.savedSessions || [];

    // Check if all selected sessions are locked
    const selectedSessions = sessions.filter(s => sessionTimestamps.has(s.timestamp));
    const allLocked = selectedSessions.every(s => s.locked);
    const shouldLock = !allLocked;

    // Toggle lock state for selected sessions
    sessions.forEach(session => {
      if (sessionTimestamps.has(session.timestamp)) {
        session.locked = shouldLock;
      }
    });

    // Save and update
    chrome.storage.local.set({ savedSessions: sessions }, () => {
      // In fullscreen mode, refresh the table
      if (document.body.getAttribute('data-view-mode') === 'fullscreen') {
        savedSessions = sessions;
        const allTabs = transformSessionsToFullscreenTabs(sessions);
        fullscreenData.allTabs = allTabs;
        populateFilterDropdowns(allTabs);
        applyFiltersAndRender();
      } else {
        updateSessionList(sessions);
      }
    });
  });
}

// Get hue value (0-360) for rainbow sorting
function getColorSortValue(color) {
  if (!color || color === 'none') return 999; // No color goes to end

  // Map named colors to their approximate hue values on the color wheel
  const namedColorHues = {
    'red': 0,
    'orange': 30,
    'yellow': 60,
    'green': 120,
    'blue': 240,
    'purple': 280
  };

  // Check if it's a named color
  if (namedColorHues.hasOwnProperty(color)) {
    return namedColorHues[color];
  }

  // Custom hex color - convert to hue (0-360)
  if (color.startsWith('#')) {
    // Parse hex to RGB
    const hex = color.replace('#', '');
    const r = parseInt(hex.substring(0, 2), 16) / 255;
    const g = parseInt(hex.substring(2, 4), 16) / 255;
    const b = parseInt(hex.substring(4, 6), 16) / 255;

    // Convert RGB to HSL to get hue
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    let h = 0;

    if (max !== min) {
      const d = max - min;
      switch (max) {
        case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
        case g: h = ((b - r) / d + 2) / 6; break;
        case b: h = ((r - g) / d + 4) / 6; break;
      }
    }

    return h * 360; // Return hue in degrees (0-360)
  }

  return 999; // Unknown format goes to end
}

// Sort sessions by reversing their order (one-time action, not persistent)
function handleSortSessionsAction(direction) {
  // Get current sessions from storage
  chrome.storage.local.get(['savedSessions', 'collapsedSessions'], (result) => {
    let sessions = result.savedSessions || [];
    debug('[Sort] Sessions count:', sessions.length);
    if (sessions.length === 0) return;

    // Capture initial positions (FLIP technique - First)
    const initialPositions = new Map();
    document.querySelectorAll('.session-wrapper').forEach(wrapper => {
      const timestamp = wrapper.dataset.timestamp;
      if (timestamp) {
        const rect = wrapper.getBoundingClientRect();
        initialPositions.set(timestamp, rect.top);
      }
    });

    // Use provided direction
    const newDirection = direction;

    // Separate pinned and unpinned sessions
    const pinnedSessions = sessions.filter(s => s.pinned);
    const unpinnedSessions = sessions.filter(s => !s.pinned);
    debug('[Sort] Pinned:', pinnedSessions.length, 'Unpinned:', unpinnedSessions.length);

    // Sort unpinned sessions based on direction
    if (direction === 'rainbow') {
      // Rainbow sort: sort by color wheel order
      unpinnedSessions.sort((a, b) => {
        return getColorSortValue(a.color) - getColorSortValue(b.color);
      });
      debug('[Sort] Rainbow sorted unpinned sessions by color wheel order');
    } else if (direction === 'newest') {
      // Newest to Oldest: sort by timestamp descending (newest first)
      unpinnedSessions.sort((a, b) => {
        const timeA = new Date(a.timestamp).getTime();
        const timeB = new Date(b.timestamp).getTime();
        return timeB - timeA;
      });
      debug('[Sort] Sorted unpinned sessions by newest to oldest');
    } else if (direction === 'oldest') {
      // Oldest to Newest: sort by timestamp ascending (oldest first)
      unpinnedSessions.sort((a, b) => {
        const timeA = new Date(a.timestamp).getTime();
        const timeB = new Date(b.timestamp).getTime();
        return timeA - timeB;
      });
      debug('[Sort] Sorted unpinned sessions by oldest to newest');
    }

    const sortedSessions = [...pinnedSessions, ...unpinnedSessions];

    // Update global variable
    savedSessions = sortedSessions;

    // Set flag to prevent storage listener from overriding our sort
    isUpdatingFromStorage = true;

    // Save the reordered sessions (collapsed states unchanged since timestamps unchanged)
    chrome.storage.local.set({
      savedSessions: sortedSessions
    }, () => {
      debug('[Sort] Saved to storage, calling updateSessionList');
      updateSessionList(sortedSessions);

      // If advanced mode is active, also refresh the table
      if (viewMode === "fullscreen") {
        fullscreenData.allTabs = transformSessionsToTabs(sortedSessions);
        applyFiltersAndRender();
      }

      // Animate the reordering (FLIP technique - Last, Invert, Play)
      // Skip animation if user prefers reduced motion
      const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

      if (!prefersReducedMotion) {
        requestAnimationFrame(() => {
          const movedElements = [];

          document.querySelectorAll('.session-wrapper').forEach(wrapper => {
            const timestamp = wrapper.dataset.timestamp;
            if (timestamp && initialPositions.has(timestamp)) {
              const initialTop = initialPositions.get(timestamp);
              const finalRect = wrapper.getBoundingClientRect();
              const finalTop = finalRect.top;
              const delta = initialTop - finalTop;

              if (Math.abs(delta) > 1) { // Only animate if moved significantly
                movedElements.push({ wrapper, delta });
              }
            }
          });

          // Apply initial transform (Invert)
          movedElements.forEach(({ wrapper, delta }) => {
            wrapper.style.transform = `translateY(${delta}px)`;
            wrapper.style.transition = 'none';
          });

          // Force reflow
          if (movedElements.length > 0) {
            movedElements[0].wrapper.offsetHeight;
          }

          // Animate to final position (Play)
          requestAnimationFrame(() => {
            movedElements.forEach(({ wrapper }) => {
              wrapper.style.transform = '';
              wrapper.style.transition = 'transform 0.25s cubic-bezier(0.25, 0.46, 0.45, 0.94)';
            });

            // Clean up after animation
            setTimeout(() => {
              movedElements.forEach(({ wrapper }) => {
                wrapper.style.transform = '';
                wrapper.style.transition = '';
              });
            }, 250);
          });
        });
      }

      // Reset flag after update completes
      setTimeout(() => {
        isUpdatingFromStorage = false;
      }, 100);
    });
  });
}

// Trash duplicate tabs across all unlocked sessions
// Strategy: Locked sessions are never modified, but if a URL exists in a locked session,
// we delete ALL unlocked duplicates (even if they're older) since the locked one takes precedence
function handleTrashDuplicatesAction() {
  if (!savedSessions || savedSessions.length === 0) return;

  // Load Smart Groups to include them in duplicate detection
  chrome.storage.local.get(['smartGroups'], (result) => {
    const smartGroups = result.smartGroups || [];

    let totalDuplicatesRemoved = 0;
    const urlInfo = new Map(); // url -> Array of { source, sourceIndex, tabIndex, isLocked, isSmartGroup }
    const tabsToDelete = []; // Array of { source, sourceIndex, tabIndex, tab, isSmartGroup }

    // First pass: collect ALL occurrences of each URL from both sessions and Smart Groups
    savedSessions.forEach((session, sessionIndex) => {
      if (!session.tabs || !Array.isArray(session.tabs)) return;

      session.tabs.forEach((tab, tabIndex) => {
        const url = tab.url;
        if (!url) return;

        if (!urlInfo.has(url)) {
          urlInfo.set(url, []);
        }
        urlInfo.get(url).push({
          source: 'session',
          sourceIndex: sessionIndex,
          tabIndex,
          isLocked: session.locked,
          isSmartGroup: false,
          tab
        });
      });
    });

    // Also collect from Smart Groups
    smartGroups.forEach((group, groupIndex) => {
      if (!group.tabs || !Array.isArray(group.tabs)) return;

      group.tabs.forEach((tab, tabIndex) => {
        const url = tab.url;
        if (!url) return;

        if (!urlInfo.has(url)) {
          urlInfo.set(url, []);
        }
        urlInfo.get(url).push({
          source: 'smartGroup',
          sourceIndex: groupIndex,
          tabIndex,
          isLocked: false, // Smart Groups are not locked
          isSmartGroup: true,
          tab
        });
      });
    });

    // Second pass: for each URL, decide what to keep and what to delete
    urlInfo.forEach((occurrences, url) => {
      if (occurrences.length <= 1) return; // No duplicates

      const hasLockedOccurrence = occurrences.some(occ => occ.isLocked);

      if (hasLockedOccurrence) {
        // If any occurrence is locked, delete ALL unlocked duplicates
        occurrences.forEach(occ => {
          if (!occ.isLocked) {
            tabsToDelete.push({
              source: occ.source,
              sourceIndex: occ.sourceIndex,
              tabIndex: occ.tabIndex,
              tab: occ.tab,
              isSmartGroup: occ.isSmartGroup
            });
            totalDuplicatesRemoved++;
          }
        });
      } else {
        // No locked occurrences - keep only the oldest
        // For sessions: newest first, so highest index = oldest
        // For smart groups: keep first occurrence in first smart group
        let oldestIndex = -1;
        let oldestSessionIndex = -1;

        occurrences.forEach((occ, idx) => {
          // Prioritize sessions over smart groups when determining oldest
          if (occ.source === 'session') {
            if (occ.sourceIndex > oldestSessionIndex) {
              oldestSessionIndex = occ.sourceIndex;
              oldestIndex = idx;
            }
          } else if (oldestIndex === -1 || occurrences[oldestIndex].source === 'smartGroup') {
            // If we haven't found a session yet, or the current oldest is also a smart group
            if (oldestIndex === -1) {
              oldestIndex = idx;
            }
          }
        });

        // Delete all except the oldest
        occurrences.forEach((occ, idx) => {
          if (idx !== oldestIndex) {
            tabsToDelete.push({
              source: occ.source,
              sourceIndex: occ.sourceIndex,
              tabIndex: occ.tabIndex,
              tab: occ.tab,
              isSmartGroup: occ.isSmartGroup
            });
            totalDuplicatesRemoved++;
          }
        });
      }
    });

    if (totalDuplicatesRemoved === 0) {
      // No duplicates found - just return silently (no need for a message)
      return;
    }

    // Store original state for undo
    const opId = "trashDuplicates-" + Math.random().toString(36).substr(2, 8);
    const originalSessions = JSON.parse(JSON.stringify(savedSessions)); // Deep copy
    const originalSmartGroups = JSON.parse(JSON.stringify(smartGroups)); // Deep copy

    // Move duplicates to trash
    chrome.storage.local.get(["trashedLinks"], (result) => {
      const trashedLinks = result.trashedLinks || [];
      const trashIdsAdded = [];

      // Add all duplicates to trash
      tabsToDelete.forEach(({ tab }) => {
        const trashId = generateDeleteId();
        trashedLinks.push({
          id: trashId,
          url: tab.url,
          title: tab.title,
          icon: tab.icon,
          timestamp: Date.now()
        });
        trashIdsAdded.push(trashId);
      });

      // Separate tabs by source and sort in reverse order to avoid index shifting
      const sessionTabs = tabsToDelete.filter(t => t.source === 'session');
      const smartGroupTabs = tabsToDelete.filter(t => t.source === 'smartGroup');

      sessionTabs.sort((a, b) => {
        if (a.sourceIndex !== b.sourceIndex) {
          return b.sourceIndex - a.sourceIndex;
        }
        return b.tabIndex - a.tabIndex;
      });

      smartGroupTabs.sort((a, b) => {
        if (a.sourceIndex !== b.sourceIndex) {
          return b.sourceIndex - a.sourceIndex;
        }
        return b.tabIndex - a.tabIndex;
      });

      // Remove duplicates from sessions
      sessionTabs.forEach(({ sourceIndex, tabIndex }) => {
        savedSessions[sourceIndex].tabs.splice(tabIndex, 1);
      });

      // Remove duplicates from Smart Groups
      smartGroupTabs.forEach(({ sourceIndex, tabIndex }) => {
        smartGroups[sourceIndex].tabs.splice(tabIndex, 1);
      });

      // Remove any sessions that are now empty
      const sessionsToRemove = [];
      savedSessions.forEach((session, index) => {
        if (!session.locked && (!session.tabs || session.tabs.length === 0)) {
          sessionsToRemove.push(index);
        }
      });

      // Remove empty sessions in reverse order
      sessionsToRemove.reverse().forEach(index => {
        savedSessions.splice(index, 1);
      });

      // Note: We don't remove empty Smart Groups - they stay even if empty

      // Save updated data
      chrome.storage.local.set({ savedSessions, smartGroups, trashedLinks }, () => {
        updateSessionList(savedSessions);
        refreshBadge();

        // Set up undo operation
        pendingOperations[opId] = {
          type: "trashDuplicates",
          originalSessions,
          originalSmartGroups,
          trashIdsAdded,
          count: totalDuplicatesRemoved
        };

        // Show undo bubble
        const message = chrome.i18n.getMessage('duplicatesRemoved')
          ? chrome.i18n.getMessage('duplicatesRemoved').replace('{count}', totalDuplicatesRemoved)
          : `${totalDuplicatesRemoved} duplicate${totalDuplicatesRemoved === 1 ? '' : 's'} removed`;

        showUndoBubble(opId, message, "", { type: 'trashDuplicates' });

        const timerId = setTimeout(() => {
          finalizePendingOperation(opId);
        }, UNDO_TIMEOUT_MS);

        pendingOperations[opId].timerId = timerId;
      });
    });
  });
}

// Reset all group colors to default
function handleResetGroupColors() {
  const selectedTabs = getSelectedTabs();
  if (selectedTabs.length === 0) return;

  // Get unique session timestamps from selected items
  const sessionTimestamps = new Set();
  selectedTabs.forEach(item => {
    if (item.type === 'session') {
      sessionTimestamps.add(item.timestamp);
    } else if (item.type === 'tab') {
      // If tab is selected, reset color of its parent session
      sessionTimestamps.add(item.sessionTimestamp);
    }
  });

  if (sessionTimestamps.size === 0) return;

  chrome.storage.local.get(['savedSessions'], (result) => {
    let sessions = result.savedSessions || [];
    let changed = false;

    // Reset colors only for selected sessions (but NOT smart group filter colors - those persist)
    sessions = sessions.map(session => {
      if (sessionTimestamps.has(session.timestamp) && session.color) {
        changed = true;
        const updated = { ...session };
        delete updated.color;
        return updated;
      }
      return session;
    });

    if (!changed) {
      return; // Nothing to reset
    }

    // Save changes
    chrome.storage.local.set({ savedSessions: sessions }, () => {
      // In fullscreen mode, refresh the table
      if (document.body.getAttribute('data-view-mode') === 'fullscreen') {
        savedSessions = sessions;
        const allTabs = transformSessionsToFullscreenTabs(sessions);
        fullscreenData.allTabs = allTabs;
        populateFilterDropdowns(allTabs);
        applyFiltersAndRender();
      } else {
        updateSessionList(sessions);
      }
    });
  });
}

// Update Reset Group Colors button visibility and state
function updateResetGroupColorsButtonState() {
  const resetBtn = document.getElementById('toolbar-reset-colors-btn');
  if (!resetBtn) return;

  // In fullscreen/advanced mode, updateBulkActionsBar() handles the button state
  // based on selection, so don't interfere
  if (document.body.getAttribute('data-view-mode') === 'fullscreen') {
    return;
  }

  resetBtn.style.display = '';

  // In regular mode, check if any sessions have colors (not checking smart groups - those keep their colors)
  chrome.storage.local.get(['savedSessions'], (result) => {
    const sessions = result.savedSessions || [];
    const hasColors = sessions.some(s => s.color);
    resetBtn.disabled = !hasColors;
  });
}

// Copy all sessions to clipboard in Markdown format
async function handleCopyAllToClipboard() {
  if (!savedSessions || savedSessions.length === 0) {
    return; // Nothing to copy
  }

  // Generate Markdown export
  let output = "";
  savedSessions.forEach(session => {
    const title = session.customName || new Date(session.timestamp).toLocaleString();
    output += "## " + title + "\n\n";
    if (session.tabs && session.tabs.length > 0) {
      session.tabs.forEach(tab => {
        output += "- [" + tab.title + "](" + tab.url + ")\n";
      });
    }
    output += "\n";
  });

  // Try to copy to clipboard
  try {
    // Method 1: Modern Clipboard API
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(output);
      return;
    }
  } catch (err) {
    // Clipboard API failed, trying fallback
  }

  // Method 2: Legacy fallback
  try {
    const textArea = document.createElement('textarea');
    textArea.value = output;
    textArea.style.position = 'fixed';
    textArea.style.top = '0';
    textArea.style.left = '0';
    textArea.style.opacity = '0';

    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();

    document.execCommand('copy');
    document.body.removeChild(textArea);
  } catch (err) {
    debug('Failed to copy to clipboard:', err);
  }
}

// Parse and create a new session from clipboard URLs
async function handleClipboardPaste(e) {
  try {
    // Do not intercept when user is typing into an input/textarea/contenteditable
    // EXCEPT when it's our special paste target element
    const active = document.activeElement;
    const isPasteTarget = active && active.hasAttribute('data-tabstract-paste-target');
    const isTyping = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable) && !isPasteTarget;
    if (isTyping) return;
    if (currentView === 'trash') return;

    const text = (e.clipboardData && e.clipboardData.getData('text/plain')) || '';
    if (!text) return;

    const urls = extractUrlsFromText(text);
    if (!urls || urls.length === 0) return;

    // We will handle the paste action by creating a new session
    e.preventDefault();

    chrome.storage.local.get(['savedSessions', 'avoidDuplicates', 'aiTitleSuggestions', 'aiSmartCategorization'], async (result) => {
      const sessions = result.savedSessions || [];
      const dedupe = (result.avoidDuplicates === undefined) ? true : !!result.avoidDuplicates;
      const aiTitleEnabled = !!result.aiTitleSuggestions;
      const aiCategorizationEnabled = !!result.aiSmartCategorization;
      const list = dedupe ? Array.from(new Set(urls)) : urls;
      const ts = new Date().toISOString();
      const tabs = list.map(url => ({ url, title: url }));

      // Simple check to set initial pending flags (background.js will make final decision)
      const aiOperational = aiAvailabilityState !== false;
      const mightCategorize = aiOperational && aiCategorizationEnabled && tabs.length >= 7;
      const mightGenerateTitle = aiOperational && aiTitleEnabled && tabs.length > 0 && !mightCategorize;
      const now = Date.now();

      const newSession = {
        timestamp: ts,
        tabs,
        pendingCategorization: mightCategorize,
        pendingCategorizationStartedAt: mightCategorize ? now : undefined,
        pendingTitle: mightGenerateTitle,
        pendingTitleStartedAt: mightGenerateTitle ? now : undefined
      };

      // Add session immediately to show it to the user
      sessions.unshift(newSession);
      savedSessions = sessions;
      chrome.storage.local.set({ savedSessions: sessions }, () => {
        updateSessionList(sessions);
        setTimeout(() => highlightAddSession(ts), 50);
      });

      // Fetch titles for all pasted URLs in the background with live UI updates
      const titleQueue = new TitleFetchQueue(3, 200);
      const fetchPromises = tabs.map(tab => {
        return titleQueue.addWithCallback(tab.url, tab, (title) => {
          // Update storage and UI immediately when each title is fetched
          debug('[Tabstract] Title fetched, updating UI for:', title);
          chrome.storage.local.set({ savedSessions: sessions }, () => {
            updateSessionList(sessions);
          });
        });
      });

      // After all titles are fetched, run AI processing if enabled
      Promise.all(fetchPromises).then(() => {
        debug('[Tabstract] All titles fetched for pasted links, sending to background for AI processing');
        chrome.runtime.sendMessage({
          action: 'processPastedSession',
          timestamp: ts,
          tabs: tabs,
          aiTitleEnabled: aiTitleEnabled,
          aiCategorizationEnabled: aiCategorizationEnabled
        });
      }).catch(err => {
        debug('[Tabstract] Error fetching titles for pasted links:', err);
      });
    });
  } catch (err) {
    // Fail silently if clipboard is inaccessible or parsing fails
    debug('Paste-to-session failed:', err);
  }
}

function extractUrlsFromText(text) {
  if (!text || typeof text !== 'string') return [];
  // Match http/https URLs; allow until whitespace or typical terminators
  const regex = /https?:\/\/[^\s<>"']+/gi;
  const matches = text.match(regex) || [];
  const out = [];
  for (const raw of matches) {
    let cleaned = raw.trim();
    if (!cleaned) continue;

    // Strip common trailing punctuation (from markdown links, sentences, etc.)
    // Remove trailing ), ], ., ,, ;, :, !, ? repeatedly until none remain
    while (/[)\].,;:!?]$/.test(cleaned)) {
      cleaned = cleaned.slice(0, -1);
    }

    if (!cleaned) continue;

    try {
      const u = new URL(cleaned);
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        out.push(u.toString());
      }
    } catch (_) { /* ignore invalid */ }
  }
  return out;
}


function extractAllTabsData() {
  const tabs = [];
  savedSessions.forEach((session, sessionIndex) => {
    session.tabs.forEach((tab, tabIndex) => {
      tabs.push({
        ...tab,
        sessionIndex,
        tabIndex,
        sessionTitle: session.title || `Session ${sessionIndex + 1}`,
        sessionId: session.timestamp || session.id
      });
    });
  });
  return tabs;
}

function handleSearchInput(e) {
  const query = e.target.value.trim();

  if (!query) {
    clearSearch();
    return;
  }

  // Parse search query for special filters
  const { hasInTrash, cleanQuery } = parseSearchQuery(query);

  // Auto-switch views based on the trash filter
  if (hasInTrash && currentView !== 'trash') {
    switchToTrashView();
    // Re-run search after view switch with clean query
    setTimeout(() => {
      const results = searchTabs(cleanQuery.toLowerCase(), true);
      displaySearchResults(results, cleanQuery.toLowerCase());
    }, 100);
    return;
  } else if (shouldPrefillTrashFilter && !hasInTrash && currentView === 'trash') {
    switchToActiveView();
    // Re-run search after view switch
    setTimeout(() => {
      const results = searchTabs(cleanQuery.toLowerCase(), false);
      displaySearchResults(results, cleanQuery.toLowerCase());
    }, 100);
    return;
  }

  // Mark search as active if not already
  if (!isSearchActive) {
    isSearchActive = true;
    document.body.classList.add('search-active');
  }

  const results = searchTabs(cleanQuery.toLowerCase(), currentView === 'trash');
  displaySearchResults(results, cleanQuery.toLowerCase());
}

/**
 * Parse search query for special filters
 */
function parseSearchQuery(query) {
  const hasInTrash = /in:trash/i.test(query);
  const cleanQuery = query.replace(/in:trash\s*/gi, '').trim();

  return { hasInTrash, cleanQuery };
}

function searchTabs(query, searchInTrash = false) {
  // Escape regex special characters except asterisk (wildcard)
  const escapeRegexExceptWildcard = (str) => {
    return str.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  };

  if (searchInTrash) {
    // Search in trash data
    const escapedQuery = escapeRegexExceptWildcard(query);
    const wildcardPattern = escapedQuery.replace(/\*/g, '.*');
    const regex = new RegExp(wildcardPattern, 'i');

    return trashedLinks.filter(link => {
      return regex.test(link.title) || regex.test(link.url);
    }).map(link => ({
      title: link.title,
      url: link.url,
      linkId: link.id,
      sessionId: 'trash',
      sessionIndex: -1,
      isTrash: true
    }));
  } else {
    // Search in active sessions
    const escapedQuery = escapeRegexExceptWildcard(query);
    const wildcardPattern = escapedQuery.replace(/\*/g, '.*');
    const regex = new RegExp(wildcardPattern, 'i');

    return allTabsData.filter(tab => {
      return regex.test(tab.title) || regex.test(tab.url);
    });
  }
}

function displaySearchResults(results, query) {
  // Store results and query for Pro actions
  currentSearchResults = results;
  currentSearchQuery = query;

  const tabList = document.getElementById('tabList');
  const inTrashView = currentView === 'trash';

  // Choose icon based on view (trash icon if in trash, magnifying glass otherwise)
  const iconSvg = inTrashView
    ? `<svg viewBox="0 0 31.179 38.1519" aria-hidden="true" style="width: 16px; height: 16px; margin-right: 8px; fill: var(--danger);">
         <path d="M10.8009 29.9681C11.4594 29.9681 11.8837 29.5509 11.8681 28.9366L11.3894 12.5553C11.3709 11.9465 10.9409 11.5422 10.3109 11.5422C9.65812 11.5422 9.23655 11.9594 9.25218 12.5709L9.71812 28.945C9.73655 29.5666 10.1694 29.9681 10.8009 29.9681ZM15.4034 29.9681C16.0506 29.9681 16.5062 29.5566 16.5062 28.9478L16.5062 12.5653C16.5062 11.9565 16.0506 11.5422 15.4034 11.5422C14.7534 11.5422 14.3106 11.9565 14.3106 12.5653L14.3106 28.9478C14.3106 29.5566 14.7534 29.9681 15.4034 29.9681ZM20.0159 29.9681C20.6375 29.9681 21.0675 29.5666 21.0859 28.945L21.5519 12.5709C21.5675 11.9594 21.1459 11.5422 20.4931 11.5422C19.8631 11.5422 19.4331 11.9465 19.4147 12.5681L18.9487 28.9366C18.9331 29.5509 19.3575 29.9681 20.0159 29.9681ZM8.305 7.18844L11.1887 7.18844L11.1887 3.94312C11.1887 3.13405 11.7547 2.61499 12.6247 2.61499L18.1537 2.61499C19.0237 2.61499 19.5897 3.13405 19.5897 3.94312L19.5897 7.18844L22.4734 7.18844L22.4734 3.79812C22.4734 1.40875 20.9484 0 18.3594 0L12.4191 0C9.83 0 8.305 1.40875 8.305 3.79812ZM1.3828 8.88842L29.434 8.88842C30.204 8.88842 30.804 8.27686 30.804 7.50686C30.804 6.74249 30.204 6.14375 29.434 6.14375L1.3828 6.14375C0.625622 6.14375 0 6.74249 0 7.50686C0 8.28967 0.625622 8.88842 1.3828 8.88842ZM8.22749 35.2581L22.5894 35.2581C24.9812 35.2581 26.5347 33.7937 26.6469 31.3991L27.7209 8.58873L24.8228 8.58873L23.7956 30.9337C23.7644 31.8712 23.1459 32.4937 22.255 32.4937L8.53624 32.4937C7.67092 32.4937 7.05248 31.8556 7.00842 30.9337L5.92998 8.58873L3.08312 8.58873L4.17 31.4119C4.285 33.8065 5.81 35.2581 8.22749 35.2581Z"/>
       </svg>`
    : `<svg viewBox="0 0 24 24" aria-hidden="true" style="width: 16px; height: 16px; margin-right: 8px;">
         <path d="M21 21L16.514 16.506M19 10.5C19 15.194 15.194 19 10.5 19S2 15.194 2 10.5S5.806 2 10.5 2S19 5.806 19 10.5Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
       </svg>`;

  const titlePrefix = inTrashView ? 'Trash - ' : '';

  if (results.length === 0) {
    tabList.innerHTML = `
      <div class="session-wrapper">
        <div class="session-header">
          <div class="session-title-container">
            ${iconSvg}
            <span class="session-title">${titlePrefix}${getMessage("noResultsFound")} "${query}"</span>
          </div>
        </div>
      </div>
    `;
    return;
  }

  // Display all results in a single session wrapper
  let html = `
    <div class="session-wrapper">
      <div class="session-header">
        <div class="session-title-container">
          ${iconSvg}
          <span class="session-title">${titlePrefix}${getMessage("searchResults")} (${results.length})</span>
        </div>
      </div>
      <div class="session-card">
        <ul>
  `;
  
  results.forEach(tab => {
    const session = savedSessions[tab.sessionIndex];
    const isLocked = session && session.locked;

    // For trash results, show restore/delete actions instead of just delete button
    let actionsHtml = '';
    if (tab.isTrash) {
      actionsHtml = `
        <div class="trash-actions" style="display: flex; gap: 8px;">
          <a href="#" class="open-session-link search-restore-link" title="${getMessage('bulkActionRestore')}" data-link-id="${tab.linkId}" tabindex="0" aria-label="${getMessage('bulkActionRestore')} ${escapeHtml(tab.title)}">
            <svg viewBox="0 0 28.0382 27.6857" aria-hidden="true">
             <g>
              <path d="M4.20878 27.6632L23.4431 27.6632C26.2182 27.6632 27.6632 26.1888 27.6632 23.465L27.6632 4.20253C27.6632 1.47876 26.2182 0 23.4431 0L4.20878 0C1.44938 0 0 1.44501 0 4.20253L0 23.465C0 26.2225 1.44938 27.6632 4.20878 27.6632ZM4.25128 26.5087C2.22755 26.5087 1.16568 25.4444 1.16568 23.4031L1.16568 4.2644C1.16568 2.22317 2.22755 1.16568 4.25128 1.16568L23.4119 1.16568C25.375 1.16568 26.4975 2.22317 26.4975 4.2644L26.4975 23.4031C26.4975 25.4444 25.375 26.5087 23.4119 26.5087Z"/>
              <path d="M14.4432 20.1081L14.4432 7.51941C14.4432 7.16127 14.1775 6.90688 13.8238 6.90688C13.4969 6.90688 13.2356 7.17252 13.2356 7.51941L13.2356 20.1081C13.2356 20.4506 13.4969 20.7275 13.8238 20.7275C14.1775 20.7275 14.4432 20.4663 14.4432 20.1081ZM7.53941 14.4188L20.1438 14.4188C20.475 14.4188 20.7519 14.1507 20.7519 13.835C20.7519 13.4813 20.4975 13.2044 20.1438 13.2044L7.53941 13.2044C7.18127 13.2044 6.93126 13.4813 6.93126 13.835C6.93126 14.1507 7.20377 14.4188 7.53941 14.4188Z"/>
             </g>
            </svg>
          </a>
          <a href="#" class="delete-session-link search-delete-link" title="${getMessage('draftDelete')}" data-link-id="${tab.linkId}" tabindex="0" aria-label="${getMessage('draftDelete')} ${escapeHtml(tab.title)}">
            <svg version="1.1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 28.0382 27.6857" aria-hidden="true">
             <g>
              <path d="M4.20878 27.6632L23.4431 27.6632C26.2182 27.6632 27.6632 26.1888 27.6632 23.465L27.6632 4.20253C27.6632 1.47876 26.2182 0 23.4431 0L4.20878 0C1.44938 0 0 1.44501 0 4.20253L0 23.465C0 26.2225 1.44938 27.6632 4.20878 27.6632ZM4.25128 26.5087C2.22755 26.5087 1.16568 25.4444 1.16568 23.4031L1.16568 4.2644C1.16568 2.22317 2.22755 1.16568 4.25128 1.16568L23.4119 1.16568C25.375 1.16568 26.4975 2.22317 26.4975 4.2644L26.4975 23.4031C26.4975 25.4444 25.375 26.5087 23.4119 26.5087Z"/>
              <path d="M8.72005 19.8513L19.8669 8.70005C20.0157 8.55567 20.0732 8.40504 20.0732 8.23003C20.0732 7.89127 19.8075 7.63688 19.4531 7.63688C19.2669 7.63688 19.1319 7.69439 18.9762 7.85439L7.80502 19.0081C7.66064 19.1569 7.59876 19.2919 7.59876 19.4713C7.59876 19.8144 7.88002 20.0732 8.23003 20.0732C8.43629 20.0732 8.56442 20.0069 8.72005 19.8513ZM18.9675 19.8513C19.1231 20.0069 19.2513 20.0732 19.4531 20.0732C19.8075 20.0732 20.0732 19.8144 20.0732 19.4713C20.0732 19.2919 20.0157 19.1569 19.8669 19.0081L8.7113 7.85439C8.55567 7.69439 8.41629 7.63688 8.23003 7.63688C7.88002 7.63688 7.59876 7.89127 7.59876 8.23003C7.59876 8.40504 7.66064 8.55567 7.80502 8.70005Z"/>
             </g>
            </svg>
          </a>
        </div>
      `;
    } else {
      actionsHtml = `<button class="clear-btn" data-session-timestamp="${tab.sessionId}" data-tab-url="${escapeHtml(tab.url)}" title="Delete this tab" data-i18n-title="deleteTab" ${isLocked ? 'style="display: none;"' : ''}>
        <svg viewBox="0 0 31.179 38.1519" aria-hidden="true">
          <path fill="currentColor" d="M10.8009 29.9681C11.4594 29.9681 11.8837 29.5509 11.8681 28.9366L11.3894 12.5553C11.3709 11.9465 10.9409 11.5422 10.3109 11.5422C9.65812 11.5422 9.23655 11.9594 9.25218 12.5709L9.71812 28.945C9.73655 29.5666 10.1694 29.9681 10.8009 29.9681ZM15.4034 29.9681C16.0506 29.9681 16.5062 29.5566 16.5062 28.9478L16.5062 12.5653C16.5062 11.9565 16.0506 11.5422 15.4034 11.5422C14.7534 11.5422 14.3106 11.9565 14.3106 12.5653L14.3106 28.9478C14.3106 29.5566 14.7534 29.9681 15.4034 29.9681ZM20.0159 29.9681C20.6375 29.9681 21.0675 29.5666 21.0859 28.945L21.5519 12.5709C21.5675 11.9594 21.1459 11.5422 20.4931 11.5422C19.8631 11.5422 19.4331 11.9465 19.4147 12.5681L18.9487 28.9366C18.9331 29.5509 19.3575 29.9681 20.0159 29.9681ZM8.305 7.18844L11.1887 7.18844L11.1887 3.94312C11.1887 3.13405 11.7547 2.61499 12.6247 2.61499L18.1537 2.61499C19.0237 2.61499 19.5897 3.13405 19.5897 3.94312L19.5897 7.18844L22.4734 7.18844L22.4734 3.79812C22.4734 1.40875 20.9484 0 18.3594 0L12.4191 0C9.83 0 8.305 1.40875 8.305 3.79812ZM1.3828 8.88842L29.434 8.88842C30.204 8.88842 30.804 8.27686 30.804 7.50686C30.804 6.74249 30.204 6.14375 29.434 6.14375L1.3828 6.14375C0.625622 6.14375 0 6.74249 0 7.50686C0 8.28967 0.625622 8.88842 1.3828 8.88842ZM8.22749 35.2581L22.5894 35.2581C24.9812 35.2581 26.5347 33.7937 26.6469 31.3991L27.7209 8.58873L24.8228 8.58873L23.7956 30.9337C23.7644 31.8712 23.1459 32.4937 22.255 32.4937L8.53624 32.4937C7.67092 32.4937 7.05248 31.8556 7.00842 30.9337L5.92998 8.58873L3.08312 8.58873L4.17 31.4119C4.285 33.8065 5.81 35.2581 8.22749 35.2581Z"/>
        </svg>
      </button>`;
    }

    const lockedClass = isLocked ? ' search-result-locked' : '';
    html += `
      <li class="link-row${lockedClass}">
        <a href="#" data-url="${escapeHtml(tab.url)}" data-timestamp="${tab.sessionId}" title="${escapeHtml(tab.url)}">
          <div class="favicon-wrap">
            <img src="${computeFavicon(tab.url)}" alt="" class="search-favicon">
          </div>
          <div class="link-text">
            <div class="link-title">${highlightMatch(escapeHtml(tab.title), query)}</div>
            <div class="link-url">${highlightMatch(escapeHtml(tab.url), query)}</div>
          </div>
        </a>
        ${actionsHtml}
      </li>
    `;
  });
  
  html += `
        </ul>
      </div>
    </div>
  `;
  
  tabList.innerHTML = html;

  // Wire up link clicks for search results
  wireSearchResultClicks();
}

function highlightMatch(text, query) {
  if (!query) return text;

  // Escape regex special characters except asterisk (wildcard)
  const escapedQuery = query.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  // Convert wildcard pattern to regex for highlighting
  const wildcardPattern = escapedQuery.replace(/\*/g, '.*');
  const regex = new RegExp(`(${wildcardPattern})`, 'gi');

  return text.replace(regex, '<mark>$1</mark>');
}

function wireSearchResultClicks() {
  const searchLinks = document.querySelectorAll('.session-wrapper a[data-url]');
  searchLinks.forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      let shiftKey = e.shiftKey;
      const altKey = e.altKey;  // Now detect Option key instead of Command
      if (altKey) {
        shiftKey = false;
      }
      const url = link.getAttribute('data-url');
      const timestamp = link.getAttribute('data-timestamp');
      if (url) {
        chrome.runtime.sendMessage({
          action: "openSingleTab",
          url: url,
          timestamp: timestamp,
          invertDelete: shiftKey,
          invertBackground: altKey
        });
      }
    });
  });
  
  // Wire up favicon error handling for search results
  const searchFavicons = document.querySelectorAll('.search-favicon');
  searchFavicons.forEach(img => {
    img.addEventListener('error', () => {
      img.src = 'images/default_favicon.png';
    });
  });
  
  // Wire up delete buttons for search results - find current indices to avoid stale data
  const deleteButtons = document.querySelectorAll('.session-wrapper .clear-btn[data-session-timestamp]');
  deleteButtons.forEach(button => {
    button.addEventListener('click', (e) => {
      e.preventDefault();
      const tabUrl = button.getAttribute('data-tab-url');
      const sessionTimestamp = button.getAttribute('data-session-timestamp');

      // Find current session index by timestamp (more reliable than cached index)
      const currentSessionIndex = savedSessions.findIndex(s => s.timestamp.toString() === sessionTimestamp);

      if (currentSessionIndex === -1) {
        // Session no longer exists, refresh search results
        if (isSearchActive) {
          const searchInput = document.getElementById('searchInput');
          if (searchInput) {
            const rawQuery = searchInput.value.trim();
            if (rawQuery) {
              const { hasInTrash, cleanQuery } = parseSearchQuery(rawQuery);
              const loweredQuery = cleanQuery.toLowerCase();
              const results = searchTabs(loweredQuery, hasInTrash || currentView === 'trash');
              displaySearchResults(results, loweredQuery);
            }
          }
        }
        return;
      }

      // Use the existing delete function with current session index
      // It will find the correct tab index by URL
      doPendingDeleteTab(currentSessionIndex, tabUrl, -1);
    });
  });

  // Wire up restore buttons for trash search results
  const restoreButtons = document.querySelectorAll('.search-restore-link');
  restoreButtons.forEach(button => {
    button.addEventListener('click', (e) => {
      e.preventDefault();
      const linkId = button.getAttribute('data-link-id');
      restoreLink(linkId);
    });
  });

  // Wire up delete buttons for trash search results
  const trashDeleteButtons = document.querySelectorAll('.search-delete-link');
  trashDeleteButtons.forEach(button => {
    button.addEventListener('click', (e) => {
      e.preventDefault();
      const linkId = button.getAttribute('data-link-id');
      permanentlyDeleteLink(linkId);
    });
  });

  // Re-wire hover effects for search results
  wireRowHover();
}


function clearSearch() {
  const searchInput = document.getElementById('searchInput');
  const searchClear = document.getElementById('searchClear');
  const tabList = document.getElementById('tabList');
  
  if (searchInput) searchInput.value = '';
  if (searchClear) searchClear.classList.remove('visible');
  
  if (isSearchActive) {
    isSearchActive = false;
    document.body.classList.remove('search-active');
    // Keep the user on the current view. If in trash, re-render trash; otherwise, regenerate sessions.
    if (currentView === 'trash') {
      renderTrashView();
    } else {
      updateSessionList(savedSessions);
    }
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Create a sample session to help new users understand how Tabstract works
 */
function createSampleSession() {
  const sampleSession = {
    timestamp: new Date().toISOString(),
    customName: getMessage("sampleSessionName"),
    tabs: [
      {
        url: "https://tabstract.app",
        title: getMessage("sampleTab1Title"),
        allIds: [Math.floor(Math.random() * 100000)]
      },
      {
        url: "https://apps.apple.com/app/tabstract/id6743376666",
        title: getMessage("sampleTab2Title"),
        allIds: [Math.floor(Math.random() * 100000)]
      },
      {
        url: "https://apps.apple.com/app/tabstract/id6743376666?action=write-review",
        title: getMessage("sampleTab3Title"),
        allIds: [Math.floor(Math.random() * 100000)]
      }
    ]
  };

  // Get current sessions and add the sample
  chrome.storage.local.get('savedSessions', (result) => {
    const sessions = result.savedSessions || [];
    sessions.push(sampleSession);

    // Update total sessions count
    chrome.storage.local.get('totalSessionsSaved', (countResult) => {
      const newTotal = (countResult.totalSessionsSaved || 0) + 1;
      chrome.storage.local.set({
        savedSessions: sessions,
        totalSessionsSaved: newTotal
      }, () => {
        // Refresh the display
        updateSessionList(sessions);
        // Fade-in for newly rendered list
        const listEl = document.getElementById('tabList');
        if (listEl) {
          listEl.classList.add('fade-in');
          setTimeout(() => listEl.classList.remove('fade-in'), 260);
        }
        // Update badge
        refreshBadge();

        // Show a brief success message
        const button = document.getElementById('saveSampleSession');
        if (button) {
          const originalText = button.innerHTML;
          button.innerHTML = `
            <svg class="button-icon" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" fill="currentColor"/>
            </svg>
            ${getMessage("sampleSessionCreated")}
          `;
          button.disabled = true;

          setTimeout(() => {
            // The button will be gone because updateSessionList will replace the welcome screen
          }, 1000);
        }
      });
    });
  });
}

// ================================================
// Export/Import Helper Functions
// ================================================

async function copyRichText(htmlContent, plainContent) {
  // Copy HTML content as rich text (formatted) with plain text fallback
  if (navigator.clipboard && navigator.clipboard.write) {
    try {
      const htmlBlob = new Blob([htmlContent], { type: 'text/html' });
      const textBlob = new Blob([plainContent], { type: 'text/plain' });
      const clipboardItem = new ClipboardItem({
        'text/html': htmlBlob,
        'text/plain': textBlob
      });
      await navigator.clipboard.write([clipboardItem]);
      return;
    } catch (err) {
      debug('ClipboardItem method failed:', err);
      // Fall back to plain text if rich text copy fails
      return copyToClipboard(plainContent);
    }
  }

  // Fallback: just copy plain text if modern API not available
  return copyToClipboard(plainContent);
}

async function copyToClipboard(text) {
  // Method 1: Modern Clipboard API
  if (navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch (err) {
      // Clipboard API failed, trying fallback method
    }
  }

  // Method 2: Legacy document.execCommand fallback
  try {
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.style.position = 'fixed';
    textArea.style.top = '0';
    textArea.style.left = '0';
    textArea.style.width = '2em';
    textArea.style.height = '2em';
    textArea.style.padding = '0';
    textArea.style.border = 'none';
    textArea.style.outline = 'none';
    textArea.style.boxShadow = 'none';
    textArea.style.background = 'transparent';
    textArea.style.opacity = '0';

    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();

    const successful = document.execCommand('copy');
    document.body.removeChild(textArea);

    if (successful) {
      return;
    } else {
      throw new Error('execCommand copy failed');
    }
  } catch (err) {
    debug('All clipboard methods failed:', err);
    throw new Error('Unable to copy to clipboard');
  }
}

function escapeXml(unsafe) {
  return unsafe.replace(/[<>&'"]/g, function(c) {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case '\'': return '&apos;';
      case '"': return '&quot;';
      default: return c;
    }
  });
}

function generateRTFExport(sessions) {
  // RTF escape function for special characters
  function escapeRTF(text) {
    return text
      .replace(/\\/g, '\\\\')
      .replace(/\{/g, '\\{')
      .replace(/\}/g, '\\}')
      .replace(/\n/g, '\\line ')
      .replace(/[\u0080-\uFFFF]/g, (char) => '\\u' + char.charCodeAt(0) + '?');
  }

  // Start RTF document
  let rtf = '{\\rtf1\\ansi\\deff0\n';
  rtf += '{\\fonttbl{\\f0\\fswiss\\fcharset0 Helvetica;}{\\f1\\fmodern\\fcharset0 Courier;}}\n';
  rtf += '{\\colortbl;\\red0\\green122\\blue255;}\n'; // Blue color for links
  rtf += '\\viewkind4\\uc1\\pard\\f0\\fs24\n\n';

  sessions.forEach(session => {
    const title = session.customName || new Date(session.timestamp).toLocaleString();
    // Session title in bold, larger font
    rtf += '{\\b\\fs28 ' + escapeRTF(title) + '}\\par\n';
    rtf += '\\par\n'; // Empty line

    session.tabs.forEach(tab => {
      const tabTitle = tab.title || tab.url;
      // Create hyperlink with blue color
      rtf += '{\\field{\\*\\fldinst{HYPERLINK "' + escapeRTF(tab.url) + '"}}{\\fldrslt{\\ul\\cf1 ' + escapeRTF(tabTitle) + '}}}\\par\n';
    });
    rtf += '\\par\n'; // Empty line between sessions
  });

  rtf += '}';
  return rtf;
}

function generatePlainTextExport(sessions) {
  let output = "";
  sessions.forEach(session => {
    if (!session.skipSessionHeader) {
      const title = session.customName || new Date(session.timestamp).toLocaleString();
      output += "Session: " + title + "\n";
    }
    session.tabs.forEach(tab => {
      output += tab.title + "\t" + tab.url + "\n";
    });
    if (!session.skipSessionHeader) {
      output += "\n";
    }
  });
  return output;
}

function generateMarkdownExport(sessions) {
  let output = "";
  sessions.forEach(session => {
    if (!session.skipSessionHeader) {
      const title = session.customName || new Date(session.timestamp).toLocaleString();
      output += "### " + title + "\n\n";
    }
    session.tabs.forEach(tab => {
      output += "- [" + (tab.title || tab.url) + "](" + tab.url + ")\n";
    });
    if (!session.skipSessionHeader) {
      output += "\n";
    }
  });
  return output;
}

function generateHTMLExport(sessions) {
  let body = "";
  sessions.forEach(session => {
    if (!session.skipSessionHeader) {
      const title = session.customName || new Date(session.timestamp).toLocaleString();
      body += "<h3>" + escapeHtml(title) + "</h3>\n";
    }
    body += "<ul>\n";
    session.tabs.forEach(tab => {
      body += "<li><a href=\"" + escapeHtml(tab.url) + "\">" + escapeHtml(tab.title || tab.url) + "</a></li>\n";
    });
    body += "</ul>\n";
  });
  return "<!DOCTYPE html>\n<html>\n<head>\n<meta charset=\"UTF-8\">\n</head>\n<body>\n" + body + "</body>\n</html>";
}

function generateOPMLExport(sessions) {
  let opml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
  opml += `<opml version="2.0">\n`;
  opml += `  <head>\n`;
  opml += `    <title>Exported Links</title>\n`;
  opml += `  </head>\n`;
  opml += `  <body>\n`;
  sessions.forEach(session => {
    const title = session.customName || new Date(session.timestamp).toLocaleString();
    opml += `    <outline text="${escapeXml(title)}">\n`;
    session.tabs.forEach(tab => {
      const tabTitle = tab.title || tab.url;
      opml += `      <outline text="${escapeXml(tabTitle)}" type="link" htmlUrl="${escapeXml(tab.url)}" />\n`;
    });
    opml += `    </outline>\n`;
  });
  opml += `  </body>\n`;
  opml += `</opml>\n`;
  return opml;
}

function handleCopy(format) {
  chrome.storage.local.get(["savedSessions"], (result) => {
    let sessions = result.savedSessions || [];
    if (!sessions || sessions.length === 0) {
      alert(getMessage("noSavedLinksToExport"));
      return;
    }

    if (format === "rich") {
      // For rich text, we need to copy HTML with proper formatting
      const htmlContent = generateHTMLExport(sessions);
      const plainContent = generatePlainTextExport(sessions);

      copyRichText(htmlContent, plainContent)
        .catch(err => {
          debug('Failed to copy rich text to clipboard:', err);
        });
    } else {
      let copyText = "";

      switch (format) {
        case "markdown":
          copyText = generateMarkdownExport(sessions);
          break;
        case "plain":
          copyText = generatePlainTextExport(sessions);
          break;
        default:
          copyText = generateMarkdownExport(sessions);
      }

      copyToClipboard(copyText)
        .catch(err => {
          debug('Failed to copy to clipboard:', err);
        });
    }
  });
}

// Copy a single session to clipboard
function handleSessionCopy(timestamp, format) {
  chrome.storage.local.get(["savedSessions"], (result) => {
    let sessions = result.savedSessions || [];
    const session = sessions.find(s => s.timestamp === timestamp);

    if (!session) {
      debug('Session not found:', timestamp);
      return;
    }

    if (format === "rich") {
      // For rich text, we need to copy HTML with proper formatting
      const htmlContent = generateHTMLExport([session]);
      const plainContent = generatePlainTextExport([session]);

      copyRichText(htmlContent, plainContent)
        .catch(err => {
          debug('Failed to copy rich text to clipboard:', err);
        });
    } else {
      let copyText = "";

      switch (format) {
        case "markdown":
          copyText = generateMarkdownExport([session]);
          break;
        case "plain":
          copyText = generatePlainTextExport([session]);
          break;
        default:
          copyText = generateMarkdownExport([session]);
      }

      copyToClipboard(copyText)
        .catch(err => {
          debug('Failed to copy to clipboard:', err);
        });
    }
  });
}

function handleSessionExport(timestamp, format, callback) {
  chrome.storage.local.get(["savedSessions"], (result) => {
    let sessions = result.savedSessions || [];
    const session = sessions.find(s => s.timestamp === timestamp);

    if (!session) {
      debug('Session not found for export:', timestamp);
      if (callback) callback();
      return;
    }

    let exportText = "";
    let mimeType = "text/plain";
    let fileExtension = "txt";

    switch (format) {
      case "plain":
        exportText = generatePlainTextExport([session]);
        fileExtension = "txt";
        break;
      case "rtf":
        exportText = generateRTFExport([session]);
        mimeType = "application/rtf";
        fileExtension = "rtf";
        break;
      case "markdown":
        exportText = generateMarkdownExport([session]);
        fileExtension = "md";
        break;
      case "html":
        exportText = generateHTMLExport([session]);
        mimeType = "text/html";
        fileExtension = "html";
        break;
      case "json":
        exportText = JSON.stringify([session], null, 2);
        mimeType = "application/json";
        fileExtension = "json";
        break;
      case "opml":
        exportText = generateOPMLExport([session]);
        mimeType = "text/xml";
        fileExtension = "opml";
        break;
      default:
        exportText = generateMarkdownExport([session]);
        fileExtension = "md";
    }

    const blob = new Blob([exportText], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;

    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    a.download = `tabstract-export-${year}${month}${day}.${fileExtension}`;

    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    debug('[handleSessionExport] Export complete:', a.download);

    if (callback) {
      setTimeout(callback, 100);
    }
  });
}

// Save session as template
function handleSaveAsTemplate(timestamp) {
  debug('Saving session as template:', timestamp);

  chrome.storage.local.get(["savedSessions", "savedTemplates"], (result) => {
    let sessions = result.savedSessions || [];
    let templates = result.savedTemplates || [];

    const session = sessions.find(s => s.timestamp === timestamp);
    if (!session) {
      debug('Session not found:', timestamp);
      return;
    }

    // Use the current session name (custom or default datetime)
    const templateName = session.customName || new Date(session.timestamp).toLocaleString();

    // Create template from session
    const template = {
      id: `template-${Date.now()}`,
      name: templateName,
      tabs: session.tabs.map(tab => ({ ...tab })), // Copy tabs
      createdAt: new Date().toISOString(),
      schedule: null, // No schedule by default
      notifyOnSpawn: false, // No notifications by default
      color: session.color || null, // Preserve color from session
      pinned: session.pinned || false // Preserve pinned status from session
    };

    templates.push(template);
    chrome.storage.local.set({ savedTemplates: templates }, () => {
      debug('Template saved:', template);

      // Flash the session wrapper to indicate success
      const sessionWrapper = document.querySelector(`.session-wrapper[data-timestamp="${timestamp}"]`);
      if (sessionWrapper) {
        sessionWrapper.classList.add('flash-saved-session');
        setTimeout(() => sessionWrapper.classList.remove('flash-saved-session'), 600);
      }

      // Refresh templates menu and button state
      populateTemplatesSubmenu();
      updateTemplatesButtonState();
      updateSmartGroupsButtonState();
      updateFullScreenModeButtonState();
      updateCompactOnlyButtonsState();
    });
  });
}

// Save selected tabs/sessions as template (bulk action in advanced mode)
function handleBulkSaveAsTemplate() {
  const selectedTabs = getSelectedTabs();
  if (selectedTabs.length === 0) return;

  debug('[handleBulkSaveAsTemplate] Saving', selectedTabs.length, 'tabs/sessions as template');

  chrome.storage.local.get(["savedSessions", "savedTemplates"], (result) => {
    let sessions = result.savedSessions || [];
    let templates = result.savedTemplates || [];

    // Track which sessions are explicitly selected
    const selectedSessionIds = new Set();
    selectedTabs.forEach(item => {
      if (item.type === 'session') {
        selectedSessionIds.add(item.id);
      }
    });

    // Group tabs by session
    const sessionMap = new Map();
    let hasMultipleSessions = false;
    let singleSessionName = null;

    selectedTabs.forEach(tab => {
      // Skip session rows themselves - we only process tab rows
      if (tab.type === 'session') return;

      const sessionId = `session-${tab.sessionTimestamp}`;
      if (!sessionMap.has(sessionId)) {
        // Track if we have multiple sessions
        if (sessionMap.size > 0) {
          hasMultipleSessions = true;
        }

        // Only include session name if the session row itself was selected
        const includeSessionName = selectedSessionIds.has(sessionId);
        sessionMap.set(sessionId, {
          timestamp: tab.sessionTimestamp,
          customName: includeSessionName ? tab.sessionName : null,
          tabs: [],
          color: tab.sessionColor,
          pinned: tab.sessionPinned
        });

        // Store single session name for naming purposes
        if (includeSessionName && !hasMultipleSessions) {
          singleSessionName = tab.sessionName;
        }
      }
      sessionMap.get(sessionId).tabs.push({
        url: tab.url,
        title: tab.title,
        favicon: tab.favicon
      });
    });

    // Determine template name
    let templateName;
    if (sessionMap.size === 1 && singleSessionName) {
      // Single session that was explicitly selected - use its name
      templateName = singleSessionName;
    } else {
      // Multiple sessions or arbitrary tabs - use date
      templateName = new Date().toLocaleString();
    }

    // Collect all tabs from all sessions
    const allTabs = [];
    sessionMap.forEach(sessionData => {
      allTabs.push(...sessionData.tabs);
    });

    // Determine color - use first session's color if only one session
    let color = null;
    if (sessionMap.size === 1) {
      const firstSession = Array.from(sessionMap.values())[0];
      color = firstSession.color || null;
    }

    // Flash all selected rows BEFORE saving (so DOM elements still exist)
    selectedTabs.forEach(item => {
      const rowElement = document.querySelector(`tr[data-tab-id="${item.id}"]`);
      if (rowElement) {
        rowElement.classList.add('flash-saved-subtle');
        setTimeout(() => rowElement.classList.remove('flash-saved-subtle'), 300);
      }
    });

    // Create template from selected tabs
    const template = {
      id: `template-${Date.now()}`,
      name: templateName,
      tabs: allTabs,
      createdAt: new Date().toISOString(),
      schedule: null,
      notifyOnSpawn: false,
      color: color,
      pinned: false
    };

    templates.push(template);
    chrome.storage.local.set({ savedTemplates: templates }, () => {
      debug('Bulk template saved:', template);

      // Refresh templates menu and button state
      populateTemplatesSubmenu();
      updateTemplatesButtonState();
      updateSmartGroupsButtonState();
      updateFullScreenModeButtonState();
      updateCompactOnlyButtonsState();
    });
  });
}

// Move session to top of the list
function handleMoveToTop(timestamp) {
  debug('Moving session to top:', timestamp);

  chrome.storage.local.get(["savedSessions"], (result) => {
    let sessions = result.savedSessions || [];

    const sessionIndex = sessions.findIndex(s => s.timestamp === timestamp);
    if (sessionIndex === -1) {
      debug('Session not found:', timestamp);
      return;
    }

    const session = sessions[sessionIndex];

    if (session.pinned) {
      // For pinned sessions: move to top of pinned sessions
      const pinnedSessions = sessions.filter(s => s.pinned);

      // Check if already at top
      if (sessionIndex === 0) {
        debug('Pinned session is already at the top');
        return;
      }

      // Remove from current position
      sessions.splice(sessionIndex, 1);

      // Update pinnedAt timestamp to be most recent
      session.pinnedAt = Date.now();

      // Add to beginning (top of all sessions)
      sessions.unshift(session);
    } else {
      // For unpinned sessions: move to top of unpinned sessions
      const firstUnpinnedIndex = sessions.findIndex(s => !s.pinned);
      if (firstUnpinnedIndex !== -1 && sessionIndex === firstUnpinnedIndex) {
        debug('Session is already at the top of unpinned sessions');
        return;
      }

      // Remove session from current position
      sessions.splice(sessionIndex, 1);

      // Update timestamp so it sorts to top of unpinned sessions
      session.timestamp = new Date().toISOString();

      // Add to beginning
      sessions.unshift(session);
    }

    // Save updated sessions
    chrome.storage.local.set({ savedSessions: sessions }, () => {
      debug('Session moved to top:', session);
      // Refresh the session list and animate the moved session
      savedSessions = sessions;
      updateSessionList(sessions);
      highlightDropSession(session.timestamp);
      refreshBadge();
    });
  });
}

// Helper function to generate smart incremented names
function getIncrementedName(baseName) {
  // Check if name ends with (number)
  const match = baseName.match(/^(.*?)\s*\((\d+)\)$/);

  if (match) {
    // Name already has a number, increment it
    const nameWithoutNumber = match[1];
    const currentNumber = parseInt(match[2], 10);
    return `${nameWithoutNumber} (${currentNumber + 1})`;
  } else {
    // No number, add (2)
    return `${baseName} (2)`;
  }
}

function handleDuplicateGroup(timestamp) {
  debug('Duplicating session:', timestamp);

  chrome.storage.local.get(["savedSessions", "collapsedSessions"], (result) => {
    let sessions = result.savedSessions || [];
    let collapsed = result.collapsedSessions || {};

    const sessionIndex = sessions.findIndex(s => s.timestamp === timestamp);
    if (sessionIndex === -1) {
      debug('Session not found:', timestamp);
      return;
    }

    const originalSession = sessions[sessionIndex];

    // Create a deep copy of the session
    const duplicatedSession = {
      timestamp: new Date().toISOString(),
      tabs: JSON.parse(JSON.stringify(originalSession.tabs)), // Deep copy tabs array
      locked: originalSession.locked || false,
      color: originalSession.color || null
    };

    // Handle the name - smartly increment the number
    const originalName = originalSession.customName || originalSession.defaultTitle || 'Untitled Session';
    duplicatedSession.customName = getIncrementedName(originalName);

    // Copy pinned status if original was pinned
    if (originalSession.pinned) {
      duplicatedSession.pinned = true;
      duplicatedSession.pinnedAt = Date.now();
    }

    // Copy smart group ID if it exists (though duplicates won't auto-update with smart group)
    if (originalSession.smartGroupId) {
      duplicatedSession.smartGroupId = originalSession.smartGroupId;
    }

    // Copy collapsed state if original is collapsed (compact mode)
    if (collapsed[timestamp]) {
      collapsed[duplicatedSession.timestamp] = true;
      collapsedSessions[duplicatedSession.timestamp] = true; // Update local state too
    }

    // Insert duplicated session immediately before original
    sessions.splice(sessionIndex, 0, duplicatedSession);

    // Prepare save data
    const saveData = { savedSessions: sessions, collapsedSessions: collapsed };

    // Copy collapsed state if original is collapsed (advanced mode)
    const originalSessionId = `session-${timestamp}`;
    const duplicateSessionId = `session-${duplicatedSession.timestamp}`;
    if (fullscreenData.collapsedSessions && fullscreenData.collapsedSessions.has(originalSessionId)) {
      fullscreenData.collapsedSessions.add(duplicateSessionId);
      saveData.advancedModeCollapsed = Array.from(fullscreenData.collapsedSessions);
    }

    // Save updated sessions, collapsed state, and expanded state
    chrome.storage.local.set(saveData, () => {
      debug('Session duplicated:', duplicatedSession);
      savedSessions = sessions;
      updateSessionList(sessions);
      highlightDropSession(duplicatedSession.timestamp);
      refreshBadge();
    });
  });
}

// ============================================================================
// Split Group functionality
// ============================================================================

function enterSplitMode(timestamp) {
  debug('[SPLIT] enterSplitMode called with timestamp:', timestamp);
  debug('Entering split mode for session:', timestamp);

  isSplitMode = true;
  splitModeSessionTimestamp = timestamp;

  // Change cursor to row-resize for the session
  const sessionWrapper = document.querySelector(`.session-wrapper[data-timestamp="${timestamp}"]`);
  if (!sessionWrapper) {
    debug('[SPLIT] Session wrapper not found');
    debug('Session wrapper not found');
    exitSplitMode();
    return;
  }
  debug('[SPLIT] Found session wrapper:', sessionWrapper);

  // Get the session UL element
  const sessionUl = sessionWrapper.querySelector('.session-card ul');
  if (!sessionUl) {
    debug('[SPLIT] Session UL not found');
    debug('Session UL not found');
    exitSplitMode();
    return;
  }
  debug('[SPLIT] Found session UL:', sessionUl);

  // Add class to session wrapper to enable split mode cursor styling
  sessionWrapper.classList.add('split-mode-active');
  debug('[SPLIT] Added split-mode-active class to wrapper');

  // Get the session card element
  const sessionCard = sessionWrapper.querySelector('.session-card');
  if (!sessionCard) {
    debug('[SPLIT] Session card not found');
    exitSplitMode();
    return;
  }

  // Create the preview line element and append to session-card (not UL to avoid layout shift)
  splitModePreviewLine = document.createElement('div');
  splitModePreviewLine.className = 'split-mode-preview-line';
  splitModePreviewLine.style.display = 'none';
  sessionCard.appendChild(splitModePreviewLine);
  debug('[SPLIT] Created preview line element');

  // Add event listeners
  sessionUl.addEventListener('mousemove', onSplitModeMouseMove);
  sessionUl.addEventListener('click', onSplitModeClick, true); // Use capture phase to intercept before link clicks
  document.addEventListener('keydown', onSplitModeKeyDown);
  document.addEventListener('click', onSplitModeOutsideClick, true);
}

function exitSplitMode() {
  debug('Exiting split mode');

  if (!isSplitMode) return;

  isSplitMode = false;

  // Remove split mode class
  if (splitModeSessionTimestamp) {
    const sessionWrapper = document.querySelector(`.session-wrapper[data-timestamp="${splitModeSessionTimestamp}"]`);
    if (sessionWrapper) {
      sessionWrapper.classList.remove('split-mode-active');

      // Remove event listeners and preview line
      const sessionUl = sessionWrapper.querySelector('.session-card ul');
      if (sessionUl) {
        sessionUl.removeEventListener('mousemove', onSplitModeMouseMove);
        sessionUl.removeEventListener('click', onSplitModeClick, true);
      }
    }
  }

  // Remove preview line element
  if (splitModePreviewLine && splitModePreviewLine.parentNode) {
    splitModePreviewLine.remove();
  }

  // Remove event listeners
  document.removeEventListener('keydown', onSplitModeKeyDown);
  document.removeEventListener('click', onSplitModeOutsideClick, true);

  splitModeSessionTimestamp = null;
  splitModePreviewLine = null;
}

function onSplitModeMouseMove(e) {
  if (!isSplitMode || !splitModePreviewLine) return;

  const sessionUl = e.currentTarget;
  const liElements = Array.from(sessionUl.querySelectorAll('li'));

  if (liElements.length === 0) {
    splitModePreviewLine.style.display = 'none';
    return;
  }

  // Find the closest gap between list items
  let closestGap = null;
  let closestDistance = Infinity;
  let insertIndex = -1;

  for (let i = 0; i <= liElements.length; i++) {
    let gapY;

    if (i === 0) {
      // Before first item
      const firstRect = liElements[0].getBoundingClientRect();
      gapY = firstRect.top;
    } else if (i === liElements.length) {
      // After last item
      const lastRect = liElements[liElements.length - 1].getBoundingClientRect();
      gapY = lastRect.bottom;
    } else {
      // Between items
      const prevRect = liElements[i - 1].getBoundingClientRect();
      const nextRect = liElements[i].getBoundingClientRect();
      gapY = (prevRect.bottom + nextRect.top) / 2;
    }

    const distance = Math.abs(e.clientY - gapY);
    if (distance < closestDistance) {
      closestDistance = distance;
      closestGap = gapY;
      insertIndex = i;
    }
  }

  // Show preview line at the closest gap
  if (closestGap !== null && insertIndex > 0 && insertIndex < liElements.length) {
    // Position relative to session-card instead of UL
    const sessionCard = sessionUl.closest('.session-card');
    if (sessionCard) {
      const sessionCardRect = sessionCard.getBoundingClientRect();
      const relativeY = closestGap - sessionCardRect.top;

      splitModePreviewLine.style.top = `${relativeY}px`;
      splitModePreviewLine.style.display = 'block';
      splitModePreviewLine.dataset.splitIndex = insertIndex;
    }
  } else {
    // Hide line if at edges (would create empty session)
    splitModePreviewLine.style.display = 'none';
  }
}

function onSplitModeClick(e) {
  if (!isSplitMode || !splitModePreviewLine) return;

  e.preventDefault();
  e.stopPropagation();

  const splitIndex = parseInt(splitModePreviewLine.dataset.splitIndex);

  // Check if we have a valid split index
  if (isNaN(splitIndex) || splitModePreviewLine.style.display === 'none') {
    // Invalid split - treat as cancel
    exitSplitMode();
    return;
  }

  // Perform the split
  performSplit(splitModeSessionTimestamp, splitIndex);
  exitSplitMode();
}

function onSplitModeKeyDown(e) {
  if (e.key === 'Escape') {
    exitSplitMode();
  }
}

function onSplitModeOutsideClick(e) {
  if (!isSplitMode) return;

  // Check if click is inside the session being split
  const sessionWrapper = document.querySelector(`.session-wrapper[data-timestamp="${splitModeSessionTimestamp}"]`);
  if (sessionWrapper && sessionWrapper.contains(e.target)) {
    return; // Click is inside, let normal handler deal with it
  }

  // Click is outside - cancel split mode
  e.preventDefault();
  e.stopPropagation();
  exitSplitMode();
}

function performSplit(timestamp, splitIndex) {
  debug('Performing split at index:', splitIndex);

  chrome.storage.local.get(["savedSessions"], (result) => {
    let sessions = result.savedSessions || [];

    const sessionIndex = sessions.findIndex(s => s.timestamp === timestamp);
    if (sessionIndex === -1) {
      debug('Session not found:', timestamp);
      return;
    }

    const originalSession = sessions[sessionIndex];

    // Split the tabs
    const topTabs = originalSession.tabs.slice(0, splitIndex);
    const bottomTabs = originalSession.tabs.slice(splitIndex);

    // Validate split (don't create empty sessions)
    if (topTabs.length === 0 || bottomTabs.length === 0) {
      debug('Invalid split - would create empty session');
      return;
    }

    // Update original session with top tabs
    originalSession.tabs = topTabs;

    // Create new session with bottom tabs
    const originalName = originalSession.customName || originalSession.defaultTitle || 'Untitled Session';
    const newSession = {
      timestamp: new Date().toISOString(),
      customName: getIncrementedName(originalName),
      tabs: bottomTabs,
      locked: originalSession.locked || false,
      color: originalSession.color || null
    };

    // Don't copy pinned status - if original is pinned, it keeps its position with top tabs,
    // and the new session with bottom tabs goes to the unpinned section

    // Insert new session immediately after original
    sessions.splice(sessionIndex + 1, 0, newSession);

    // Save updated sessions
    chrome.storage.local.set({ savedSessions: sessions }, () => {
      debug('Session split complete');
      savedSessions = sessions;
      updateSessionList(sessions);
      refreshBadge();
    });
  });
}

function handlePinToTop(timestamp) {
  debug('Pinning session to top:', timestamp);

  chrome.storage.local.get(["savedSessions"], (result) => {
    let sessions = result.savedSessions || [];

    const sessionIndex = sessions.findIndex(s => s.timestamp === timestamp);
    if (sessionIndex === -1) {
      debug('Session not found:', timestamp);
      return;
    }

    const session = sessions[sessionIndex];

    // Toggle pinned state
    session.pinned = !session.pinned;

    // Set/remove pinnedAt timestamp
    if (session.pinned) {
      session.pinnedAt = Date.now();
    } else {
      delete session.pinnedAt;
      // When unpinning, move to top of unpinned sessions (position 0 after all pinned sessions)
      sessions.splice(sessionIndex, 1); // Remove from current position
      // Find where unpinned sessions start (after all pinned sessions)
      const firstUnpinnedIndex = sessions.findIndex(s => !s.pinned);
      const insertIndex = firstUnpinnedIndex === -1 ? sessions.length : firstUnpinnedIndex;
      sessions.splice(insertIndex, 0, session); // Insert at top of unpinned sessions
    }

    debug('Session pinned state:', session.pinned, 'pinnedAt:', session.pinnedAt);

    // Save updated sessions
    chrome.storage.local.set({ savedSessions: sessions }, () => {
      debug('Session pin state updated:', session);
      // Refresh the session list
      savedSessions = sessions;
      updateSessionList(sessions);
      highlightDropSession(session.timestamp);
      refreshBadge();
    });
  });
}

function handleSessionColorChange(timestamp, color) {
  debug('Changing session color:', timestamp, color);

  chrome.storage.local.get(["savedSessions"], (result) => {
    let sessions = result.savedSessions || [];

    const sessionIndex = sessions.findIndex(s => s.timestamp === timestamp);
    if (sessionIndex === -1) {
      debug('Session not found:', timestamp);
      return;
    }

    const session = sessions[sessionIndex];

    // Set or remove color
    if (color === 'none') {
      delete session.color;
    } else {
      session.color = color;
    }

    debug('Session color updated:', session.color);

    // Save updated sessions
    // Set flag to prevent storage listener from triggering updateSessionList
    isUpdatingFromStorage = true;
    chrome.storage.local.set({ savedSessions: sessions }, () => {
      debug('Session color saved:', session);
      savedSessions = sessions;
      if (viewMode === 'fullscreen') {
        // In advanced mode, rebuild fullscreen data and re-render (preserves sort)
        fullscreenData.allTabs = transformSessionsToTabs(sessions);
        applyFiltersAndRender();
      } else {
        updateSessionList(sessions);
      }
      // Reset flag after update completes
      setTimeout(() => {
        isUpdatingFromStorage = false;
      }, 100);
    });
  });
}

// Populate the templates submenu with saved templates
// Update templates button enabled/disabled state based on pro status and template count
function updateTemplatesButtonState() {
  const templatesBtn = document.getElementById('templatesBtn');
  if (!templatesBtn) return;

  chrome.storage.local.get(["savedTemplates"], (result) => {
    const templates = result.savedTemplates || [];

    // Disable only if there are no templates
    if (templates.length === 0) {
      templatesBtn.classList.add('disabled');
    } else {
      templatesBtn.classList.remove('disabled');
    }
  });
}

function updateSmartGroupsButtonState() {
  const smartGroupsBtn = document.getElementById('smartGroupsParentBtn');
  if (!smartGroupsBtn) return;

  smartGroupsBtn.classList.remove('disabled');
}

function updateFullScreenModeButtonState() {
  const fullScreenBtn = document.getElementById('fullScreenModeBtn');
  const viewModeToggleBtn = document.getElementById('viewModeToggleBtn');

  const shortcut = document.getElementById('advancedModeShortcut');

  // Check if there are any sessions (not in trash view)
  const hasSessions = document.querySelectorAll('#tabList .session-wrapper:not(.trash-group)').length > 0;

  if (hasSessions || viewMode === "fullscreen") {
    // Enable when there are sessions or already in fullscreen mode
    if (fullScreenBtn) fullScreenBtn.classList.remove('disabled');
    if (viewModeToggleBtn) viewModeToggleBtn.classList.remove('disabled');
    if (shortcut) shortcut.style.display = '';
    debug('updateFullScreenModeButtonState: enabled (has sessions or in fullscreen)');
  } else {
    // Disable when no sessions exist
    if (fullScreenBtn) fullScreenBtn.classList.add('disabled');
    if (viewModeToggleBtn) viewModeToggleBtn.classList.add('disabled');
    if (shortcut) shortcut.style.display = 'none';
    debug('updateFullScreenModeButtonState: disabled (no sessions)');
  }

  if (!fullScreenBtn) return;

  // Update text and icon based on current mode
  const textSpan = fullScreenBtn.querySelector('span > span[data-i18n="advancedMode"], span > span[data-i18n="simpleMode"]');
  const enterIcon = fullScreenBtn.querySelector('.actions-menu-icon:not(.actions-menu-icon-exit)');
  const exitIcon = fullScreenBtn.querySelector('.actions-menu-icon-exit');

  if (viewMode === "fullscreen") {
    // In fullscreen/advanced mode, show option to go back to simple mode
    if (textSpan) {
      textSpan.textContent = chrome.i18n.getMessage("simpleMode") || "Simple Mode";
      textSpan.setAttribute('data-i18n', 'simpleMode');
    }
    if (enterIcon) enterIcon.style.display = 'none';
    if (exitIcon) exitIcon.style.display = '';
  } else {
    // In compact mode, show option to enter advanced mode
    if (textSpan) {
      textSpan.textContent = chrome.i18n.getMessage("advancedMode") || "Advanced Mode";
      textSpan.setAttribute('data-i18n', 'advancedMode');
    }
    if (enterIcon) enterIcon.style.display = '';
    if (exitIcon) exitIcon.style.display = 'none';
  }
}

function updateCompactOnlyButtonsState() {
  // Disable compact-mode-only buttons when in fullscreen/advanced mode
  const newTabGroupBtn = document.getElementById('newTabGroupBtn');
  const collapseExpandAllBtn = document.getElementById('collapseExpandAllBtn');
  const sortByWrapper = document.getElementById('sortByWrapper');
  const searchToggleBtn = document.getElementById('searchToggleBtn');

  const isFullscreen = viewMode === "fullscreen";

  if (newTabGroupBtn) {
    if (isFullscreen) {
      newTabGroupBtn.classList.add('disabled');
    } else {
      newTabGroupBtn.classList.remove('disabled');
    }
  }

  // Collapse/Expand All works in both compact and advanced modes
  if (collapseExpandAllBtn) {
    collapseExpandAllBtn.classList.remove('disabled');
  }

  if (sortByWrapper) {
    if (isFullscreen) {
      sortByWrapper.classList.add('disabled');
    } else {
      sortByWrapper.classList.remove('disabled');
    }
  }

  // Hide search toggle in advanced mode (advanced mode has its own search)
  if (searchToggleBtn) {
    if (isFullscreen) {
      searchToggleBtn.classList.remove('visible-fade');
      searchToggleBtn.classList.add('hidden-fade');
      // Also close search if it's open
      const searchContainer = document.getElementById('searchContainer');
      if (searchContainer && searchContainer.classList.contains('active')) {
        searchContainer.classList.remove('active');
        searchToggleBtn.setAttribute('aria-expanded', 'false');
      }
    } else {
      searchToggleBtn.classList.remove('hidden-fade');
      searchToggleBtn.classList.add('visible-fade');
    }
  }
}

function populateTemplatesSubmenu() {
  const templatesSubmenu = document.getElementById('templatesSubmenu');
  if (!templatesSubmenu) return;

  chrome.storage.local.get(["savedTemplates"], (result) => {
    const templates = result.savedTemplates || [];

    if (templates.length === 0) {
      templatesSubmenu.innerHTML = `
        <div class="templates-empty" style="padding: 8px 12px; color: var(--text-secondary); font-size: 13px;">${getMessage('noTemplatesSaved')}</div>
        <button class="actions-submenu-item manage-templates-btn" role="menuitem" style="border-top: 1px solid var(--border-primary); margin-top: 6px; padding-top: 6px;">
          <span>${getMessage('manageTemplatesMenuItem')}</span>
        </button>
      `;
    } else {
      // Build template items
      const templateItems = templates.map(template => `
        <button class="actions-submenu-item template-item" data-template-id="${template.id}" role="menuitem">
          <span>${template.name}</span>
        </button>
      `).join('');

      templatesSubmenu.innerHTML = `
        ${templateItems}
        <button class="actions-submenu-item manage-templates-btn" role="menuitem" style="border-top: 1px solid var(--border-primary); margin-top: 6px; padding-top: 6px;">
          <span>${getMessage('manageTemplatesMenuItem')}</span>
        </button>
      `;

      // Wire up template item click handlers
      const templateButtons = templatesSubmenu.querySelectorAll('.template-item');
      templateButtons.forEach(item => {
        item.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const templateId = item.dataset.templateId;
          const actionsMenu = document.getElementById('actionsMenu');
          if (actionsMenu) {
            actionsMenu.classList.remove('show');
          }
          const actionsMenuBtn = document.getElementById('actionsMenuBtn');
          if (actionsMenuBtn) {
            actionsMenuBtn.setAttribute('aria-expanded', 'false');
          }
          templatesSubmenu.classList.remove('show');
          const templatesBtn = document.getElementById('templatesBtn');
          if (templatesBtn) {
            templatesBtn.setAttribute('aria-expanded', 'false');
          }
          handleSpawnFromTemplate(templateId);
        });
      });
    }

    // Wire up "Manage Templates..." button
    const manageBtn = templatesSubmenu.querySelector('.manage-templates-btn');
    if (manageBtn) {
      manageBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        // Close menus
        const actionsMenu = document.getElementById('actionsMenu');
        if (actionsMenu) {
          actionsMenu.classList.remove('show');
        }
        const actionsMenuBtn = document.getElementById('actionsMenuBtn');
        if (actionsMenuBtn) {
          actionsMenuBtn.setAttribute('aria-expanded', 'false');
        }
        templatesSubmenu.classList.remove('show');
        const templatesBtn = document.getElementById('templatesBtn');
        if (templatesBtn) {
          templatesBtn.setAttribute('aria-expanded', 'false');
        }
        // Open templates modal
        openTemplatesModal();
      });
    }
  });
}

// Open the templates management modal
function openTemplatesModal() {
  const modal = document.getElementById('templatesModal');
  if (!modal) return;

  // Show modal
  modal.style.display = 'flex';
  document.body.classList.add('modal-open');

  // Render templates list
  renderTemplatesModal();

  // Setup close button
  const closeBtn = document.getElementById('templatesModalClose');
  if (closeBtn) {
    closeBtn.onclick = closeTemplatesModal;
  }

  // Close on overlay click
  modal.onclick = (e) => {
    if (e.target === modal) {
      closeTemplatesModal();
    }
  };

  // Close on escape key
  const escapeHandler = (e) => {
    if (e.key === 'Escape') {
      closeTemplatesModal();
      document.removeEventListener('keydown', escapeHandler);
    }
  };
  document.addEventListener('keydown', escapeHandler);
}

// Close the templates management modal
function closeTemplatesModal() {
  const modal = document.getElementById('templatesModal');
  if (modal) {
    modal.style.display = 'none';
    document.body.classList.remove('modal-open');
  }
  // Refresh the templates submenu in case any changes were made
  populateTemplatesSubmenu();
}

// Render the templates list in the modal
function renderTemplatesModal() {
  const listContainer = document.getElementById('templatesModalList');
  if (!listContainer) return;

  chrome.storage.local.get(["savedTemplates"], (result) => {
    const templates = result.savedTemplates || [];

    if (templates.length === 0) {
      listContainer.innerHTML = `<div class="templates-modal-empty">${getMessage('noTemplatesInstructions')}</div>`;
      return;
    }

    // Clear container
    listContainer.innerHTML = '';

    // Render each template using session-like structure
    templates.forEach((template, index) => {
      const wrapper = document.createElement('div');
      wrapper.className = 'template-item-card collapsed';
      wrapper.dataset.templateId = template.id;
      wrapper.dataset.index = index;
      wrapper.draggable = true; // Set draggable immediately to avoid Safari initialization bug

      const header = document.createElement('div');
      header.className = 'template-header';

      const titleContainer = document.createElement('div');
      titleContainer.className = 'template-title-container';

      // Drag handle with correct icon
      const dragIcon = document.createElement('span');
      dragIcon.className = 'template-drag-handle template-drag-icon';
      dragIcon.innerHTML = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" stroke-width="2"><circle cx="12" cy="5" r="1"/><circle cx="19" cy="5" r="1"/><circle cx="5" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/><circle cx="12" cy="19" r="1"/><circle cx="19" cy="19" r="1"/><circle cx="5" cy="19" r="1"/></svg>';
      dragIcon.title = getMessage("dragToReorder") || "Drag to reorder";

      // Title span (will be replaced with input on click)
      const titleSpan = document.createElement('span');
      titleSpan.className = 'template-title';
      titleSpan.textContent = template.name;

      // Make title clickable to edit (but not during drag)
      titleSpan.addEventListener('click', (e) => {
        // Don't allow editing if we're dragging or just finished dragging
        if (wrapper.classList.contains('dragging') || wrapper.dataset.justDragged === 'true') {
          return;
        }
        makeTemplateTitleEditable(template, titleSpan, titleContainer);
      });

      // Toggle button for expanding/collapsing tabs
      const toggleButton = document.createElement('button');
      toggleButton.className = 'toggle-button';
      toggleButton.setAttribute('aria-expanded', 'false');
      toggleButton.setAttribute('aria-label', getMessage('expandTemplate') || 'Expand routine');
      toggleButton.innerHTML = `
        <svg class="chevron-open" version="1.1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 26.4209 15.7106">
          <path d="M13.0259 15.7106C13.3439 15.7106 13.6473 15.5689 13.8694 15.3253L25.7161 2.84751C25.9188 2.63516 26.0459 2.38829 26.0459 2.08969C26.0459 1.48063 25.5819 1.00578 24.968 1.00578C24.6791 1.00578 24.402 1.11844 24.1994 1.31032L12.3372 13.782L13.7136 13.782L1.84172 1.31032C1.65469 1.11844 1.37766 1.00578 1.07313 1.00578C0.464064 1.00578 0 1.48063 0 2.08969C0 2.38829 0.132031 2.64485 0.334688 2.86313L12.1717 15.3302C12.4153 15.5738 12.6923 15.7106 13.0259 15.7106Z"/>
        </svg>
        <svg class="chevron-closed" version="1.1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 18.3153 26.0266">
          <path d="M18.3153 13.0055C18.3153 12.6923 18.193 12.4202 17.9591 12.2019L5.4775 0.304532C5.26407 0.101875 5.00266 0 4.69328 0C4.09984 0 3.62016 0.454376 3.62016 1.07313C3.62016 1.37172 3.73766 1.63422 3.91984 1.83204L15.6678 13.0055L3.91984 24.1789C3.73766 24.3719 3.62016 24.6284 3.62016 24.9378C3.62016 25.5566 4.09984 26.0109 4.69328 26.0109C5.00266 26.0109 5.26407 25.9042 5.4775 25.6908L17.9591 13.8091C18.193 13.5752 18.3153 13.3186 18.3153 13.0055Z"/>
        </svg>
        <span class="link-count">${template.tabs.length}</span>
      `;
      toggleButton.addEventListener('click', (e) => {
        e.stopPropagation();
        const nowCollapsed = wrapper.classList.toggle('collapsed');
        toggleButton.setAttribute('aria-expanded', nowCollapsed ? 'false' : 'true');
        toggleButton.setAttribute('aria-label', nowCollapsed ? (getMessage('expandTemplate') || 'Expand routine') : (getMessage('collapseTemplate') || 'Collapse routine'));
      });

      titleContainer.appendChild(dragIcon);
      titleContainer.appendChild(titleSpan);
      titleContainer.appendChild(toggleButton);

      // Button container for edit and delete only
      const buttonContainer = document.createElement('div');
      buttonContainer.style.display = 'flex';
      buttonContainer.style.alignItems = 'center';
      buttonContainer.style.gap = '0px';

      // Edit button (gear icon)
      const editBtn = document.createElement('button');
      editBtn.className = 'template-delete-btn template-edit-btn';
      editBtn.title = "Edit schedule";
      editBtn.setAttribute('aria-label', "Edit schedule");
      editBtn.innerHTML = `
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M9.46289 20.8789L11.4355 20.8789C12.1875 20.8789 12.7734 20.4199 12.9395 19.6973L13.3594 17.8711L13.6719 17.7637L15.2637 18.7402C15.8984 19.1309 16.6309 19.043 17.168 18.5059L18.5352 17.1484C19.0723 16.6113 19.1602 15.8691 18.7695 15.2441L17.7734 13.6621L17.8906 13.3691L19.7168 12.9395C20.4297 12.7734 20.8984 12.1777 20.8984 11.4355L20.8984 9.50195C20.8984 8.75977 20.4395 8.17383 19.7168 7.99805L17.9102 7.55859L17.7832 7.24609L18.7793 5.66406C19.1699 5.03906 19.0918 4.30664 18.5449 3.75977L17.1777 2.39258C16.6504 1.86523 15.918 1.76758 15.2832 2.1582L13.6914 3.13477L13.3594 3.00781L12.9395 1.18164C12.7734 0.458984 12.1875 0 11.4355 0L9.46289 0C8.71094 0 8.125 0.458984 7.95898 1.18164L7.5293 3.00781L7.19727 3.13477L5.61523 2.1582C4.98047 1.76758 4.23828 1.86523 3.71094 2.39258L2.35352 3.75977C1.80664 4.30664 1.71875 5.03906 2.11914 5.66406L3.10547 7.24609L2.98828 7.55859L1.18164 7.99805C0.458984 8.17383 0 8.75977 0 9.50195L0 11.4355C0 12.1777 0.46875 12.7734 1.18164 12.9395L3.00781 13.3691L3.11523 13.6621L2.12891 15.2441C1.72852 15.8691 1.82617 16.6113 2.36328 17.1484L3.7207 18.5059C4.25781 19.043 5 19.1309 5.63477 18.7402L7.2168 17.7637L7.5293 17.8711L7.95898 19.6973C8.125 20.4199 8.71094 20.8789 9.46289 20.8789ZM9.61914 19.3555C9.45312 19.3555 9.36523 19.2871 9.33594 19.1309L8.75 16.709C8.1543 16.5625 7.59766 16.3281 7.17773 16.0645L5.04883 17.373C4.93164 17.4609 4.79492 17.4512 4.6875 17.3242L3.53516 16.1719C3.42773 16.0645 3.41797 15.9473 3.49609 15.8105L4.80469 13.7012C4.58008 13.291 4.32617 12.7344 4.16992 12.1387L1.74805 11.5625C1.5918 11.5332 1.52344 11.4453 1.52344 11.2793L1.52344 9.64844C1.52344 9.47266 1.58203 9.39453 1.74805 9.36523L4.16016 8.7793C4.31641 8.14453 4.60938 7.56836 4.78516 7.20703L3.48633 5.09766C3.39844 4.95117 3.4082 4.83398 3.51562 4.7168L4.67773 3.58398C4.79492 3.4668 4.90234 3.45703 5.04883 3.53516L7.1582 4.81445C7.57812 4.58008 8.17383 4.33594 8.75977 4.16992L9.33594 1.74805C9.36523 1.5918 9.45312 1.52344 9.61914 1.52344L11.2793 1.52344C11.4453 1.52344 11.5332 1.5918 11.5527 1.74805L12.1484 4.18945C12.7539 4.3457 13.2812 4.58984 13.7207 4.82422L15.8398 3.53516C15.9961 3.45703 16.0938 3.4668 16.2207 3.58398L17.373 4.7168C17.4902 4.83398 17.4902 4.95117 17.4023 5.09766L16.1035 7.20703C16.2891 7.56836 16.5723 8.14453 16.7285 8.7793L19.1504 9.36523C19.3066 9.39453 19.375 9.47266 19.375 9.64844L19.375 11.2793C19.375 11.4453 19.2969 11.5332 19.1504 11.5625L16.7188 12.1387C16.5625 12.7344 16.3184 13.291 16.084 13.7012L17.3926 15.8105C17.4707 15.9473 17.4707 16.0645 17.3535 16.1719L16.2109 17.3242C16.0938 17.4512 15.9668 17.4609 15.8398 17.373L13.7109 16.0645C13.291 16.3281 12.7441 16.5625 12.1484 16.709L11.5527 19.1309C11.5332 19.2871 11.4453 19.3555 11.2793 19.3555ZM10.4492 14.1602C12.5098 14.1602 14.1699 12.5 14.1699 10.4395C14.1699 8.37891 12.5098 6.71875 10.4492 6.71875C8.38867 6.71875 6.72852 8.37891 6.72852 10.4395C6.72852 12.5 8.38867 14.1602 10.4492 14.1602ZM10.4492 12.6465C9.22852 12.6465 8.24219 11.6602 8.24219 10.4395C8.24219 9.21875 9.22852 8.23242 10.4492 8.23242C11.6699 8.23242 12.6562 9.21875 12.6562 10.4395C12.6562 11.6602 11.6699 12.6465 10.4492 12.6465Z" fill="currentColor"/>
        </svg>
      `;
      editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleScheduleEditor(template, wrapper);
      });

      // Delete button with correct icon
      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'template-delete-btn template-trash-btn';
      deleteBtn.title = getMessage("draftDelete") || "Delete template";
      deleteBtn.setAttribute('aria-label', getMessage("draftDelete") || "Delete template");
      deleteBtn.innerHTML = `
        <svg viewBox="0 0 31.179 38.1519" aria-hidden="true">
          <path fill="currentColor" d="M10.8009 29.9681C11.4594 29.9681 11.8837 29.5509 11.8681 28.9366L11.3894 12.5553C11.3709 11.9465 10.9409 11.5422 10.3109 11.5422C9.65812 11.5422 9.23655 11.9594 9.25218 12.5709L9.71812 28.945C9.73655 29.5666 10.1694 29.9681 10.8009 29.9681ZM15.4034 29.9681C16.0506 29.9681 16.5062 29.5566 16.5062 28.9478L16.5062 12.5653C16.5062 11.9565 16.0506 11.5422 15.4034 11.5422C14.7534 11.5422 14.3106 11.9565 14.3106 12.5653L14.3106 28.9478C14.3106 29.5566 14.7534 29.9681 15.4034 29.9681ZM20.0159 29.9681C20.6375 29.9681 21.0675 29.5666 21.0859 28.945L21.5519 12.5709C21.5675 11.9594 21.1459 11.5422 20.4931 11.5422C19.8631 11.5422 19.4331 11.9465 19.4147 12.5681L18.9487 28.9366C18.9331 29.5509 19.3575 29.9681 20.0159 29.9681ZM8.305 7.18844L11.1887 7.18844L11.1887 3.94312C11.1887 3.13405 11.7547 2.61499 12.6247 2.61499L18.1537 2.61499C19.0237 2.61499 19.5897 3.13405 19.5897 3.94312L19.5897 7.18844L22.4734 7.18844L22.4734 3.79812C22.4734 1.40875 20.9484 0 18.3594 0L12.4191 0C9.83 0 8.305 1.40875 8.305 3.79812ZM1.3828 8.88842L29.434 8.88842C30.204 8.88842 30.804 8.27686 30.804 7.50686C30.804 6.74249 30.204 6.14375 29.434 6.14375L1.3828 6.14375C0.625622 6.14375 0 6.74249 0 7.50686C0 8.28967 0.625622 8.88842 1.3828 8.88842ZM8.22749 35.2581L22.5894 35.2581C24.9812 35.2581 26.5347 33.7937 26.6469 31.3991L27.7209 8.58873L24.8228 8.58873L23.7956 30.9337C23.7644 31.8712 23.1459 32.4937 22.255 32.4937L8.53624 32.4937C7.67092 32.4937 7.05248 31.8556 7.00842 30.9337L5.92998 8.58873L3.08312 8.58873L4.17 31.4119C4.285 33.8065 5.81 35.2581 8.22749 35.2581Z"/>
        </svg>
      `;
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        handleDeleteTemplate(template.id);
      });

      buttonContainer.appendChild(editBtn);
      buttonContainer.appendChild(deleteBtn);

      header.appendChild(titleContainer);
      header.appendChild(buttonContainer);

      // Info row
      const infoRow = document.createElement('div');
      infoRow.className = 'template-info';

      // Build schedule display text
      let scheduleDisplay = '';
      if (template.schedule && template.schedule.enabled) {
        scheduleDisplay = formatScheduleDisplay(template.schedule);
      }

      // Determine last run date and time display
      const lastRunTime = template.schedule?.lastExecuted
        ? new Date(template.schedule.lastExecuted).toLocaleString(window.getEffectiveLocale ? window.getEffectiveLocale() : navigator.language)
        : (getMessage('never') || 'Never');
      const lastRunText = (getMessage('lastRun') || 'Last run: {time}').replace('{time}', lastRunTime);

      infoRow.innerHTML = `
        ${scheduleDisplay ? `<span class="template-schedule" style="display: inline-flex; align-items: center;"><svg class="icon" version="1.1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 32.25 31.8906" style="width: 12px; height: 12px; margin-right: 4px; flex-shrink: 0;"><g><path d="M15.9375 31.875C24.7344 31.875 31.875 24.7344 31.875 15.9375C31.875 7.14062 24.7344 0 15.9375 0C7.14062 0 0 7.14062 0 15.9375C0 24.7344 7.14062 31.875 15.9375 31.875ZM15.9375 29.2188C8.59375 29.2188 2.65625 23.2812 2.65625 15.9375C2.65625 8.59375 8.59375 2.65625 15.9375 2.65625C23.2812 2.65625 29.2188 8.59375 29.2188 15.9375C29.2188 23.2812 23.2812 29.2188 15.9375 29.2188Z"/><path d="M7.76562 17.625L15.9219 17.625C16.5312 17.625 17.0156 17.1562 17.0156 16.5312L17.0156 6C17.0156 5.39062 16.5312 4.92188 15.9219 4.92188C15.3125 4.92188 14.8438 5.39062 14.8438 6L14.8438 15.4531L7.76562 15.4531C7.14062 15.4531 6.67188 15.9219 6.67188 16.5312C6.67188 17.1562 7.14062 17.625 7.76562 17.625Z"/></g></svg><span>${scheduleDisplay}</span></span><span class="template-separator">•</span>` : ''}
        <span class="template-last-run">${lastRunText}</span>
      `;

      // Create tab list
      const tabList = document.createElement('div');
      tabList.className = 'template-tab-list';
      const tabUl = document.createElement('ul');
      template.tabs.forEach((tab, tabIndex) => {
        const li = document.createElement('li');

        const linkArea = document.createElement('a');
        linkArea.href = tab.url;
        linkArea.className = 'template-tab-link';
        linkArea.title = tab.url;
        linkArea.setAttribute('data-url', tab.url);
        linkArea.innerHTML = `
          <span class="favicon-wrap">
            <img src="${computeFavicon(tab.url)}" alt="">
          </span>
          <span class="link-text">${escapeHtml(tab.title || tab.url)}</span>
        `;

        // Make tab links clickable
        linkArea.addEventListener('click', (e) => {
          e.preventDefault();
          chrome.storage.local.get(['opentabsBackground'], (result) => {
            const openInBackground = result.opentabsBackground !== false;
            const modifierPressed = e.altKey;
            const active = modifierPressed ? openInBackground : !openInBackground;
            chrome.tabs.create({ url: tab.url, active: active });
          });
        });

        li.appendChild(linkArea);
        tabUl.appendChild(li);
      });
      tabList.appendChild(tabUl);

      // Apply template color if set (to wrapper only, not drag icon)
      if (template.color && template.color !== 'none') {
        const colorMap = {
          'blue': '#007AFF',
          'green': '#53b559',
          'yellow': '#ffc400',
          'orange': '#fa6a22',
          'red': '#FF0000',
          'pink': '#ff66ad',
          'purple': '#924ff6'
        };
        const colorValue = template.color.startsWith('#') ? template.color : colorMap[template.color];
        if (colorValue) {
          // Apply border to wrapper and override accent color
          wrapper.style.setProperty('--session-accent', colorValue);
          wrapper.classList.add('has-color');
          wrapper.dataset.templateColor = colorValue;
        }
      }

      // Show pinned indicator if pinned
      if (template.pinned) {
        wrapper.classList.add('pinned-template');
        dragIcon.classList.add('pinned-indicator');
        dragIcon.innerHTML = '<svg class="icon" viewBox="0 0 23.6864 36.9547" aria-hidden="true" style="width: 16px; height: 16px;"><g><path d="M0 23.1814C0 24.3206 0.788907 25.0745 2.03047 25.0745L10.5417 25.0745L10.5417 33.3208C10.5417 35.2852 11.3383 36.9547 11.6611 36.9547C11.978 36.9547 12.7745 35.2852 12.7745 33.3208L12.7745 25.0745L21.2809 25.0745C22.5225 25.0745 23.3114 24.3206 23.3114 23.1814C23.3114 19.8458 20.6805 16.4825 16.4255 14.9808L15.9244 7.71203C17.9005 6.54594 19.7755 5.09172 20.5928 3.99641C20.9506 3.51844 21.1392 3.04531 21.1392 2.63469C21.1392 1.79297 20.492 1.17219 19.5097 1.17219L3.8125 1.17219C2.81937 1.17219 2.18297 1.79297 2.18297 2.63469C2.18297 3.04531 2.36078 3.51844 2.71859 3.99641C3.54078 5.09172 5.41578 6.55078 7.38703 7.71203L6.88594 14.9808C2.63094 16.4825 0 19.8458 0 23.1814Z"/></g></svg>';
        dragIcon.title = 'Pinned';
      }

      wrapper.appendChild(header);
      wrapper.appendChild(infoRow);
      wrapper.appendChild(tabList);
      listContainer.appendChild(wrapper);
    });

    // Setup drag-and-drop after Safari has fully rendered/initialized the draggable elements
    // Safari needs at least one frame to initialize drag state on dynamically created elements
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setupTemplateDragAndDrop();
      });
    });
  });
}

// Make template title editable (similar to session title editing)
function makeTemplateTitleEditable(template, titleSpan, titleContainer) {
  // Prevent double-editing
  if (titleContainer.querySelector('.template-title-input')) {
    return;
  }

  const fallbackTitle = template.name;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'template-title-input';
  input.value = fallbackTitle;
  input.maxLength = 60;

  // Match styling from span (using same technique as session title editing)
  const spanStyle = window.getComputedStyle(titleSpan);

  // Add 2px cursor buffer to the span before measuring
  // This prevents caret shift when switching from span to input
  const originalPaddingRight = titleSpan.style.paddingRight;
  const computedPaddingRight = parseInt(spanStyle.paddingRight, 10) || 0;
  titleSpan.style.paddingRight = (computedPaddingRight + 2) + 'px';

  // Capture the span width (now includes the 2px cursor buffer)
  // offsetWidth returns rounded integers, avoiding sub-pixel issues
  const spanWidth = titleSpan.offsetWidth;

  // Set the span's width explicitly to the rounded value so it visually matches
  titleSpan.style.width = spanWidth + 'px';

  // Restore original padding so we copy the correct style to input
  titleSpan.style.paddingRight = originalPaddingRight;

  // Create measurement span for dynamic resizing
  const measure = document.createElement('span');
  measure.style.visibility = 'hidden';
  measure.style.position = 'absolute';
  measure.style.whiteSpace = 'pre';
  measure.style.fontSize = spanStyle.fontSize;
  measure.style.fontFamily = spanStyle.fontFamily;
  measure.style.fontWeight = spanStyle.fontWeight;
  measure.style.lineHeight = spanStyle.lineHeight;
  measure.style.letterSpacing = spanStyle.letterSpacing;
  measure.style.top = '-9999px';
  measure.style.left = '-9999px';
  // Keep initial width equal to the visible title width
  measure.textContent = fallbackTitle;
  document.body.appendChild(measure);

  // Replace span with input
  titleContainer.replaceChild(input, titleSpan);

  const inputStyle = window.getComputedStyle(input);
  const padLeft = parseInt(inputStyle.paddingLeft, 10) || 0;
  const padRight = parseInt(inputStyle.paddingRight, 10) || 0;
  document.body.removeChild(measure);

  // Copy all styling from span to input
  input.style.fontSize = spanStyle.fontSize;
  input.style.fontFamily = spanStyle.fontFamily;
  input.style.fontWeight = spanStyle.fontWeight;
  input.style.lineHeight = spanStyle.lineHeight;
  input.style.letterSpacing = spanStyle.letterSpacing;
  input.style.padding = spanStyle.padding;
  input.style.margin = spanStyle.margin;
  input.style.boxSizing = spanStyle.boxSizing;
  input.style.height = spanStyle.height;
  input.style.verticalAlign = spanStyle.verticalAlign;
  input.style.minWidth = spanStyle.minWidth;
  input.style.border = spanStyle.border;
  input.style.outline = 'none';
  input.style.display = 'inline-block';
  // Use measured span width (already includes 2px cursor buffer from above)
  input.style.width = spanWidth + 'px';

  // Handle blur - save the new name
  input.addEventListener('blur', () => {
    const finalValue = (input.value || '').trim();
    if (!finalValue) {
      titleSpan.textContent = fallbackTitle;
    } else {
      titleSpan.textContent = finalValue;
      handleRenameTemplate(template.id, finalValue);
    }
    titleContainer.replaceChild(titleSpan, input);
  });

  // Handle Enter key
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      input.blur();
    }
  });

  // Handle input changes (resize input)
  input.addEventListener('input', () => {
    input.value = input.value.replace(/ {2,}/g, ' ');
    const flashError = () => {
      input.classList.remove('error-flash');
      void input.offsetWidth;
      input.classList.add('error-flash');
    };
    if (input.value.length > 60) {
      input.value = input.value.substring(0, 60);
      flashError();
    }
    measure.textContent = input.value || ' ';
    document.body.appendChild(measure);
    const newTextWidth = measure.offsetWidth;
    document.body.removeChild(measure);
    const padLeft2 = parseInt(inputStyle.paddingLeft, 10) || 0;
    const padRight2 = parseInt(inputStyle.paddingRight, 10) || 0;
    let newWidth = newTextWidth + padLeft2 + padRight2 + 2;
    if (newWidth > 525) {
      flashError();
      newWidth = 525;
    }
    input.style.width = newWidth + 'px';
  });

  // Focus the input
  input.focus();
  input.select();
}

// Delete a template
function handleDeleteTemplate(templateId) {
  if (!confirm(getMessage('confirmDeleteTemplate') || 'Delete this routine? This cannot be undone.')) {
    return;
  }

  chrome.storage.local.get(["savedTemplates"], (result) => {
    let templates = result.savedTemplates || [];
    templates = templates.filter(t => t.id !== templateId);

    chrome.storage.local.set({ savedTemplates: templates }, () => {
      debug('Template deleted:', templateId);
      renderTemplatesModal();
      populateTemplatesSubmenu(); // Refresh the templates submenu
      updateTemplatesButtonState(); // Update button state
      updateSmartGroupsButtonState();
    });
  });
}

// Handle template color change
function handleTemplateColorChange(templateId, color) {
  chrome.storage.local.get(["savedTemplates"], (result) => {
    const templates = result.savedTemplates || [];
    const t = templates.find(t => t.id === templateId);
    if (t) {
      t.color = color === 'none' ? null : color;
      chrome.storage.local.set({ savedTemplates: templates }, () => {
        debug('Template color changed:', templateId, color);
        // Don't re-render the modal - just update the visual representation
        // The color change is already visible in the editor
      });
    }
  });
}

// Toggle template pin status
function handleTemplateTogglePin(templateId) {
  chrome.storage.local.get(["savedTemplates"], (result) => {
    const templates = result.savedTemplates || [];
    const t = templates.find(t => t.id === templateId);

    if (t) {
      t.pinned = !t.pinned;
      if (t.pinned) {
        t.pinnedAt = Date.now();
      } else {
        delete t.pinnedAt;
      }

      chrome.storage.local.set({ savedTemplates: templates }, () => {
        debug('Template pin toggled:', t.id, t.pinned);
        // Don't re-render the modal - just update the visual representation
        // Update the pin icon in the main template card
        const templateCard = document.querySelector(`.template-item-card[data-template-id="${templateId}"]`);
        if (templateCard) {
          const dragIcon = templateCard.querySelector('.template-drag-icon');
          if (dragIcon) {
            if (t.pinned) {
              // Show pinned indicator
              templateCard.classList.add('pinned-template');
              dragIcon.classList.add('pinned-indicator');
              dragIcon.innerHTML = '<svg class="icon" viewBox="0 0 23.6864 36.9547" aria-hidden="true" style="width: 16px; height: 16px;"><g><path d="M0 23.1814C0 24.3206 0.788907 25.0745 2.03047 25.0745L10.5417 25.0745L10.5417 33.3208C10.5417 35.2852 11.3383 36.9547 11.6611 36.9547C11.978 36.9547 12.7745 35.2852 12.7745 33.3208L12.7745 25.0745L21.2809 25.0745C22.5225 25.0745 23.3114 24.3206 23.3114 23.1814C23.3114 19.8458 20.6805 16.4825 16.4255 14.9808L15.9244 7.71203C17.9005 6.54594 19.7755 5.09172 20.5928 3.99641C20.9506 3.51844 21.1392 3.04531 21.1392 2.63469C21.1392 1.79297 20.492 1.17219 19.5097 1.17219L3.8125 1.17219C2.81937 1.17219 2.18297 1.79297 2.18297 2.63469C2.18297 3.04531 2.36078 3.51844 2.71859 3.99641C3.54078 5.09172 5.41578 6.55078 7.38703 7.71203L6.88594 14.9808C2.63094 16.4825 0 19.8458 0 23.1814Z"/></g></svg>';
              dragIcon.title = 'Pinned';
            } else {
              // Remove pinned indicator and restore drag handle
              templateCard.classList.remove('pinned-template');
              dragIcon.classList.remove('pinned-indicator');
              dragIcon.innerHTML = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" stroke-width="2"><circle cx="12" cy="5" r="1"/><circle cx="19" cy="5" r="1"/><circle cx="5" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/><circle cx="12" cy="19" r="1"/><circle cx="19" cy="19" r="1"/><circle cx="5" cy="19" r="1"/></svg>';
              dragIcon.title = 'Drag to reorder';
            }
          }
        }
      });
    }
  });
}

// Rename a template
function handleRenameTemplate(templateId, newName) {
  chrome.storage.local.get(["savedTemplates"], (result) => {
    const templates = result.savedTemplates || [];
    const template = templates.find(t => t.id === templateId);

    if (template) {
      template.name = newName;
      chrome.storage.local.set({ savedTemplates: templates }, () => {
        debug('Template renamed:', templateId, newName);
        populateTemplatesSubmenu(); // Refresh the templates submenu
      });
    }
  });
}

// Format schedule for display
function formatScheduleDisplay(schedule) {
  if (!schedule || !schedule.enabled) return '';

  const hour = schedule.hour || 0;
  const minute = schedule.minute || 0;
  const timeStr = `${hour % 12 || 12}:${minute.toString().padStart(2, '0')} ${hour >= 12 ? 'PM' : 'AM'}`;

  switch (schedule.type) {
    case 'hourly':
      return getMessage('scheduleHourly') || 'Every hour';
    case 'daily':
      return (getMessage('dailyAt') || 'Daily at {time}').replace('{time}', timeStr);
    case 'weekly':
      if (schedule.daysOfWeek && schedule.daysOfWeek.length > 0) {
        const days = schedule.daysOfWeek.sort((a, b) => a - b);
        if (days.length === 7) {
          return (getMessage('dailyAt') || 'Daily at {time}').replace('{time}', timeStr);
        } else if (days.length === 5 && days.every(d => d >= 1 && d <= 5)) {
          return (getMessage('weekdaysAt') || 'Weekdays at {time}').replace('{time}', timeStr);
        } else if (days.length === 2 && days.includes(0) && days.includes(6)) {
          return (getMessage('weekendsAt') || 'Weekends at {time}').replace('{time}', timeStr);
        } else if (days.length === 1) {
          const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
          return `${dayNames[days[0]]} at ${timeStr}`;
        } else {
          const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
          const dayStr = days.map(d => dayNames[d]).join(', ');
          return `${dayStr} at ${timeStr}`;
        }
      }
      return (getMessage('weeklyAt') || 'Weekly at {time}').replace('{time}', timeStr);
    case 'monthly':
      const dayOfMonth = schedule.dayOfMonth || 1;
      return (getMessage('monthlyOn') || 'Monthly on {day} at {time}').replace('{day}', dayOfMonth).replace('{time}', timeStr);
    default:
      return '';
  }
}

// Toggle schedule editor
function toggleScheduleEditor(template, wrapperElement) {
  // Check if editor already exists
  const existingEditor = wrapperElement.querySelector('.template-schedule-editor');

  if (existingEditor) {
    existingEditor.remove();
    return;
  }

  // Create and show editor
  const editor = createScheduleEditor(template);
  wrapperElement.appendChild(editor);
}

// Create schedule editor UI
function createScheduleEditor(template) {
  const editor = document.createElement('div');
  editor.className = 'template-schedule-editor';

  // Prevent clicks inside editor from bubbling up to template card
  editor.addEventListener('click', (e) => {
    e.stopPropagation();
  });

  const schedule = template.schedule || {
    enabled: false,
    type: 'daily',
    hour: 9,
    minute: 0,
    daysOfWeek: [],
    dayOfMonth: 1
  };

  // Frequency dropdown
  const frequencyLabel = document.createElement('label');
  frequencyLabel.textContent = getMessage('frequency') || 'Frequency:';
  frequencyLabel.className = 'schedule-label';

  const frequencySelect = document.createElement('select');
  frequencySelect.className = 'custom-select schedule-frequency';
  frequencySelect.innerHTML = `
    <option value="hourly" ${schedule.type === 'hourly' ? 'selected' : ''}>${getMessage('scheduleHourly') || 'Every hour'}</option>
    <option value="daily" ${schedule.type === 'daily' ? 'selected' : ''}>${getMessage('scheduleDaily') || 'Daily'}</option>
    <option value="weekly" ${schedule.type === 'weekly' ? 'selected' : ''}>${getMessage('scheduleWeekly') || 'Weekly'}</option>
    <option value="monthly" ${schedule.type === 'monthly' ? 'selected' : ''}>${getMessage('scheduleMonthly') || 'Monthly'}</option>
  `;

  // Time picker (hour, minute, and AM/PM)
  const timeLabel = document.createElement('label');
  timeLabel.textContent = getMessage('time') || 'Time:';
  timeLabel.className = 'schedule-label';

  // Convert 24-hour to 12-hour format for display
  const hour24 = schedule.hour || 0;
  const hour12 = hour24 % 12 || 12;
  const isPM = hour24 >= 12;

  // Hour select (1-12)
  const hourSelect = document.createElement('select');
  hourSelect.className = 'custom-select schedule-hour';
  for (let h = 1; h <= 12; h++) {
    const option = document.createElement('option');
    option.value = h;
    option.textContent = h.toString();
    if (h === hour12) option.selected = true;
    hourSelect.appendChild(option);
  }

  // Minute select (1-minute intervals)
  const minuteSelect = document.createElement('select');
  minuteSelect.className = 'custom-select schedule-minute';
  const minuteOptions = Array.from({length: 60}, (_, i) => i);
  minuteOptions.forEach(m => {
    const option = document.createElement('option');
    option.value = m;
    option.textContent = m.toString().padStart(2, '0');
    if (m === (schedule.minute || 0)) option.selected = true;
    minuteSelect.appendChild(option);
  });

  // AM/PM select
  const ampmSelect = document.createElement('select');
  ampmSelect.className = 'custom-select schedule-ampm';
  const amOption = document.createElement('option');
  amOption.value = 'AM';
  amOption.textContent = 'AM';
  const pmOption = document.createElement('option');
  pmOption.value = 'PM';
  pmOption.textContent = 'PM';
  ampmSelect.appendChild(amOption);
  ampmSelect.appendChild(pmOption);
  if (isPM) ampmSelect.value = 'PM';

  // Days of week selector (for weekly)
  const daysContainer = document.createElement('div');
  daysContainer.className = 'schedule-days';
  const daysLabel = document.createElement('label');
  daysLabel.textContent = getMessage('days') || 'Days:';
  daysLabel.className = 'schedule-label';

  const dayButtons = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
  const dayValues = [0, 1, 2, 3, 4, 5, 6]; // Sunday = 0, Monday = 1, etc.
  const dayButtonsContainer = document.createElement('div');
  dayButtonsContainer.className = 'schedule-day-buttons';

  dayValues.forEach((dayValue, index) => {
    const btn = document.createElement('button');
    btn.className = 'schedule-day-btn';
    btn.textContent = dayButtons[index];
    btn.dataset.day = dayValue;
    if (schedule.daysOfWeek && schedule.daysOfWeek.includes(dayValue)) {
      btn.classList.add('active');
    }
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      btn.classList.toggle('active');
    });
    dayButtonsContainer.appendChild(btn);
  });

  daysContainer.appendChild(daysLabel);
  daysContainer.appendChild(dayButtonsContainer);

  // Day of month selector (for monthly)
  const dayOfMonthContainer = document.createElement('div');
  dayOfMonthContainer.className = 'schedule-day-of-month';
  const dayOfMonthLabel = document.createElement('label');
  dayOfMonthLabel.textContent = getMessage('dayOfMonth') || 'Day of month:';
  dayOfMonthLabel.className = 'schedule-label';

  const dayOfMonthInput = document.createElement('input');
  dayOfMonthInput.type = 'number';
  dayOfMonthInput.className = 'schedule-day-of-month-input';
  dayOfMonthInput.min = '1';
  dayOfMonthInput.max = '31';
  dayOfMonthInput.value = schedule.dayOfMonth || 1;

  dayOfMonthContainer.appendChild(dayOfMonthLabel);
  dayOfMonthContainer.appendChild(dayOfMonthInput);

  // Buttons
  const buttonsContainer = document.createElement('div');
  buttonsContainer.className = 'schedule-buttons';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'secondary-btn';
  cancelBtn.textContent = getMessage('cancel') || 'Cancel';

  const saveBtn = document.createElement('button');
  saveBtn.className = 'primary-btn';
  saveBtn.textContent = getMessage('save') || 'Save';

  const clearBtn = document.createElement('button');
  clearBtn.className = 'schedule-clear-btn';
  clearBtn.textContent = getMessage('clearSchedule') || 'Clear Schedule';
  if (!schedule.enabled) {
    clearBtn.style.display = 'none';
  }

  buttonsContainer.appendChild(cancelBtn);
  buttonsContainer.appendChild(saveBtn);
  buttonsContainer.appendChild(clearBtn);

  // Template settings section (color and pin)
  const settingsSection = document.createElement('div');
  settingsSection.className = 'template-settings-section';
  settingsSection.style.marginBottom = '8px';
  settingsSection.style.paddingBottom = '16px';
  settingsSection.style.borderBottom = '1px solid var(--border-primary)';
  settingsSection.addEventListener('click', (e) => {
    e.stopPropagation();
  });

  // Color picker and pin row (combined)
  const colorRow = document.createElement('div');
  colorRow.style.display = 'flex';
  colorRow.style.alignItems = 'center';
  colorRow.style.gap = '8px';
  colorRow.style.justifyContent = 'space-between';
  colorRow.addEventListener('click', (e) => {
    e.stopPropagation();
  });

  const colorLabel = document.createElement('label');
  colorLabel.textContent = getMessage('filterColor') || 'Color:';
  colorLabel.className = 'schedule-label';
  colorLabel.style.minWidth = 'auto';

  const colorPickerContainer = document.createElement('div');
  colorPickerContainer.className = 'session-color-picker';
  colorPickerContainer.innerHTML = `
    <button class="color-dot color-dot-none" data-color="none" title="None" aria-label="No color"></button>
    <button class="color-dot" data-color="blue" style="background-color: #007AFF;" title="Blue" aria-label="Blue"></button>
    <button class="color-dot" data-color="green" style="background-color: #53b559;" title="Green" aria-label="Green"></button>
    <button class="color-dot" data-color="yellow" style="background-color: #ffc400;" title="Yellow" aria-label="Yellow"></button>
    <button class="color-dot" data-color="orange" style="background-color: #fa6a22;" title="Orange" aria-label="Orange"></button>
    <button class="color-dot" data-color="red" style="background-color: #FF0000;" title="Red" aria-label="Red"></button>
    <button class="color-dot" data-color="pink" style="background-color: #ff66ad;" title="Pink" aria-label="Pink"></button>
    <button class="color-dot" data-color="purple" style="background-color: #924ff6;" title="Purple" aria-label="Purple"></button>
    <button class="color-dot color-dot-custom" data-color="custom" title="Custom color" aria-label="Custom color">
      <input type="color" class="color-picker-input">
    </button>
  `;

  // Prevent container clicks from closing editor
  colorPickerContainer.addEventListener('click', (e) => {
    e.stopPropagation();
  });

  // Mark the currently selected color
  const currentColor = template.color || 'none';
  const colorMap = {
    '#007AFF': 'blue',
    '#00C853': 'green',
    '#FFC107': 'yellow',
    '#FF5722': 'orange',
    '#FF0000': 'red',
    '#9C27B0': 'purple'
  };
  const reverseColorMap = {
    'blue': '#007AFF',
    'green': '#00C853',
    'yellow': '#FFC107',
    'orange': '#FF5722',
    'red': '#FF0000',
    'purple': '#9C27B0'
  };
  const currentColorKey = currentColor.startsWith('#') ? (colorMap[currentColor] || 'custom') : currentColor;

  // Handle color picker clicks
  const colorDots = colorPickerContainer.querySelectorAll('.color-dot');
  colorDots.forEach(dot => {
    // Mark currently selected color
    if (dot.dataset.color === currentColorKey) {
      dot.classList.add('selected');
      // Set the ring color to match the template's color
      if (currentColorKey !== 'none') {
        const ringColor = currentColor.startsWith('#') ? currentColor : reverseColorMap[currentColorKey];
        if (ringColor) {
          dot.style.setProperty('--ring-color', ringColor);
        }
      }
    }

    dot.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();

      const color = dot.dataset.color;

      // If custom color, open the color picker instead
      if (color === 'custom') {
        const colorInput = dot.querySelector('.color-picker-input');
        if (colorInput) {
          colorInput.click();
        }
        return;
      }

      // Remove selected class from all dots and clear ring color
      colorDots.forEach(d => {
        d.classList.remove('selected');
        d.style.removeProperty('--ring-color');
      });
      // Add selected class to clicked dot and set ring color
      dot.classList.add('selected');
      if (color !== 'none') {
        const ringColor = reverseColorMap[color];
        if (ringColor) {
          dot.style.setProperty('--ring-color', ringColor);
        }
      }

      handleTemplateColorChange(template.id, color);
    });
  });

  // Handle custom color picker input
  const colorInput = colorPickerContainer.querySelector('.color-picker-input');
  if (colorInput) {
    colorInput.addEventListener('change', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const hexColor = e.target.value;

      // Remove selected class from all dots and clear ring colors
      colorDots.forEach(d => {
        d.classList.remove('selected');
        d.style.removeProperty('--ring-color');
      });
      // Mark custom as selected and set ring color to the custom color
      const customDot = colorPickerContainer.querySelector('.color-dot[data-color="custom"]');
      if (customDot) {
        customDot.classList.add('selected');
        customDot.style.setProperty('--ring-color', hexColor);
      }

      handleTemplateColorChange(template.id, hexColor);
    });

    // Prevent the click from bubbling
    colorInput.addEventListener('click', (e) => {
      e.stopPropagation();
    });
  }

  // Pin checkbox (matching Filter modal pattern)
  const pinLabel = document.createElement('label');
  pinLabel.style.display = 'flex';
  pinLabel.style.alignItems = 'center';
  pinLabel.style.gap = '6px';
  pinLabel.style.cursor = 'pointer';
  pinLabel.style.marginLeft = 'auto';
  pinLabel.style.fontSize = '13px';
  pinLabel.addEventListener('click', (e) => {
    e.stopPropagation();
  });

  const pinCheckbox = document.createElement('input');
  pinCheckbox.type = 'checkbox';
  pinCheckbox.checked = !!template.pinned;
  pinCheckbox.style.cursor = 'pointer';
  pinCheckbox.addEventListener('change', (e) => {
    e.stopPropagation();
    handleTemplateTogglePin(template.id);
  });

  pinCheckbox.addEventListener('click', (e) => {
    e.stopPropagation();
  });

  const pinTextSpan = document.createElement('span');
  pinTextSpan.style.display = 'flex';
  pinTextSpan.style.alignItems = 'center';
  pinTextSpan.innerHTML = `<svg class="icon" viewBox="0 0 23.6864 36.9547" aria-hidden="true" style="margin: 0px 3px 0 0px; width: 12px; height: 12px; fill: currentColor;"><g><path d="M0 23.1814C0 24.3206 0.788907 25.0745 2.03047 25.0745L10.5417 25.0745L10.5417 33.3208C10.5417 35.2852 11.3383 36.9547 11.6611 36.9547C11.978 36.9547 12.7745 35.2852 12.7745 33.3208L12.7745 25.0745L21.2809 25.0745C22.5225 25.0745 23.3114 24.3206 23.3114 23.1814C23.3114 19.8458 20.6805 16.4825 16.4255 14.9808L15.9244 7.71203C17.9005 6.54594 19.7755 5.09172 20.5928 3.99641C20.9506 3.51844 21.1392 3.04531 21.1392 2.63469C21.1392 1.79297 20.492 1.17219 19.5097 1.17219L3.8125 1.17219C2.81937 1.17219 2.18297 1.79297 2.18297 2.63469C2.18297 3.04531 2.36078 3.51844 2.71859 3.99641C3.54078 5.09172 5.41578 6.55078 7.38703 7.71203L6.88594 14.9808C2.63094 16.4825 0 19.8458 0 23.1814Z"/></g></svg> ${getMessage('pinToTop') || 'Pin to Top'}`;

  pinLabel.appendChild(pinCheckbox);
  pinLabel.appendChild(pinTextSpan);

  colorRow.appendChild(colorLabel);
  colorRow.appendChild(colorPickerContainer);
  colorRow.appendChild(pinLabel);

  settingsSection.appendChild(colorRow);

  // Assemble editor
  const row1 = document.createElement('div');
  row1.className = 'schedule-row';
  row1.appendChild(frequencyLabel);
  row1.appendChild(frequencySelect);

  const row2 = document.createElement('div');
  row2.className = 'schedule-row';
  row2.appendChild(timeLabel);
  row2.appendChild(hourSelect);
  row2.appendChild(minuteSelect);
  row2.appendChild(ampmSelect);

  editor.appendChild(settingsSection);
  editor.appendChild(row1);
  editor.appendChild(row2);
  editor.appendChild(daysContainer);
  editor.appendChild(dayOfMonthContainer);
  editor.appendChild(buttonsContainer);

  // Show/hide relevant fields based on frequency
  const updateVisibleFields = () => {
    const freq = frequencySelect.value;
    row2.style.display = freq === 'hourly' ? 'none' : 'flex';
    daysContainer.style.display = freq === 'weekly' ? 'flex' : 'none';
    dayOfMonthContainer.style.display = freq === 'monthly' ? 'flex' : 'none';
  };

  frequencySelect.addEventListener('change', updateVisibleFields);
  updateVisibleFields();

  // Save button handler
  saveBtn.addEventListener('click', () => {
    // Convert 12-hour format to 24-hour format
    let hour12 = parseInt(hourSelect.value, 10);
    const ampm = ampmSelect.value;
    let hour24 = hour12 % 12; // Convert 12 to 0
    if (ampm === 'PM') hour24 += 12;

    const newSchedule = {
      enabled: true,
      type: frequencySelect.value,
      hour: hour24,
      minute: parseInt(minuteSelect.value, 10),
      daysOfWeek: [],
      dayOfMonth: null,
      lastExecuted: null
    };

    if (newSchedule.type === 'weekly') {
      const activeDays = Array.from(dayButtonsContainer.querySelectorAll('.schedule-day-btn.active'));
      newSchedule.daysOfWeek = activeDays.map(btn => parseInt(btn.dataset.day, 10)).sort((a, b) => a - b);

      if (newSchedule.daysOfWeek.length === 0) {
        alert(getMessage('pleaseSelectAtLeastOneDay') || 'Please select at least one day for weekly schedule.');
        return;
      }
    } else if (newSchedule.type === 'monthly') {
      const dayValue = parseInt(dayOfMonthInput.value, 10);
      if (dayValue < 1 || dayValue > 31) {
        alert(getMessage('pleaseEnterDayBetween1And31') || 'Please enter a day between 1 and 31.');
        return;
      }
      newSchedule.dayOfMonth = dayValue;
    }

    saveTemplateSchedule(template.id, newSchedule);
    editor.remove();
  });

  // Cancel button handler
  cancelBtn.addEventListener('click', () => {
    editor.remove();
  });

  // Clear button handler
  clearBtn.addEventListener('click', () => {
    if (confirm(getMessage('confirmClearSchedule') || 'Clear this schedule?')) {
      saveTemplateSchedule(template.id, null);
      editor.remove();
    }
  });

  return editor;
}

// Save template schedule
function saveTemplateSchedule(templateId, schedule) {
  chrome.storage.local.get(["savedTemplates"], (result) => {
    const templates = result.savedTemplates || [];
    const template = templates.find(t => t.id === templateId);

    if (template) {
      template.schedule = schedule;

      chrome.storage.local.set({ savedTemplates: templates }, () => {
        debug('Template schedule saved:', templateId, schedule);

        // Note: Interval-based scheduler will pick up the new schedule automatically

        // Refresh the modal UI
        renderTemplatesModal();
        populateTemplatesSubmenu();
      });
    }
  });
}

// Setup drag-and-drop reordering for templates
function setupTemplateDragAndDrop() {
  const listContainer = document.getElementById('templatesModalList');
  if (!listContainer) {
    return;
  }

  const templateCards = listContainer.querySelectorAll('.template-item-card');
  let draggedElement = null;
  let dragPreview = null;
  let hasHadDragover = false; // Track whether dragover has occurred

  const clearInsertIndicators = () => {
    listContainer.querySelectorAll('.template-item-card').forEach(c => {
      c.classList.remove('insert-above', 'insert-below');
    });
  };

  const moveDraggedElementToTop = () => {
    if (!draggedElement) return;
    const firstCard = listContainer.querySelector('.template-item-card:not(.dragging)');
    if (firstCard) {
      listContainer.insertBefore(draggedElement, firstCard);
      firstCard.classList.add('insert-above');
    } else {
      listContainer.appendChild(draggedElement);
    }
  };

  const moveDraggedElementToBottom = () => {
    if (!draggedElement) return;
    const lastCard = listContainer.querySelector('.template-item-card:not(.dragging):last-child');
    if (lastCard) {
      listContainer.appendChild(draggedElement);
      lastCard.classList.add('insert-below');
    } else {
      listContainer.appendChild(draggedElement);
    }
  };

  templateCards.forEach((card, index) => {

    card.addEventListener('dragstart', (e) => {

      // Prevent drag if schedule editor is open
      if (card.querySelector('.template-schedule-editor')) {
        e.preventDefault();
        e.stopPropagation();
        return false;
      }

      draggedElement = card;
      hasHadDragover = false; // Reset on each new drag
      card.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', card.dataset.templateId); // Safari requires data to be set

      // Create drag preview with session-like styling (compact blue pill)
      dragPreview = card.cloneNode(true);
      dragPreview.classList.add('drag-preview');
      dragPreview.classList.remove('dragging'); // Remove dragging class that has opacity
      dragPreview.style.position = 'fixed';
      dragPreview.style.zIndex = '10001'; // Higher than modal overlay (10000)
      dragPreview.style.pointerEvents = 'none';
      dragPreview.style.left = e.clientX + 'px';
      dragPreview.style.top = e.clientY + 'px';
      dragPreview.style.width = 'auto'; // Let it size to content
      dragPreview.style.maxWidth = '300px';

      // Hide delete button, info row, tab list, and toggle button in preview
      const deleteBtn = dragPreview.querySelector('.template-delete-btn');
      if (deleteBtn) deleteBtn.style.display = 'none';
      const infoRow = dragPreview.querySelector('.template-info');
      if (infoRow) infoRow.style.display = 'none';
      const tabList = dragPreview.querySelector('.template-tab-list');
      if (tabList) tabList.style.display = 'none';
      const toggleBtn = dragPreview.querySelector('.toggle-button');
      if (toggleBtn) toggleBtn.style.display = 'none';

      document.body.appendChild(dragPreview);

      // Hide the native drag ghost once the transparent pixel is decoded.
      if (invisibleDragImageReady) {
        e.dataTransfer.setDragImage(invisibleDragImage, 0, 0);
      } else {
        // The image is still decoding (only possible immediately after Safari launch),
        // so let Safari render the default preview for this drag attempt.
      }
    });

    card.addEventListener('drag', (e) => {
      if (dragPreview && e.clientX !== 0 && e.clientY !== 0) {
        dragPreview.style.left = e.clientX + 'px';
        dragPreview.style.top = e.clientY + 'px';
      }
    });

    card.addEventListener('dragend', (e) => {
      // Clean up auto-scroll
      stopAutoScroll();

      // Remove drag preview
      if (dragPreview) {
        dragPreview.remove();
        dragPreview = null;
      }

      // Clean up classes
      card.classList.remove('dragging');
      clearInsertIndicators();

      // Mark that we just finished dragging to prevent title editing click
      card.dataset.justDragged = 'true';
      setTimeout(() => {
        delete card.dataset.justDragged;
      }, 200);

      // Only save and animate if we actually had a dragover event (real drag)
      const droppedTemplateId = draggedElement ? draggedElement.dataset.templateId : null;
      if (droppedTemplateId && hasHadDragover) {
        saveTemplateOrder(droppedTemplateId);
      }
      draggedElement = null;
      hasHadDragover = false;
    });

    card.addEventListener('dragover', (e) => {
      e.preventDefault();
      hasHadDragover = true; // Mark that we've had at least one dragover

      // Clear all insert indicators
      clearInsertIndicators();

      const afterElement = getDragAfterElement(listContainer, e.clientY);
      if (afterElement == null) {
        listContainer.appendChild(draggedElement);
        // Add insert indicator to last non-dragging card
        const lastCard = listContainer.querySelector('.template-item-card:not(.dragging):last-child');
        if (lastCard) lastCard.classList.add('insert-below');
      } else {
        listContainer.insertBefore(draggedElement, afterElement);
        // Add insert indicator to the element we're inserting before
        afterElement.classList.add('insert-above');
      }
    });
  });

  // Add auto-scroll while dragging near top or bottom of modal
  let autoScrollInterval = null;
  let lastScrollCheck = 0;

  const startAutoScroll = (direction, modalBody) => {
    if (autoScrollInterval) return; // Already scrolling

    const scrollSpeed = 8; // pixels per frame
    autoScrollInterval = setInterval(() => {
      if (direction === 'up') {
        modalBody.scrollTop = Math.max(0, modalBody.scrollTop - scrollSpeed);
      } else if (direction === 'down') {
        const maxScroll = modalBody.scrollHeight - modalBody.clientHeight;
        modalBody.scrollTop = Math.min(maxScroll, modalBody.scrollTop + scrollSpeed);
      }
    }, 16); // ~60fps
  };

  const stopAutoScroll = () => {
    if (autoScrollInterval) {
      clearInterval(autoScrollInterval);
      autoScrollInterval = null;
    }
  };

  const checkAutoScroll = (e) => {
    const now = Date.now();
    if (now - lastScrollCheck < 50) return; // Throttle to avoid excessive checks
    lastScrollCheck = now;

    const modalBody = document.querySelector('.templates-modal-body');
    if (!modalBody) {
      stopAutoScroll();
      return;
    }

    const rect = modalBody.getBoundingClientRect();
    const scrollZone = 80; // pixels from edge to trigger scroll
    const mouseY = e.clientY;

    // Check if we should scroll
    if (mouseY < rect.top + scrollZone) {
      // Near top - scroll up
      if (!autoScrollInterval) {
        startAutoScroll('up', modalBody);
      }
    } else if (mouseY > rect.bottom - scrollZone) {
      // Near bottom - scroll down
      if (!autoScrollInterval) {
        startAutoScroll('down', modalBody);
      }
    } else {
      // In the middle - stop scrolling
      stopAutoScroll();
    }
  };

  // Use drag event on individual cards instead of container
  templateCards.forEach(card => {
    card.addEventListener('drag', checkAutoScroll);
  });

  // Also monitor dragover on the container as backup AND set hasHadDragover flag
  listContainer.addEventListener('dragover', (e) => {
    hasHadDragover = true; // Ensure this gets set even if card-level dragover doesn't fire
    checkAutoScroll(e);
  });

  // Also allow dropping on the modal header to place at top
  const modalHeader = document.querySelector('.templates-modal-header');
  if (modalHeader) {
    modalHeader.addEventListener('dragover', (e) => {
      if (!draggedElement) return;
      e.preventDefault();
      hasHadDragover = true;
      stopAutoScroll();
      clearInsertIndicators();
      moveDraggedElementToTop();
    });
  }

  // Allow drops in the padding gaps above the first card (between the header and list) and below the last card
  const modalBody = document.querySelector('.templates-modal-body');
  if (modalBody) {
    modalBody.addEventListener('dragover', (e) => {
      if (!draggedElement) return;
      const listRect = listContainer.getBoundingClientRect();
      const pointerY = e.clientY;
      if (pointerY >= listRect.top && pointerY <= listRect.bottom) {
        return; // Pointer is inside the list area; defer to card/container handlers.
      }
      e.preventDefault();
      hasHadDragover = true;
      stopAutoScroll();
      clearInsertIndicators();
      if (pointerY < listRect.top) {
        moveDraggedElementToTop();
      } else {
        moveDraggedElementToBottom();
      }
    });
  }
}

// Get the element after which the dragged element should be inserted
function getDragAfterElement(container, y) {
  const draggableElements = [...container.querySelectorAll('.template-item-card:not(.dragging)')];

  return draggableElements.reduce((closest, child) => {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;

    if (offset < 0 && offset > closest.offset) {
      return { offset: offset, element: child };
    } else {
      return closest;
    }
  }, { offset: Number.NEGATIVE_INFINITY }).element;
}

// Highlight a template with drop animation after reordering
function highlightDropTemplate(templateId) {
  setTimeout(() => {
    const templateCard = document.querySelector(`.template-item-card[data-template-id="${templateId}"]`);
    if (!templateCard) return;
    templateCard.classList.add('scale-drop');
    setTimeout(() => {
      templateCard.classList.remove('scale-drop');
    }, 180);
  }, 50);
}

// Save the new template order after drag-and-drop
function saveTemplateOrder(droppedTemplateId) {
  const listContainer = document.getElementById('templatesModalList');
  if (!listContainer) return;

  const templateCards = listContainer.querySelectorAll('.template-item-card');
  const newOrder = Array.from(templateCards).map(card => card.dataset.templateId);

  chrome.storage.local.get(["savedTemplates"], (result) => {
    let templates = result.savedTemplates || [];

    // Reorder templates array based on new order
    templates.sort((a, b) => {
      return newOrder.indexOf(a.id) - newOrder.indexOf(b.id);
    });

    chrome.storage.local.set({ savedTemplates: templates }, () => {
      debug('Template order saved');
      // Animate the dropped template if provided
      if (droppedTemplateId) {
        highlightDropTemplate(droppedTemplateId);
      }
    });
  });
}

// Create a new session from a template
function handleSpawnFromTemplate(templateId) {
  debug('Spawning session from template:', templateId);

  chrome.storage.local.get(["savedTemplates", "savedSessions"], (result) => {
    const templates = result.savedTemplates || [];
    const sessions = result.savedSessions || [];

    const template = templates.find(t => t.id === templateId);
    if (!template) {
      debug('Template not found:', templateId);
      return;
    }

    // Create new session from template
    const ts = new Date().toISOString();
    const newSession = {
      timestamp: ts,
      customName: template.name,
      tabs: template.tabs.map(tab => ({ ...tab })), // Copy tabs
      color: template.color || null,
      pinned: template.pinned || false
    };

    // If template has pinned status, set pinnedAt timestamp
    if (newSession.pinned) {
      newSession.pinnedAt = Date.now();
    }

    sessions.unshift(newSession);
    savedSessions = sessions;
    chrome.storage.local.set({ savedSessions: sessions }, () => {
      debug('Session created from template:', newSession);
      updateSessionList(sessions);
      setTimeout(() => highlightAddSession(ts), 50);
    });
  });
}

function handleExport(format, callback) {
  debug('[EXPORT] handleExport called with format:', format);
  chrome.storage.local.get(["savedSessions"], (result) => {
    let sessions = result.savedSessions || [];
    debug('[EXPORT] Retrieved', sessions.length, 'sessions from storage');
    if (!sessions || sessions.length === 0) {
      debug('[EXPORT] No sessions to export, showing alert');
      alert(getMessage("noSavedLinksToExport"));
      if (callback) callback();
      return;
    }

    let exportText = "";
    let mimeType = "text/plain";
    let fileExtension = "txt";

    switch (format) {
      case "plain":
        exportText = generatePlainTextExport(sessions);
        fileExtension = "txt";
        break;
      case "rtf":
        exportText = generateRTFExport(sessions);
        mimeType = "application/rtf";
        fileExtension = "rtf";
        break;
      case "markdown":
        exportText = generateMarkdownExport(sessions);
        fileExtension = "md";
        break;
      case "html":
        exportText = generateHTMLExport(sessions);
        mimeType = "text/html";
        fileExtension = "html";
        break;
      case "json":
        exportText = JSON.stringify(sessions, null, 2);
        mimeType = "application/json";
        fileExtension = "json";
        break;
      case "opml":
        exportText = generateOPMLExport(sessions);
        mimeType = "text/xml";
        fileExtension = "opml";
        break;
      default:
        exportText = "Unsupported format";
    }

    debug('[EXPORT] Generated export text, length:', exportText.length, 'type:', mimeType);

    const blob = new Blob([exportText], { type: mimeType });
    const url = URL.createObjectURL(blob);
    debug('[EXPORT] Created blob URL:', url);
    const a = document.createElement('a');
    a.href = url;

    // Generate date string in YYYYMMDD format
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const dateString = `${year}${month}${day}`;

    a.download = `tabstract-export-${dateString}.${fileExtension}`;
    debug('[EXPORT] Appending link and triggering click:', a.download);
    document.body.appendChild(a);
    a.click();
    debug('[EXPORT] Click executed');
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    debug('[EXPORT] Cleanup complete');

    // Call callback after download is triggered
    if (callback) {
      setTimeout(callback, 100);
    }
  });
}

function showTemporarySuccess(message) {
  // Create a temporary success message overlay
  const overlay = document.createElement('div');
  overlay.style.cssText = `
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    background: var(--success);
    color: white;
    padding: 12px 24px;
    border-radius: 6px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    z-index: 10000;
    font-size: 14px;
    font-weight: 500;
    animation: fadeInOut 2s ease-in-out;
  `;
  overlay.textContent = message;
  document.body.appendChild(overlay);

  setTimeout(() => {
    overlay.remove();
  }, 2000);
}

// ================================================
// Import Functionality
// ================================================

function isValidUrl(url) {
  if (!(url.startsWith("http://") || url.startsWith("https://"))) return false;
  try {
    new URL(url);
    return true;
  } catch (e) {
    return false;
  }
}

function getFaviconForUrl(url) {
  try {
    const domain = new URL(url).hostname;
    if (domain) return `https://www.google.com/s2/favicons?sz=32&domain=${domain}`;
  } catch (e) {}
  return chrome.runtime.getURL("images/default_favicon.png");
}

function finishImport(importResult) {
  const importedSessions = importResult.sessions;
  const errorCount = importResult.errorCount;

  // Set favicons only - titles will be fetched in background on list.html
  importedSessions.forEach(session => {
    session.tabs.forEach(tab => {
      if (!tab.favicon || !tab.favicon.startsWith("http")) {
        tab.favicon = getFaviconForUrl(tab.url);
      }
    });
  });

  let totalValidLinks = 0;
  importedSessions.forEach(s => {
    totalValidLinks += s.tabs.length;
  });

  // Save immediately and show confirmation
  chrome.storage.local.get(["savedSessions"], (result) => {
    const existing = result.savedSessions || [];
    const merged = importedSessions.concat(existing);
    chrome.storage.local.set({ savedSessions: merged }, () => {
      alert(
        `Imported ${totalValidLinks} valid link(s) (across ${importedSessions.length} session(s)).\n` +
        `Skipped ${errorCount} invalid link(s).\n\n` +
        `Page titles will be fetched in the background.`
      );
      chrome.runtime.sendMessage({ action: "refreshBadge" });
      // Refresh the session list
      chrome.storage.local.get(["savedSessions"], (refreshResult) => {
        updateSessionList(refreshResult.savedSessions || []);
      });
    });
  });
}

function detectAndImportJSON(content) {
  try {
    const testData = JSON.parse(content);

    if (Array.isArray(testData) && testData.length > 0) {
      const firstItem = testData[0];

      // Check for Tab Space format (has 'sites' property)
      if (firstItem && firstItem.sites) {
        finishImport(importTabSpace(content));
        return true;
      }
      // Check for Tabs Saver format (has 'containsNotFullyLoadedTabs' and 'created' and 'id' properties)
      if (
        firstItem &&
        Object.prototype.hasOwnProperty.call(firstItem, 'containsNotFullyLoadedTabs') &&
        Object.prototype.hasOwnProperty.call(firstItem, 'created') &&
        Object.prototype.hasOwnProperty.call(firstItem, 'id')
      ) {
        finishImport(importTabsSaver(content));
        return true;
      }

      // Default to Tabstract JSON
      finishImport(importJSON(content));
      return true;
    } else {
      finishImport(importJSON(content));
      return true;
    }
  } catch (e) {
    return false;
  }
}

function importOPML(fileContent) {
  let errorCount = 0;
  const parser = new DOMParser();
  const doc = parser.parseFromString(fileContent, "application/xml");
  const body = doc.getElementsByTagName("body")[0];
  const sessions = [];
  if (!body) return { sessions, errorCount };

  const sessionOutlines = body.children;
  let baseTime = Date.now();
  for (let i = 0; i < sessionOutlines.length; i++) {
    const sessionOutline = sessionOutlines[i];
    const sessionName = sessionOutline.getAttribute("text") || "Imported Session";
    const session = {
      timestamp: new Date(baseTime + i).toISOString(),
      customName: sessionName,
      tabs: []
    };
    const tabOutlines = sessionOutline.children;
    for (let j = 0; j < tabOutlines.length; j++) {
      const tabOutline = tabOutlines[j];
      const tabTitle = tabOutline.getAttribute("text") || "";
      const tabUrl = tabOutline.getAttribute("htmlUrl") || "";
      if (tabUrl && isValidUrl(tabUrl)) {
        session.tabs.push({ title: tabTitle, url: tabUrl, favicon: "" });
      } else {
        errorCount++;
      }
    }
    sessions.push(session);
  }
  return { sessions, errorCount };
}

function importTSV(fileContent, callback) {
  let errorCount = 0;
  const lines = fileContent.split(/\r?\n/);
  let currentSession = null;
  const sessions = [];
  let hasSessionHeader = false;
  let sessionCounter = 0;

  lines.forEach(line => {
    line = line.trim();
    if (line.startsWith("Session: ")) {
      hasSessionHeader = true;
      if (currentSession) {
        sessions.push(currentSession);
      }
      const sessionName = line.substring(9).trim();
      currentSession = {
        timestamp: new Date(Date.now() + sessionCounter++).toISOString(),
        customName: sessionName,
        tabs: []
      };
    } else if (!line) {
      if (currentSession) {
        sessions.push(currentSession);
        currentSession = null;
      }
    } else if (currentSession) {
      const parts = line.split("\t");
      if (parts.length >= 2) {
        const tabTitle = parts[0].trim();
        const tabUrl = parts[1].trim();
        if (tabUrl && isValidUrl(tabUrl)) {
          currentSession.tabs.push({ title: tabTitle, url: tabUrl, favicon: "" });
        } else {
          errorCount++;
        }
      }
    }
  });
  if (currentSession) {
    sessions.push(currentSession);
  }

  if (!hasSessionHeader) {
    const session = {
      timestamp: new Date(Date.now() + sessionCounter++).toISOString(),
      customName: "",
      tabs: []
    };
    lines.forEach(ln => {
      const lineTrim = ln.trim();
      if (lineTrim) {
        const parts = lineTrim.split("\t");
        let tabTitle = "";
        let tabUrl = "";
        if (parts.length >= 2) {
          tabTitle = parts[0].trim();
          tabUrl = parts[1].trim();
        } else if (parts.length === 1) {
          tabUrl = parts[0].trim();
          tabTitle = tabUrl;
        }
        if (tabUrl && isValidUrl(tabUrl)) {
          session.tabs.push({ title: tabTitle, url: tabUrl, favicon: "" });
        } else {
          errorCount++;
        }
      }
    });
    chrome.runtime.sendMessage({ action: "getDefaultSessionTitle" }, (defaultTitle) => {
      session.customName = defaultTitle;
      sessions.push(session);
      callback({ sessions, errorCount });
    });
  } else {
    callback({ sessions, errorCount });
  }
}

function importJSON(fileContent) {
  let errorCount = 0;
  try {
    const data = JSON.parse(fileContent);
    if (Array.isArray(data)) {
      data.forEach(session => {
        if (session.tabs && Array.isArray(session.tabs)) {
          const validTabs = [];
          session.tabs.forEach(tab => {
            if (tab.url && isValidUrl(tab.url)) {
              validTabs.push(tab);
            } else {
              errorCount++;
            }
          });
          session.tabs = validTabs;
        }
      });
      return { sessions: data, errorCount };
    } else {
      alert(getMessage("invalidJsonFormat"));
      return { sessions: [], errorCount: 0 };
    }
  } catch (e) {
    alert(getMessage("errorParsingJson") || `Error parsing JSON: ${e.message}`);
    return { sessions: [], errorCount: 0 };
  }
}

function importOneTab(fileContent) {
  let errorCount = 0;
  const sessions = [];

  // Split content by double line breaks to separate sessions
  const sessionBlocks = fileContent.split(/\n\s*\n/).filter(block => block.trim().length > 0);

  let baseTime = Date.now();

  sessionBlocks.forEach((sessionBlock, sessionIndex) => {
    const lines = sessionBlock.split(/\r?\n/).filter(line => line.trim().length > 0);

    if (lines.length === 0) return;

    const session = {
      timestamp: new Date(baseTime + sessionIndex).toISOString(),
      customName: `OneTab Import ${sessionIndex + 1}`,
      tabs: []
    };

    lines.forEach(line => {
      line = line.trim();
      if (line.length === 0) return;

      // OneTab format: URL | TITLE
      const parts = line.split(' | ');
      if (parts.length >= 2) {
        const tabUrl = parts[0].trim();
        const tabTitle = parts.slice(1).join(' | ').trim(); // Handle titles with | in them

        if (tabUrl && isValidUrl(tabUrl)) {
          session.tabs.push({
            title: tabTitle || tabUrl,
            url: tabUrl,
            favicon: ""
          });
        } else {
          errorCount++;
        }
      } else {
        // Handle single URLs without titles
        const tabUrl = line.trim();
        if (tabUrl && isValidUrl(tabUrl)) {
          session.tabs.push({
            title: tabUrl,
            url: tabUrl,
            favicon: ""
          });
        } else {
          errorCount++;
        }
      }
    });

    // Only add session if it has valid tabs
    if (session.tabs.length > 0) {
      sessions.push(session);
    }
  });

  return { sessions, errorCount };
}

function importTabSpace(fileContent) {
  let errorCount = 0;
  const sessions = [];

  try {
    const data = JSON.parse(fileContent);

    if (!Array.isArray(data)) {
      alert(getMessage("invalidJsonFormat"));
      return { sessions: [], errorCount: 0 };
    }

    let baseTime = Date.now();

    data.forEach((sessionData, sessionIndex) => {
      // Skip sessions tagged with @Trash
      if (sessionData.tags && sessionData.tags.includes('@Trash')) {
        return;
      }

      const session = {
        timestamp: new Date(baseTime + sessionIndex).toISOString(),
        customName: sessionData.title || `Tab Space Import ${sessionIndex + 1}`,
        tabs: []
      };

      // Tab Space uses 'sites' instead of 'tabs'
      const sites = sessionData.sites || [];

      sites.forEach(site => {
        const tabUrl = site.url || site.href;
        const tabTitle = site.title || site.name || tabUrl;

        if (tabUrl && isValidUrl(tabUrl)) {
          session.tabs.push({
            title: tabTitle,
            url: tabUrl,
            favicon: site.favicon || ""
          });
        } else {
          errorCount++;
        }
      });

      // Only add session if it has valid tabs
      if (session.tabs.length > 0) {
        sessions.push(session);
      }
    });

    return { sessions, errorCount };
  } catch (e) {
    alert(getMessage("errorParsingJson") || `Error parsing JSON: ${e.message}`);
    return { sessions: [], errorCount: 0 };
  }
}

function importTabsSaver(fileContent) {
  let errorCount = 0;
  const sessions = [];

  try {
    const data = JSON.parse(fileContent);

    if (!Array.isArray(data)) {
      alert(getMessage("invalidJsonFormat"));
      return { sessions: [], errorCount: 0 };
    }

    let baseTime = Date.now();

    data.forEach((sessionData, sessionIndex) => {
      // Skip sessions in trash folder (more precise matching)
      if (sessionData.folder && (sessionData.folder.includes('Trash') || sessionData.folder === '🗑 Trash')) {
        return;
      }

      // Create session name from name field or folder if no name
      let sessionName = sessionData.name || '';
      if (!sessionName && sessionData.folder) {
        sessionName = `${sessionData.folder}`;
      }
      if (!sessionName) {
        sessionName = `Tabs Saver Import ${sessionIndex + 1}`;
      }

      const session = {
        timestamp: sessionData.created ? new Date(sessionData.created * 1000).toISOString() : new Date(baseTime + sessionIndex).toISOString(),
        customName: sessionName,
        tabs: []
      };

      // Process tabs
      const tabs = sessionData.tabs || [];

      tabs.forEach((tab, tabIndex) => {
        const tabUrl = tab.url;
        const tabTitle = tab.title || tabUrl;

        const isValid = tabUrl && isValidUrl(tabUrl);

        if (isValid) {
          session.tabs.push({
            title: tabTitle,
            url: tabUrl,
            favicon: ""
          });
        } else {
          errorCount++;
        }
      });

      // Only add session if it has valid tabs
      if (session.tabs.length > 0) {
        sessions.push(session);
      }
    });

    return { sessions, errorCount };
  } catch (e) {
    alert(getMessage("errorParsingJson") || `Error parsing JSON: ${e.message}`);
    return { sessions: [], errorCount: 0 };
  }
}

function importMarkdown(fileContent) {
  let errorCount = 0;
  const sessions = [];

  const lines = fileContent.split(/\r?\n/);
  let currentSession = null;
  let sessionCounter = 0;
  let pendingTitle = null; // any non-empty line above a link list
  let pendingSeparator = false; // true when we saw an "X Tabs" header that should start a new session with default name

  function startNewSession(name) {
    if (currentSession && currentSession.tabs.length > 0) {
      sessions.push(currentSession);
    }
    currentSession = {
      timestamp: new Date(Date.now() + sessionCounter).toISOString(),
      customName: (name && name.trim()) || `Markdown Import ${sessions.length + 1}`,
      tabs: []
    };
    sessionCounter++;
  }

  lines.forEach((raw) => {
    const line = raw.trim();
    if (!line) return;

    // Detect markdown list item with link: - [Title](URL) or * [Title](URL)
    const mdMatch = line.match(/^[-*]\s+\[([^\]]+)\]\(([^)\s]+)\)/);
    if (mdMatch) {
      // Start a new session if none exists, or if a new title/section was seen since last link
      if (!currentSession) {
        startNewSession(pendingTitle || undefined);
        pendingTitle = null;
        pendingSeparator = false;
      } else if ((pendingTitle || pendingSeparator) && currentSession.tabs.length > 0) {
        if (pendingTitle) {
          startNewSession(pendingTitle);
        } else {
          startNewSession(); // separator like "X Tabs" -> default name
        }
        pendingTitle = null;
        pendingSeparator = false;
      }

      const title = mdMatch[1].trim();
      const url = mdMatch[2].trim();
      if (isValidUrl(url)) {
        currentSession.tabs.push({ title: title || url, url, favicon: "" });
      } else {
        errorCount++;
      }
      return;
    }

    // For any other non-empty, non-link line:
    // - If it looks like "X Tabs" (with optional leading #), treat it as a section separator
    //   but do NOT use it as the session name (default names will be used).
    // - Otherwise, record it as a potential session title.
    const tabsHeader = line.match(/^#{0,6}\s*\d+\s+Tabs\b/i);
    if (tabsHeader) {
      pendingTitle = null;
      pendingSeparator = true;
    } else {
      pendingTitle = line.replace(/^#{1,6}\s*/, '').trim();
      pendingSeparator = false;
    }
  });

  if (currentSession && currentSession.tabs.length > 0) {
    sessions.push(currentSession);
  }

  return { sessions, errorCount };
}

function handleImportFile(file) {
  if (!file) {
    alert(getMessage("selectFileToImport") || "Please select a file to import.");
    return;
  }

  const reader = new FileReader();
  reader.onload = (ev) => {
    try {
      const content = ev.target.result;
      const extension = file.name.split('.').pop().toLowerCase();

      // First, sniff for JSON regardless of extension. This allows .txt exports
      // (like Tabs Saver) that contain JSON to import correctly.
      if (detectAndImportJSON(content)) {
        return; // Import was handled by detectAndImportJSON
      }

      if (extension === "opml") {
        finishImport(importOPML(content));
      } else if (extension === "tabspace") {
        finishImport(importTabSpace(content));
      } else if (extension === "md" || extension === "markdown") {
        finishImport(importMarkdown(content));
      } else if (extension === "json") {
        // Detect JSON format type
        if (!detectAndImportJSON(content)) {
          finishImport(importJSON(content));
        }
      } else if (extension === "tsv" || extension === "txt") {
        // Check for Markdown bullets first
        if (/^\s*[-*]\s+\[[^\]]+\]\((https?:\/\/[^\s)]+)\)/m.test(content)) {
          finishImport(importMarkdown(content));
        } else if (content.includes(' | ') && content.match(/^https?:\/\/.*? \| /m)) {
          // Check if it's OneTab format (contains " | " separators)
          finishImport(importOneTab(content));
        } else {
          importTSV(content, (resultObj) => finishImport(resultObj));
        }
      } else {
        alert(getMessage("unrecognizedFileFormat") || "Unrecognized file format. Supported formats: JSON, OPML, Markdown, TSV, and exports from Tab Space, Tabs Saver, and OneTab.");
      }
    } catch (error) {
      debug('[Tabstract Import] Import failed:', error);
      alert((getMessage('importFailedPrefix') || 'Import failed: ') + error.message);
    }
  };
  reader.readAsText(file);
}

// =============================
// Search Results
// =============================

let currentSearchResults = []; // Store current search results
let currentSearchQuery = ''; // Store current search query for session naming

// Initialize UI state for all features
function initializeFeatureState() {
  // Update Templates and Smart Groups menu items in header
  updateTemplatesButtonState();
  updateSmartGroupsButtonState();
  updateResetGroupColorsButtonState();
  updateFullScreenModeButtonState();

  // Update all Save as Template buttons in session menus
  document.querySelectorAll('.save-template-btn').forEach(btn => {
    btn.classList.remove('disabled');
  });

  // Update all color picker containers in session menus
  document.querySelectorAll('.session-color-picker-container').forEach(container => {
    const colorPicker = container.querySelector('.session-color-picker');

    // Add "none" button if it doesn't exist
    if (colorPicker && !colorPicker.querySelector('[data-color="none"]')) {
      const noneButton = document.createElement('button');
      noneButton.className = 'color-dot color-dot-none';
      noneButton.setAttribute('data-color', 'none');
      noneButton.setAttribute('title', 'None');
      noneButton.setAttribute('aria-label', 'No color');

      // Add click handler for the none button
      const timestamp = colorPicker.dataset.timestamp;
      noneButton.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        handleSessionColorChange(timestamp, 'none');
      });

      // Insert at the beginning of the color picker
      colorPicker.insertBefore(noneButton, colorPicker.firstChild);
    }

    // Enable all color dots and color inputs
    container.querySelectorAll('.color-dot').forEach(dot => {
      dot.removeAttribute('disabled');
    });
    container.querySelectorAll('.color-picker-input').forEach(input => {
      input.removeAttribute('disabled');
    });
  });
}

// Listen for messages from background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "runFiltersComplete") {
    // Filters have been run - show undo button and refresh list
    showRunFiltersUndo(message.stats);
    loadSessions();
  }
});

// ===========================================
// Smart Groups Management
// ===========================================

let currentEditingSmartGroup = null; // Track which Smart Group is being edited
let currentSmartGroupColor = null; // Track the selected color for the Smart Group
let shouldReturnToSmartGroupsList = false; // Track if we should reopen Smart Groups modal on cancel

// Smart Groups button click handler
// Manage Filters button (opens modal)
const manageFiltersBtn = document.getElementById('manageFiltersBtn');
if (manageFiltersBtn) {
  manageFiltersBtn.addEventListener('click', (e) => {
    e.preventDefault();
    closeActionsMenu();
    openSmartGroupsModal();
  });
}

// Run Filters button
const runFiltersBtn = document.getElementById('runFiltersBtn');
if (runFiltersBtn) {
  runFiltersBtn.addEventListener('click', (e) => {
    e.preventDefault();
    closeActionsMenu();
    showRunFiltersConfirmation();
  });
}

// Open Smart Groups modal
function openSmartGroupsModal() {
  const modal = document.getElementById('smartGroupsModal');
  if (!modal) return;

  modal.style.display = 'flex';
  document.body.classList.add('modal-open');

  // Apply internationalization to modal elements
  if (typeof applyInternationalization === 'function') {
    applyInternationalization();
  }

  renderSmartGroupsList();

  // Close button handler
  const closeBtn = document.getElementById('smartGroupsModalClose');
  if (closeBtn) {
    closeBtn.onclick = () => {
      modal.style.display = 'none';
      document.body.classList.remove('modal-open');
    };
  }

  // Create button handler
  const createBtn = document.getElementById('createSmartGroupBtn');
  if (createBtn) {
    createBtn.onclick = () => {
      currentEditingSmartGroup = null;
      shouldReturnToSmartGroupsList = true; // Creating new, return to list on cancel
      modal.style.display = 'none'; // Hide Smart Groups modal
      openSmartGroupEditor();
    };
  }

  // Close on overlay click
  modal.onclick = (e) => {
    if (e.target === modal) {
      modal.style.display = 'none';
      document.body.classList.remove('modal-open');
    }
  };
}

// Render Smart Groups list
function renderSmartGroupsList() {
  chrome.storage.local.get(['smartGroups'], (result) => {
    const smartGroups = result.smartGroups || [];
    const listContainer = document.getElementById('smartGroupsModalList');
    if (!listContainer) return;

    listContainer.innerHTML = '';

    if (smartGroups.length === 0) {
      listContainer.innerHTML = `
        <div style="padding: 20px; text-align: center; color: var(--text-secondary);">
          ${getMessage('smartGroupsEmptyMessage') || 'No Filters created yet.'}<br>
          ${getMessage('clickNewToGetStarted') || 'Click "New" to get started.'}
        </div>
      `;
      return;
    }

    // Sort by priority
    const sortedGroups = [...smartGroups].sort((a, b) => (a.priority || 0) - (b.priority || 0));

    sortedGroups.forEach((group, index) => {
      // Main wrapper
      const wrapper = document.createElement('div');
      wrapper.className = 'template-item-card collapsed';
      wrapper.dataset.groupId = group.id;
      wrapper.draggable = true;

      // Header
      const header = document.createElement('div');
      header.className = 'template-header';

      // Title container
      const titleContainer = document.createElement('div');
      titleContainer.className = 'template-title-container';
      titleContainer.style.flex = '1';

      // Drag icon
      const dragIcon = document.createElement('span');
      dragIcon.className = 'template-drag-handle';
      dragIcon.innerHTML = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" stroke-width="2"><circle cx="12" cy="5" r="1"/><circle cx="19" cy="5" r="1"/><circle cx="5" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/><circle cx="12" cy="19" r="1"/><circle cx="19" cy="19" r="1"/><circle cx="5" cy="19" r="1"/></svg>';
      dragIcon.title = "Drag to reorder";

      // Title span
      const titleSpan = document.createElement('span');
      titleSpan.className = 'template-title';
      const patterns = group.patterns || [];
      titleSpan.textContent = group.name;

      titleContainer.appendChild(dragIcon);
      titleContainer.appendChild(titleSpan);

      // Button container for edit and delete
      const buttonContainer = document.createElement('div');
      buttonContainer.style.display = 'flex';
      buttonContainer.style.alignItems = 'center';
      buttonContainer.style.gap = '0px';

      // Edit button (gear icon)
      const editBtn = document.createElement('button');
      editBtn.className = 'template-delete-btn smart-group-edit-btn';
      editBtn.title = "Edit Filter";
      editBtn.setAttribute('aria-label', "Edit Filter");
      editBtn.innerHTML = `
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M9.46289 20.8789L11.4355 20.8789C12.1875 20.8789 12.7734 20.4199 12.9395 19.6973L13.3594 17.8711L13.6719 17.7637L15.2637 18.7402C15.8984 19.1309 16.6309 19.043 17.168 18.5059L18.5352 17.1484C19.0723 16.6113 19.1602 15.8691 18.7695 15.2441L17.7734 13.6621L17.8906 13.3691L19.7168 12.9395C20.4297 12.7734 20.8984 12.1777 20.8984 11.4355L20.8984 9.50195C20.8984 8.75977 20.4395 8.17383 19.7168 7.99805L17.9102 7.55859L17.7832 7.24609L18.7793 5.66406C19.1699 5.03906 19.0918 4.30664 18.5449 3.75977L17.1777 2.39258C16.6504 1.86523 15.918 1.76758 15.2832 2.1582L13.6914 3.13477L13.3594 3.00781L12.9395 1.18164C12.7734 0.458984 12.1875 0 11.4355 0L9.46289 0C8.71094 0 8.125 0.458984 7.95898 1.18164L7.5293 3.00781L7.19727 3.13477L5.61523 2.1582C4.98047 1.76758 4.23828 1.86523 3.71094 2.39258L2.35352 3.75977C1.80664 4.30664 1.71875 5.03906 2.11914 5.66406L3.10547 7.24609L2.98828 7.55859L1.18164 7.99805C0.458984 8.17383 0 8.75977 0 9.50195L0 11.4355C0 12.1777 0.46875 12.7734 1.18164 12.9395L3.00781 13.3691L3.11523 13.6621L2.12891 15.2441C1.72852 15.8691 1.82617 16.6113 2.36328 17.1484L3.7207 18.5059C4.25781 19.043 5 19.1309 5.63477 18.7402L7.2168 17.7637L7.5293 17.8711L7.95898 19.6973C8.125 20.4199 8.71094 20.8789 9.46289 20.8789ZM9.61914 19.3555C9.45312 19.3555 9.36523 19.2871 9.33594 19.1309L8.75 16.709C8.1543 16.5625 7.59766 16.3281 7.17773 16.0645L5.04883 17.373C4.93164 17.4609 4.79492 17.4512 4.6875 17.3242L3.53516 16.1719C3.42773 16.0645 3.41797 15.9473 3.49609 15.8105L4.80469 13.7012C4.58008 13.291 4.32617 12.7344 4.16992 12.1387L1.74805 11.5625C1.5918 11.5332 1.52344 11.4453 1.52344 11.2793L1.52344 9.64844C1.52344 9.47266 1.58203 9.39453 1.74805 9.36523L4.16016 8.7793C4.31641 8.14453 4.60938 7.56836 4.78516 7.20703L3.48633 5.09766C3.39844 4.95117 3.4082 4.83398 3.51562 4.7168L4.67773 3.58398C4.79492 3.4668 4.90234 3.45703 5.04883 3.53516L7.1582 4.81445C7.57812 4.58008 8.17383 4.33594 8.75977 4.16992L9.33594 1.74805C9.36523 1.5918 9.45312 1.52344 9.61914 1.52344L11.2793 1.52344C11.4453 1.52344 11.5332 1.5918 11.5527 1.74805L12.1484 4.18945C12.7539 4.3457 13.2812 4.58984 13.7207 4.82422L15.8398 3.53516C15.9961 3.45703 16.0938 3.4668 16.2207 3.58398L17.373 4.7168C17.4902 4.83398 17.4902 4.95117 17.4023 5.09766L16.1035 7.20703C16.2891 7.56836 16.5723 8.14453 16.7285 8.7793L19.1504 9.36523C19.3066 9.39453 19.375 9.47266 19.375 9.64844L19.375 11.2793C19.375 11.4453 19.2969 11.5332 19.1504 11.5625L16.7188 12.1387C16.5625 12.7344 16.3184 13.291 16.084 13.7012L17.3926 15.8105C17.4707 15.9473 17.4707 16.0645 17.3535 16.1719L16.2109 17.3242C16.0938 17.4512 15.9668 17.4609 15.8398 17.373L13.7109 16.0645C13.291 16.3281 12.7441 16.5625 12.1484 16.709L11.5527 19.1309C11.5332 19.2871 11.4453 19.3555 11.2793 19.3555ZM10.4492 14.1602C12.5098 14.1602 14.1699 12.5 14.1699 10.4395C14.1699 8.37891 12.5098 6.71875 10.4492 6.71875C8.38867 6.71875 6.72852 8.37891 6.72852 10.4395C6.72852 12.5 8.38867 14.1602 10.4492 14.1602ZM10.4492 12.6465C9.22852 12.6465 8.24219 11.6602 8.24219 10.4395C8.24219 9.21875 9.22852 8.23242 10.4492 8.23242C11.6699 8.23242 12.6562 9.21875 12.6562 10.4395C12.6562 11.6602 11.6699 12.6465 10.4492 12.6465Z" fill="currentColor"/>
        </svg>
      `;
      editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        editSmartGroup(group);
      });

      // Delete button
      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'template-delete-btn smart-group-delete-btn';
      deleteBtn.title = getMessage('deleteSmartGroup') || "Delete Filter";
      deleteBtn.setAttribute('aria-label', getMessage('deleteSmartGroup') || "Delete Filter");
      deleteBtn.innerHTML = `
        <svg viewBox="0 0 31.179 38.1519" aria-hidden="true">
          <path fill="currentColor" d="M10.8009 29.9681C11.4594 29.9681 11.8837 29.5509 11.8681 28.9366L11.3894 12.5553C11.3709 11.9465 10.9409 11.5422 10.3109 11.5422C9.65812 11.5422 9.23655 11.9594 9.25218 12.5709L9.71812 28.945C9.73655 29.5666 10.1694 29.9681 10.8009 29.9681ZM15.4034 29.9681C16.0506 29.9681 16.5062 29.5566 16.5062 28.9478L16.5062 12.5653C16.5062 11.9565 16.0506 11.5422 15.4034 11.5422C14.7534 11.5422 14.3106 11.9565 14.3106 12.5653L14.3106 28.9478C14.3106 29.5566 14.7534 29.9681 15.4034 29.9681ZM20.0159 29.9681C20.6375 29.9681 21.0675 29.5666 21.0859 28.945L21.5519 12.5709C21.5675 11.9594 21.1459 11.5422 20.4931 11.5422C19.8631 11.5422 19.4331 11.9465 19.4147 12.5681L18.9487 28.9366C18.9331 29.5509 19.3575 29.9681 20.0159 29.9681ZM8.305 7.18844L11.1887 7.18844L11.1887 3.94312C11.1887 3.13405 11.7547 2.61499 12.6247 2.61499L18.1537 2.61499C19.0237 2.61499 19.5897 3.13405 19.5897 3.94312L19.5897 7.18844L22.4734 7.18844L22.4734 3.79812C22.4734 1.40875 20.9484 0 18.3594 0L12.4191 0C9.83 0 8.305 1.40875 8.305 3.79812ZM1.3828 8.88842L29.434 8.88842C30.204 8.88842 30.804 8.27686 30.804 7.50686C30.804 6.74249 30.204 6.14375 29.434 6.14375L1.3828 6.14375C0.625622 6.14375 0 6.74249 0 7.50686C0 8.28967 0.625622 8.88842 1.3828 8.88842ZM8.22749 35.2581L22.5894 35.2581C24.9812 35.2581 26.5347 33.7937 26.6469 31.3991L27.7209 8.58873L24.8228 8.58873L23.7956 30.9337C23.7644 31.8712 23.1459 32.4937 22.255 32.4937L8.53624 32.4937C7.67092 32.4937 7.05248 31.8556 7.00842 30.9337L5.92998 8.58873L3.08312 8.58873L4.17 31.4119C4.285 33.8065 5.81 35.2581 8.22749 35.2581Z"/>
        </svg>
      `;
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteSmartGroup(group.id);
      });

      buttonContainer.appendChild(editBtn);
      buttonContainer.appendChild(deleteBtn);

      header.appendChild(titleContainer);
      header.appendChild(buttonContainer);

      // Info row
      const infoRow = document.createElement('div');
      infoRow.className = 'template-info';

      // Create rules preview
      let rulesText = '';
      if (patterns.length > 0) {
        const rulesList = patterns.map(p => p.value).join(', ');
        const maxLength = 80;
        rulesText = rulesList.length > maxLength
          ? rulesList.substring(0, maxLength) + '...'
          : rulesList;
      } else {
        rulesText = 'No rules defined';
      }

      infoRow.innerHTML = `
        <span><strong>${getMessage('matches') || 'Matches:'}</strong> ${rulesText}</span>
      `;

      wrapper.appendChild(header);
      wrapper.appendChild(infoRow);

      // Drag and drop for priority reordering
      let smartGroupDragPreview = null;

      wrapper.addEventListener('dragstart', (e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', group.id);
        wrapper.classList.add('dragging');

        // Create drag preview with pill styling
        smartGroupDragPreview = wrapper.cloneNode(true);
        smartGroupDragPreview.classList.add('drag-preview');
        smartGroupDragPreview.classList.remove('dragging');
        smartGroupDragPreview.style.position = 'fixed';
        smartGroupDragPreview.style.zIndex = '10001';
        smartGroupDragPreview.style.pointerEvents = 'none';
        smartGroupDragPreview.style.left = e.clientX + 'px';
        smartGroupDragPreview.style.top = e.clientY + 'px';
        smartGroupDragPreview.style.width = 'auto';
        smartGroupDragPreview.style.maxWidth = '300px';

        // Hide edit/delete buttons and info row in preview
        const actionButtons = smartGroupDragPreview.querySelectorAll('.template-delete-btn');
        actionButtons.forEach(btn => btn.style.display = 'none');
        const infoRow = smartGroupDragPreview.querySelector('.template-info');
        if (infoRow) infoRow.style.display = 'none';

        document.body.appendChild(smartGroupDragPreview);

        // Hide native drag ghost
        if (invisibleDragImageReady) {
          e.dataTransfer.setDragImage(invisibleDragImage, 0, 0);
        }
      });

      wrapper.addEventListener('drag', (e) => {
        if (smartGroupDragPreview && e.clientX !== 0 && e.clientY !== 0) {
          smartGroupDragPreview.style.left = e.clientX + 'px';
          smartGroupDragPreview.style.top = e.clientY + 'px';
        }
      });

      wrapper.addEventListener('dragend', () => {
        wrapper.classList.remove('dragging');
        if (smartGroupDragPreview) {
          smartGroupDragPreview.remove();
          smartGroupDragPreview = null;
        }
      });

      wrapper.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        wrapper.style.borderTop = '2px solid var(--info)';
      });

      wrapper.addEventListener('dragleave', () => {
        wrapper.style.borderTop = 'none';
      });

      wrapper.addEventListener('drop', (e) => {
        e.preventDefault();
        wrapper.style.borderTop = 'none';

        const draggedId = e.dataTransfer.getData('text/plain');
        const targetId = group.id;

        if (draggedId !== targetId) {
          reorderSmartGroups(draggedId, targetId);
        }
      });

      listContainer.appendChild(wrapper);
    });
  });
}

// Reorder Smart Groups priority
function reorderSmartGroups(draggedId, targetId) {
  chrome.storage.local.get(['smartGroups'], (result) => {
    const smartGroups = result.smartGroups || [];

    const draggedIndex = smartGroups.findIndex(g => g.id === draggedId);
    const targetIndex = smartGroups.findIndex(g => g.id === targetId);

    if (draggedIndex === -1 || targetIndex === -1) return;

    // Remove dragged item
    const [draggedItem] = smartGroups.splice(draggedIndex, 1);

    // Insert at new position
    smartGroups.splice(targetIndex, 0, draggedItem);

    // Update priorities
    smartGroups.forEach((group, index) => {
      group.priority = index;
    });

    chrome.storage.local.set({ smartGroups }, () => {
      renderSmartGroupsList();
    });
  });
}

// Toggle Smart Group pin status
function toggleSmartGroupPin(groupId) {
  chrome.storage.local.get(['smartGroups'], (result) => {
    const smartGroups = result.smartGroups || [];
    const group = smartGroups.find(g => g.id === groupId);

    if (group) {
      group.pinned = !group.pinned;

      chrome.storage.local.set({ smartGroups }, () => {
        renderSmartGroupsList();
        // Refresh session list to update display
        chrome.storage.local.get(['savedSessions'], (res) => {
          updateSessionList(res.savedSessions || []);
        });
      });
    }
  });
}

// Edit Smart Group
function editSmartGroup(group) {
  // Close Smart Groups modal
  const modal = document.getElementById('smartGroupsModal');
  if (modal) modal.style.display = 'none';

  // Open editor with full group data for editing
  currentEditingSmartGroup = { ...group };
  shouldReturnToSmartGroupsList = true; // Editing existing, return to list on cancel
  debug('editSmartGroup: set shouldReturnToSmartGroupsList to', shouldReturnToSmartGroupsList);
  openSmartGroupEditor();
}

// Delete Smart Group
function deleteSmartGroup(groupId) {
  if (!confirm(getMessage('smartGroupDeleteConfirm') || 'Delete this Filter? Tabs in this group will be converted to a regular session.')) {
    return;
  }

  chrome.storage.local.get(['smartGroups', 'savedSessions'], (result) => {
    const smartGroups = result.smartGroups || [];
    const savedSessions = result.savedSessions || [];
    const groupIndex = smartGroups.findIndex(g => g.id === groupId);

    if (groupIndex === -1) return;

    const group = smartGroups[groupIndex];

    // If group has tabs, convert to a regular session
    if (group.tabs && group.tabs.length > 0) {
      const newSession = {
        timestamp: group.timestamp || new Date().toISOString(),
        customName: group.name,
        tabs: group.tabs,
        locked: group.locked || false,
        color: group.color || null
      };
      savedSessions.unshift(newSession);
    }

    // Remove Smart Group
    smartGroups.splice(groupIndex, 1);

    // Update priorities
    smartGroups.forEach((g, index) => {
      g.priority = index;
    });

    chrome.storage.local.set({ smartGroups, savedSessions }, () => {
      renderSmartGroupsList();
      updateSessionList(savedSessions);
    });
  });
}

// Temporary storage for patterns and actions being edited
let currentEditingPatterns = [];
let currentEditingAction = {
  primaryAction: 'tabGroup', // 'tabGroup' or 'trash'
  sessionName: '',
  sessionProperties: [] // color, lock, pin
};

// Set up inline name editing for Smart Group
function setupSmartGroupNameEditing() {
  const nameDisplay = document.getElementById('smartGroupNameDisplay');
  if (!nameDisplay) return;

  // Remove any existing click handler
  nameDisplay.onclick = null;

  nameDisplay.addEventListener('click', (e) => {
    e.stopPropagation();

    const spanStyle = window.getComputedStyle(nameDisplay);
    const spanWidth = nameDisplay.offsetWidth;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'session-title-input';
    input.style.fontSize = spanStyle.fontSize;
    input.style.fontWeight = spanStyle.fontWeight;
    input.style.padding = spanStyle.padding;
    input.style.border = '1px solid var(--border-primary)';
    input.style.borderRadius = '6px 6px 0 0';
    input.style.borderBottom = 'none';
    input.style.backgroundColor = 'var(--bg-primary)';
    input.style.color = 'var(--text-primary)';
    input.style.minHeight = spanStyle.minHeight;
    input.style.display = 'flex';
    input.style.alignItems = 'center';
    input.value = nameDisplay.textContent;
    input.placeholder = getMessage('untitledFilter') || 'Describe this filter...';

    // Create invisible measurement element
    const measure = document.createElement('span');
    measure.style.visibility = 'hidden';
    measure.style.position = 'absolute';
    measure.style.whiteSpace = 'pre';
    measure.style.fontSize = spanStyle.fontSize;
    measure.style.fontFamily = spanStyle.fontFamily;
    measure.style.fontWeight = spanStyle.fontWeight;
    measure.style.lineHeight = spanStyle.lineHeight;
    measure.style.letterSpacing = spanStyle.letterSpacing;
    measure.style.top = '-9999px';
    measure.style.left = '-9999px';
    measure.textContent = input.value || input.placeholder;
    document.body.appendChild(measure);

    // Replace span with input
    if (!nameDisplay.parentNode) {
      document.body.removeChild(measure);
      return;
    }
    nameDisplay.parentNode.replaceChild(input, nameDisplay);
    input.focus();
    input.select();

    // Auto-resize input as user types
    const updateWidth = () => {
      measure.textContent = input.value || input.placeholder;
      const newWidth = Math.max(spanWidth, measure.offsetWidth + 20);
      input.style.width = newWidth + 'px';
    };

    input.addEventListener('input', updateWidth);
    updateWidth();

    const finishEditing = (save) => {
      const newName = input.value.trim();

      if (save && newName) {
        nameDisplay.textContent = newName;
        nameDisplay.classList.remove('placeholder-text');
      } else if (save && !newName) {
        // If user cleared the name, show placeholder
        nameDisplay.textContent = getMessage('untitledFilter') || 'Describe this filter...';
        nameDisplay.classList.add('placeholder-text');
      }

      if (input.parentNode) {
        input.parentNode.replaceChild(nameDisplay, input);
      }
      if (measure.parentNode) {
        document.body.removeChild(measure);
      }

      // Clear error if name was entered
      const nameError = document.getElementById('smartGroupNameError');
      if (nameError && newName) {
        nameError.style.display = 'none';
      }

      // Re-setup the click handler
      setupSmartGroupNameEditing();
    };

    input.addEventListener('blur', () => finishEditing(true));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        finishEditing(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        finishEditing(false);
      }
    });
  });
}

// Open Smart Group editor
function openSmartGroupEditor() {
  debug('openSmartGroupEditor called, shouldReturnToSmartGroupsList:', shouldReturnToSmartGroupsList);
  const modal = document.getElementById('smartGroupEditorModal');
  if (!modal) return;

  modal.style.display = 'flex';
  document.body.classList.add('modal-open');

  // Apply internationalization to modal elements
  if (typeof applyInternationalization === 'function') {
    applyInternationalization();
  }

  // Set title
  const title = document.getElementById('smartGroupEditorTitle');
  if (title) {
    title.textContent = currentEditingSmartGroup && currentEditingSmartGroup.id ? getMessage('editFilter') || 'Edit Filter' : getMessage('createFilter') || 'Create Filter';
  }

  // Initialize patterns array
  if (currentEditingSmartGroup && currentEditingSmartGroup.patterns) {
    currentEditingPatterns = [...currentEditingSmartGroup.patterns];
  } else {
    currentEditingPatterns = [];
  }

  // Initialize action
  if (currentEditingSmartGroup && currentEditingSmartGroup.action) {
    currentEditingAction = { ...currentEditingSmartGroup.action };
    // Ensure sessionProperties array exists
    if (!currentEditingAction.sessionProperties) {
      currentEditingAction.sessionProperties = [];
    }
  } else {
    currentEditingAction = {
      primaryAction: 'tabGroup',
      sessionName: '',
      sessionProperties: []
    };
  }

  // Populate fields if editing/copying
  const nameDisplay = document.getElementById('smartGroupNameDisplay');
  const nameError = document.getElementById('smartGroupNameError');
  const pinnedCheckbox = document.getElementById('smartGroupPinned');
  const autoPinCheckbox = document.getElementById('smartGroupAutoPin');
  const matchModeSelect = document.getElementById('smartGroupMatchModeSelect');

  if (nameError) nameError.style.display = 'none';

  if (currentEditingSmartGroup) {
    if (nameDisplay) {
      const name = currentEditingSmartGroup.name || getMessage('untitledFilter') || 'Describe this filter...';
      nameDisplay.textContent = name;
      // Add placeholder class if showing placeholder text
      if (!currentEditingSmartGroup.name) {
        nameDisplay.classList.add('placeholder-text');
      } else {
        nameDisplay.classList.remove('placeholder-text');
      }
    }
    if (pinnedCheckbox) pinnedCheckbox.checked = !!currentEditingSmartGroup.pinned;
    if (autoPinCheckbox) autoPinCheckbox.checked = !!currentEditingSmartGroup.autoPin;
    if (matchModeSelect) matchModeSelect.value = currentEditingSmartGroup.matchMode || 'any';
    // Set color if exists
    currentSmartGroupColor = currentEditingSmartGroup.color || null;
  } else {
    if (nameDisplay) {
      nameDisplay.textContent = getMessage('untitledFilter') || 'Describe this filter...';
      nameDisplay.classList.add('placeholder-text');
    }
    if (pinnedCheckbox) pinnedCheckbox.checked = false;
    if (autoPinCheckbox) autoPinCheckbox.checked = false;
    if (matchModeSelect) matchModeSelect.value = 'any';
    // Reset color for new group
    currentSmartGroupColor = null;
  }

  // Set up inline name editing
  setupSmartGroupNameEditing();

  // Clear new pattern inputs
  const newPatternType = document.getElementById('smartGroupNewPatternType');
  const newPatternValue = document.getElementById('smartGroupNewPatternValue');
  if (newPatternType) newPatternType.value = 'domain';
  if (newPatternValue) newPatternValue.value = '';

  // Render patterns list and actions list, update preview
  renderSmartGroupPatternsList();
  renderSmartGroupActionsList();
  updatePatternHelp();
  updatePatternPreview();
  checkNonMatchingTabs();

  // Pattern type change handler
  if (newPatternType) {
    newPatternType.onchange = () => {
      updatePatternHelp();
    };
  }

  // Match mode change handler
  if (matchModeSelect) {
    matchModeSelect.onchange = () => {
      updatePatternPreview();
      checkNonMatchingTabs();
    };
  }

  // Color picker handlers
  const smartGroupColorPicker = document.querySelector('.smart-group-color-picker');
  if (smartGroupColorPicker) {
    const colorDots = smartGroupColorPicker.querySelectorAll('.color-dot');

    // Remove old event listeners by cloning and replacing
    colorDots.forEach(dot => {
      const newDot = dot.cloneNode(true);
      dot.parentNode.replaceChild(newDot, dot);
    });

    // Re-query after replacement
    const freshColorDots = smartGroupColorPicker.querySelectorAll('.color-dot');
    freshColorDots.forEach(dot => {
      dot.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();

        const color = dot.dataset.color;

        // If custom color, open the color picker
        if (color === 'custom') {
          const colorInput = document.getElementById('smartGroupCustomColor');
          if (colorInput) {
            colorInput.click();
          }
          return;
        }

        // Set the color
        currentSmartGroupColor = color === 'none' ? null : color;

        // Update visual selection
        freshColorDots.forEach(d => d.style.borderColor = 'transparent');
        dot.style.borderColor = 'rgba(0, 0, 0, 0.4)';

        // Blur the button to remove focus and allow other interactions
        dot.blur();
      });
    });

    // Handle custom color input
    const customColorInput = document.getElementById('smartGroupCustomColor');
    if (customColorInput) {
      // Clone to remove old event listeners
      const newCustomInput = customColorInput.cloneNode(true);
      customColorInput.parentNode.replaceChild(newCustomInput, customColorInput);

      newCustomInput.addEventListener('change', (e) => {
        const hexColor = e.target.value;
        currentSmartGroupColor = hexColor;

        // Update visual selection
        freshColorDots.forEach(d => d.style.borderColor = 'transparent');
        const customDot = smartGroupColorPicker.querySelector('[data-color="custom"]');
        if (customDot) {
          customDot.style.borderColor = 'rgba(0, 0, 0, 0.4)';
        }
      });

      newCustomInput.addEventListener('click', (e) => {
        e.stopPropagation();
      });

      // Clear all border colors first to reset visual state
      freshColorDots.forEach(d => d.style.borderColor = 'transparent');

      // Set initial visual selection
      if (currentSmartGroupColor) {
        const selectedDot = currentSmartGroupColor.startsWith('#')
          ? smartGroupColorPicker.querySelector('[data-color="custom"]')
          : smartGroupColorPicker.querySelector(`[data-color="${currentSmartGroupColor}"]`);
        if (selectedDot) {
          selectedDot.style.borderColor = 'rgba(0, 0, 0, 0.4)';
        }
        // Set custom color input value if it's a hex color
        if (currentSmartGroupColor.startsWith('#')) {
          newCustomInput.value = currentSmartGroupColor;
        }
      }
    }
  }

  // Add pattern button handler
  const addPatternBtn = document.getElementById('smartGroupAddPatternBtn');
  if (addPatternBtn) {
    addPatternBtn.onclick = () => addSmartGroupPattern();
  }

  // Add pattern on Enter key
  if (newPatternValue) {
    newPatternValue.onkeypress = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addSmartGroupPattern();
      }
    };
  }

  // Save button handler
  const saveBtn = document.getElementById('smartGroupSaveBtn');
  if (saveBtn) {
    saveBtn.onclick = () => saveSmartGroup();
  }

  // Cancel button handler - close editor and conditionally reopen Smart Groups list
  const cancelBtn = document.getElementById('smartGroupCancelBtn');
  if (cancelBtn) {
    cancelBtn.onclick = () => {
      debug('Cancel clicked, shouldReturnToSmartGroupsList:', shouldReturnToSmartGroupsList);
      modal.style.display = 'none';
      document.body.classList.remove('modal-open');
      currentEditingSmartGroup = null;
      currentEditingPatterns = [];
      currentEditingActions = [];

      // Save flag before reopening (because openSmartGroupsModal re-attaches handlers)
      const shouldReopen = shouldReturnToSmartGroupsList;
      shouldReturnToSmartGroupsList = false;

      // Reopen Smart Groups modal only if we came from there
      if (shouldReopen) {
        debug('Reopening Smart Groups modal');
        openSmartGroupsModal();
      } else {
        debug('Not reopening Smart Groups modal');
      }
    };
  }

  // Close button handler - close editor and conditionally reopen Smart Groups list
  const closeBtn = document.getElementById('smartGroupEditorClose');
  if (closeBtn) {
    closeBtn.onclick = () => {
      modal.style.display = 'none';
      document.body.classList.remove('modal-open');
      currentEditingSmartGroup = null;
      currentEditingPatterns = [];
      currentEditingActions = [];

      // Save flag before reopening (because openSmartGroupsModal re-attaches handlers)
      const shouldReopen = shouldReturnToSmartGroupsList;
      shouldReturnToSmartGroupsList = false;

      // Reopen Smart Groups modal only if we came from there
      if (shouldReopen) {
        openSmartGroupsModal();
      }
    };
  }

  // Close on overlay click - just close, don't reopen Smart Groups
  modal.onclick = (e) => {
    if (e.target === modal) {
      modal.style.display = 'none';
      currentEditingSmartGroup = null;
      currentEditingPatterns = [];
      currentEditingActions = [];
      document.body.classList.remove('modal-open');
    }
  };
}

// Render the patterns list in the editor (Apple Photos style)
function renderSmartGroupPatternsList() {
  const listContainer = document.getElementById('smartGroupPatternsList');
  if (!listContainer) return;

  listContainer.innerHTML = '';

  // Render existing patterns as editable rows
  currentEditingPatterns.forEach((pattern, index) => {
    const patternRow = createPatternRow(pattern, index, false);
    listContainer.appendChild(patternRow);
  });

  // Always add an empty row for adding new patterns
  const newPatternRow = createPatternRow({ type: 'domain', value: '' }, -1, true);
  listContainer.appendChild(newPatternRow);
}

// Create a single pattern row (Apple Photos style)
function createPatternRow(pattern, index, isNew) {
  const row = document.createElement('div');
  row.className = 'smart-group-pattern-row';
  row.style.cssText = 'display: flex; align-items: center; gap: 8px; padding: 10px 12px; background: var(--bg-primary); border-bottom: 1px solid var(--border-primary); border-left: 1px solid var(--border-primary); border-right: 1px solid var(--border-primary);';

  // First row should NOT have top border (connects to match row)
  if (index !== 0 || isNew) {
    row.style.borderTop = '0';
  }

  // Type dropdown
  const typeSelect = document.createElement('select');
  typeSelect.className = 'custom-select smart-group-pattern-type';
  typeSelect.style.cssText = 'flex: 0 0 90px; padding: 6px 24px 6px 8px; border: 1px solid var(--border-primary); border-radius: 4px; font-size: 13px; color: var(--text-primary);';
  typeSelect.innerHTML = `
    <option value="domain" ${pattern.type === 'domain' ? 'selected' : ''}>${getMessage('columnDomain') || 'Domain'}</option>
    <option value="keyword" ${pattern.type === 'keyword' ? 'selected' : ''}>${getMessage('smartGroupPatternTypeKeyword') || 'Keyword'}</option>
    <option value="regex" ${pattern.type === 'regex' ? 'selected' : ''}>${getMessage('smartGroupPatternTypeRegex') || 'Regex'}</option>
  `;

  // Value input
  const valueInput = document.createElement('input');
  valueInput.type = 'text';
  valueInput.className = 'smart-group-pattern-value';
  valueInput.value = pattern.value;
  valueInput.placeholder = getPlaceholderForType(pattern.type);
  valueInput.style.cssText = 'flex: 1; padding: 6px 10px; border: 1px solid var(--border-primary); border-radius: 4px; font-size: 13px; color: var(--text-primary);';

  // Update placeholder when type changes
  typeSelect.addEventListener('change', () => {
    valueInput.placeholder = getPlaceholderForType(typeSelect.value);
    if (!isNew) {
      currentEditingPatterns[index].type = typeSelect.value;
      updatePatternPreview();
      checkNonMatchingTabs();
    }
  });

  // Update pattern value on input
  if (!isNew) {
    valueInput.addEventListener('input', () => {
      currentEditingPatterns[index].value = valueInput.value.trim();
      updatePatternPreview();
      checkNonMatchingTabs();
    });
  }

  // Action buttons container
  const actionsContainer = document.createElement('div');
  actionsContainer.style.cssText = 'display: flex; align-items: center; gap: 0px;';

  if (isNew) {
    // Plus button for adding new pattern
    const addBtn = document.createElement('button');
    addBtn.className = 'smart-group-pattern-add-btn';
    addBtn.title = 'Add pattern';
    addBtn.innerHTML = `
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle cx="10" cy="10" r="9" stroke="currentColor" stroke-width="1.5"/>
        <path d="M10 6V14M6 10H14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
      </svg>
    `;
    addBtn.style.cssText = 'background: none; border: none; color: var(--text-tertiary); cursor: pointer; padding: 6px; border-radius: 6px; display: flex; align-items: center; justify-content: center; transition: background-color 0.15s ease, color 0.15s ease;';

    // Shared function to add pattern and focus next input
    const addPatternAndFocusNext = () => {
      const type = typeSelect.value;
      const value = valueInput.value.trim();

      if (!value) {
        alert(getMessage('pleaseEnterPattern') || 'Please enter a pattern value');
        return;
      }

      // Validate regex if type is regex
      if (type === 'regex') {
        try {
          new RegExp(value, 'i');
        } catch (e) {
          alert((getMessage('invalidRegexPrefix') || 'Invalid regular expression: ') + e.message);
          return;
        }
      }

      // Add pattern
      currentEditingPatterns.push({ type, value });

      // Re-render
      renderSmartGroupPatternsList();
      updatePatternPreview();
      checkNonMatchingTabs();

      // Focus on the new empty input row after re-render
      setTimeout(() => {
        const listContainer = document.getElementById('smartGroupPatternsList');
        if (listContainer) {
          const lastRow = listContainer.lastElementChild;
          if (lastRow) {
            const newInput = lastRow.querySelector('.smart-group-pattern-value');
            if (newInput) {
              newInput.focus();
            }
          }
        }
      }, 0);
    };

    // Add click handler for plus button
    addBtn.addEventListener('click', addPatternAndFocusNext);

    // Add Enter key handler for value input
    valueInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addPatternAndFocusNext();
      }
    });

    actionsContainer.appendChild(addBtn);
  } else {
    // Minus button for removing pattern
    const removeBtn = document.createElement('button');
    removeBtn.className = 'smart-group-pattern-remove-btn';
    removeBtn.title = 'Remove pattern';
    removeBtn.innerHTML = `
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle cx="10" cy="10" r="9" stroke="currentColor" stroke-width="1.5"/>
        <path d="M6 10H14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
      </svg>
    `;
    removeBtn.style.cssText = 'background: none; border: none; color: var(--text-tertiary); cursor: pointer; padding: 6px; border-radius: 6px; display: flex; align-items: center; justify-content: center; transition: background-color 0.15s ease, color 0.15s ease;';
    removeBtn.addEventListener('click', () => {
      currentEditingPatterns.splice(index, 1);
      renderSmartGroupPatternsList();
      updatePatternPreview();
      checkNonMatchingTabs();
    });

    actionsContainer.appendChild(removeBtn);
  }

  row.appendChild(typeSelect);
  row.appendChild(valueInput);
  row.appendChild(actionsContainer);

  return row;
}

// Helper function to get placeholder text for pattern type
function getPlaceholderForType(type) {
  const placeholders = {
    domain: 'apple.com',
    keyword: getMessage('smartGroupPatternTypeKeyword') || 'keyword',
    regex: '(apple|icloud)\\.com'
  };
  return placeholders[type] || '';
}

// Create a single action row (Apple Mail Rules style)
function createActionRow(action, index, isNew) {
  const row = document.createElement('div');
  row.className = 'smart-group-pattern-row';
  row.style.cssText = 'display: flex; align-items: center; gap: 8px; padding: 10px 12px; background: var(--bg-primary); border-bottom: 1px solid var(--border-primary); border-left: 1px solid var(--border-primary); border-right: 1px solid var(--border-primary);';

  // First row gets top border
  if (index === 0 && !isNew) {
    row.style.borderTop = '1px solid var(--border-primary)';
  } else {
    row.style.borderTop = '0';
  }

  // Action type dropdown
  const typeSelect = document.createElement('select');
  typeSelect.className = 'custom-select smart-group-action-type';
  typeSelect.style.cssText = 'flex: 0 0 140px; padding: 6px 24px 6px 8px; border: 1px solid var(--border-primary); border-radius: 4px; font-size: 13px; color: var(--text-primary);';

  // For the "new" row, find first available action type
  let selectedType = action.type;
  if (isNew) {
    const existingTypes = currentEditingActions.map(a => a.type);
    const availableTypes = ['color', 'lock', 'pin', 'trash'].filter(t => !existingTypes.includes(t));
    selectedType = availableTypes.length > 0 ? availableTypes[0] : 'color';
  }

  typeSelect.innerHTML = `
    <option value="color" ${selectedType === 'color' ? 'selected' : ''}>${getMessage('actionSetColor') || 'Set Color'}</option>
    <option value="lock" ${selectedType === 'lock' ? 'selected' : ''}>${getMessage('actionSetLockStatus') || 'Set Lock Status'}</option>
    <option value="pin" ${selectedType === 'pin' ? 'selected' : ''}>${getMessage('pinToTop') || 'Pin to Top'}</option>
    <option value="trash" ${selectedType === 'trash' ? 'selected' : ''}>${getMessage('actionSendToTrash') || 'Send to Trash'}</option>
  `;

  // Update action type to match the selected type for new row
  if (isNew) {
    action.type = selectedType;
  }

  // Value container (will hold different UI depending on action type)
  const valueContainer = document.createElement('div');
  valueContainer.style.cssText = 'flex: 1; display: flex; align-items: center; gap: 8px;';

  // Function to render the appropriate value UI based on action type
  const renderValueUI = (actionType) => {
    valueContainer.innerHTML = '';

    // Get current action value (important after type changes)
    const currentAction = isNew ? action : currentEditingActions[index];

    switch (actionType) {
      case 'color':
        // Create color picker (reusing existing color picker HTML)
        const colorPicker = createColorPickerForAction(currentAction, index, isNew);
        valueContainer.appendChild(colorPicker);
        break;

      case 'lock':
        const lockLabel = document.createElement('span');
        lockLabel.textContent = 'is';
        lockLabel.style.cssText = 'margin-right: 4px; font-size: 13px;';

        const lockSelect = document.createElement('select');
        lockSelect.className = 'custom-select';
        lockSelect.style.cssText = 'padding: 6px 24px 6px 8px; border: 1px solid var(--border-primary); border-radius: 4px; font-size: 13px; color: var(--text-primary);';
        lockSelect.innerHTML = `
          <option value="true" ${currentAction.value === true ? 'selected' : ''}>${getMessage('columnLock') || 'Locked'}</option>
          <option value="false" ${currentAction.value === false ? 'selected' : ''}>${getMessage('unlocked') || 'Unlocked'}</option>
        `;

        if (!isNew) {
          lockSelect.addEventListener('change', () => {
            currentEditingActions[index].value = lockSelect.value === 'true';
          });
        }

        valueContainer.appendChild(lockLabel);
        valueContainer.appendChild(lockSelect);
        break;

      case 'pin':
        const pinSelect = document.createElement('select');
        pinSelect.className = 'custom-select';
        pinSelect.style.cssText = 'padding: 6px 24px 6px 8px; border: 1px solid var(--border-primary); border-radius: 4px; font-size: 13px; color: var(--text-primary);';
        pinSelect.innerHTML = `
          <option value="true" ${currentAction.value === true ? 'selected' : ''}>${getMessage('yes') || 'Yes'}</option>
          <option value="false" ${currentAction.value === false ? 'selected' : ''}>${getMessage('no') || 'No'}</option>
        `;

        if (!isNew) {
          pinSelect.addEventListener('change', () => {
            currentEditingActions[index].value = pinSelect.value === 'true';
          });
        }

        valueContainer.appendChild(pinSelect);
        break;

      case 'trash':
        // No value needed for trash
        break;
    }
  };

  // Initial render
  renderValueUI(action.type);

  // Re-render value UI when action type changes
  typeSelect.addEventListener('change', () => {
    const newType = typeSelect.value;
    if (!isNew) {
      // Set default value for the new action type
      let defaultValue;
      switch (newType) {
        case 'color':
          defaultValue = 'none';
          break;
        case 'lock':
          defaultValue = false;
          break;
        case 'pin':
          defaultValue = true;
          break;
        case 'trash':
          defaultValue = undefined;
          break;
      }
      currentEditingActions[index] = { type: newType, value: defaultValue };
    }
    renderValueUI(newType);
  });

  // Action buttons container
  const actionsContainer = document.createElement('div');
  actionsContainer.style.cssText = 'display: flex; align-items: center; gap: 4px;';

  if (isNew) {
    // Plus button for adding new action
    const addBtn = document.createElement('button');
    addBtn.className = 'smart-group-pattern-add-btn';
    addBtn.title = 'Add action';
    addBtn.innerHTML = `
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle cx="10" cy="10" r="9" stroke="currentColor" stroke-width="1.5"/>
        <path d="M10 6V14M6 10H14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
      </svg>
    `;
    addBtn.style.cssText = 'background: none; border: none; color: var(--text-tertiary); cursor: pointer; padding: 6px; border-radius: 6px; display: flex; align-items: center; justify-content: center; transition: background-color 0.15s ease, color 0.15s ease;';

    addBtn.addEventListener('click', () => {
      const type = typeSelect.value;
      let value;

      // Get value based on action type
      switch (type) {
        case 'color':
          value = 'none'; // Will be set by color picker
          break;
        case 'lock':
          const lockSel = valueContainer.querySelector('select');
          value = lockSel ? lockSel.value === 'true' : false;
          break;
        case 'pin':
          const pinSel = valueContainer.querySelector('select');
          value = pinSel ? pinSel.value === 'true' : true;
          break;
        case 'trash':
          value = undefined;
          break;
      }

      // Check for duplicates
      const duplicate = currentEditingActions.find(a => a.type === type);
      if (duplicate) {
        alert(`An action of type "${type}" already exists.`);
        return;
      }

      // Add action
      currentEditingActions.push({ type, value });

      // Re-render
      renderSmartGroupActionsList();
    });

    actionsContainer.appendChild(addBtn);
  } else {
    // Minus button for removing action
    const removeBtn = document.createElement('button');
    removeBtn.className = 'smart-group-pattern-remove-btn';
    removeBtn.title = 'Remove action';
    removeBtn.innerHTML = `
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle cx="10" cy="10" r="9" stroke="currentColor" stroke-width="1.5"/>
        <path d="M6 10H14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
      </svg>
    `;
    removeBtn.style.cssText = 'background: none; border: none; color: var(--text-tertiary); cursor: pointer; padding: 6px; border-radius: 6px; display: flex; align-items: center; justify-content: center; transition: background-color 0.15s ease, color 0.15s ease;';
    removeBtn.addEventListener('click', () => {
      currentEditingActions.splice(index, 1);
      renderSmartGroupActionsList();
    });

    actionsContainer.appendChild(removeBtn);
  }

  row.appendChild(typeSelect);
  row.appendChild(valueContainer);
  row.appendChild(actionsContainer);

  return row;
}

// Create color picker UI for action row
function createColorPickerForAction(action, index, isNew) {
  const colorPicker = document.createElement('div');
  colorPicker.style.cssText = 'display: flex; gap: 6px; align-items: center;';

  const colors = [
    { name: 'none', color: null, icon: true },
    { name: 'blue', color: '#007AFF' },
    { name: 'green', color: '#53b559' },
    { name: 'yellow', color: '#ffc400' },
    { name: 'orange', color: '#fa6a22' },
    { name: 'red', color: '#FF0000' },
    { name: 'pink', color: '#ff66ad' },
    { name: 'purple', color: '#924ff6' },
    { name: 'custom', color: null, custom: true }
  ];

  // First, create all buttons
  const buttons = colors.map(({ name, color, icon, custom }) => {
    const btn = document.createElement('button');
    btn.className = 'color-dot';
    if (custom) btn.classList.add('color-dot-custom');
    btn.dataset.color = name;
    btn.title = name.charAt(0).toUpperCase() + name.slice(1);

    if (icon) {
      // None button
      btn.classList.add('color-dot-none');
    } else if (custom) {
      // Custom color button
      btn.style.position = 'relative';
      const input = document.createElement('input');
      input.type = 'color';
      input.style.cssText = 'position: absolute; width: 100%; height: 100%; opacity: 0; cursor: pointer; border: none; padding: 0; margin: 0;';

      if (!isNew && action.value && action.value.startsWith('#')) {
        input.value = action.value;
      }

      input.addEventListener('change', () => {
        if (!isNew) {
          currentEditingActions[index].value = input.value;
          // Update selection visual directly
          buttons.forEach(d => d.classList.remove('selected'));
          btn.classList.add('selected');
        }
      });

      btn.appendChild(input);
    } else {
      // Regular color button
      btn.style.backgroundColor = color;
    }

    // Mark selected
    if (action.value === name || action.value === color) {
      btn.classList.add('selected');
    }

    return { btn, name, custom };
  });

  // Now add click handlers with access to all buttons
  buttons.forEach(({ btn, name, custom }) => {
    btn.addEventListener('click', (e) => {
      if (custom) return; // Let the input handle it
      e.preventDefault();

      if (!isNew) {
        // Existing action - update value
        currentEditingActions[index].value = name;

        // Remove selected from all buttons
        buttons.forEach(({ btn: b }) => b.classList.remove('selected'));
        // Add selected to clicked button
        btn.classList.add('selected');
      } else {
        // New action row - check if color action already exists
        const existingColorIndex = currentEditingActions.findIndex(a => a.type === 'color');
        if (existingColorIndex >= 0) {
          // Update existing color action
          currentEditingActions[existingColorIndex].value = name;
        } else {
          // Add new color action
          currentEditingActions.push({ type: 'color', value: name });
        }
        renderSmartGroupActionsList();
      }
    });

    colorPicker.appendChild(btn);
  });

  return colorPicker;
}

// Create color picker for session property
function createColorPickerForProperty(property, index) {
  const colorPicker = document.createElement('div');
  colorPicker.style.cssText = 'display: flex; gap: 6px; align-items: center; margin-left: 12px;';

  const colors = [
    { name: 'none', color: null, icon: true },
    { name: 'blue', color: '#007AFF' },
    { name: 'green', color: '#53b559' },
    { name: 'yellow', color: '#ffc400' },
    { name: 'orange', color: '#fa6a22' },
    { name: 'red', color: '#FF0000' },
    { name: 'pink', color: '#ff66ad' },
    { name: 'purple', color: '#924ff6' },
    { name: 'custom', color: null, custom: true }
  ];

  const buttons = colors.map(({ name, color, icon, custom }) => {
    const btn = document.createElement('button');
    btn.className = 'color-dot';
    if (custom) btn.classList.add('color-dot-custom');
    btn.dataset.color = name;
    btn.title = name.charAt(0).toUpperCase() + name.slice(1);

    if (icon) {
      btn.classList.add('color-dot-none');
    } else if (custom) {
      btn.style.position = 'relative';
      const input = document.createElement('input');
      input.type = 'color';
      input.style.cssText = 'position: absolute; width: 100%; height: 100%; opacity: 0; cursor: pointer; border: none; padding: 0; margin: 0;';

      if (property.value && property.value.startsWith('#')) {
        input.value = property.value;
      }

      input.addEventListener('change', () => {
        property.value = input.value;
        buttons.forEach(({ btn: b }) => b.classList.remove('selected'));
        btn.classList.add('selected');
      });

      btn.appendChild(input);
    } else {
      btn.style.backgroundColor = color;
    }

    // Mark selected
    if (property.value === name || property.value === color) {
      btn.classList.add('selected');
    }

    return { btn, name, custom };
  });

  // Add click handlers
  buttons.forEach(({ btn, name, custom }) => {
    btn.addEventListener('click', (e) => {
      if (custom) return;
      e.preventDefault();

      property.value = name;
      buttons.forEach(({ btn: b }) => b.classList.remove('selected'));
      btn.classList.add('selected');
    });

    colorPicker.appendChild(btn);
  });

  return colorPicker;
}

// Create the primary action row (Send to Tab Group or Send to Trash)
function createPrimaryActionRow() {
  const row = document.createElement('div');
  row.className = 'smart-group-pattern-row';
  row.style.cssText = 'display: flex; align-items: center; gap: 8px; padding: 10px 12px; background: var(--bg-primary); border: 1px solid var(--border-primary);';

  // Action type dropdown
  const typeSelect = document.createElement('select');
  typeSelect.className = 'custom-select';
  typeSelect.style.cssText = 'flex: 0 0 auto; padding: 6px 24px 6px 8px; border: 1px solid var(--border-primary); border-radius: 4px; font-size: 13px; color: var(--text-primary);';
  typeSelect.innerHTML = `
    <option value="tabGroup" ${currentEditingAction.primaryAction === 'tabGroup' ? 'selected' : ''}>${getMessage('actionSendToTabGroup') || 'Send to Tab Group'}</option>
    <option value="trash" ${currentEditingAction.primaryAction === 'trash' ? 'selected' : ''}>${getMessage('actionSendToTrash') || 'Send to Trash'}</option>
  `;

  // Value container
  const valueContainer = document.createElement('div');
  valueContainer.style.cssText = 'flex: 1; display: flex; align-items: center; gap: 8px;';

  const renderValue = () => {
    valueContainer.innerHTML = '';
    if (currentEditingAction.primaryAction === 'tabGroup') {
      const input = document.createElement('input');
      input.type = 'text';
      input.placeholder = getMessage('actionSessionName') || 'Name';
      input.value = currentEditingAction.sessionName || '';
      input.style.cssText = 'flex: 1; padding: 6px 8px; border: 1px solid var(--border-primary); border-radius: 4px; font-size: 13px; color: var(--text-primary); background: var(--bg-primary);';
      input.addEventListener('input', () => {
        currentEditingAction.sessionName = input.value;
      });

      // Add Enter key handler to add first property
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          // Trigger the plus button if it exists and no properties are set
          if (currentEditingAction.sessionProperties.length === 0) {
            // Find first available property type
            const usedTypes = currentEditingAction.sessionProperties.map(p => p.type);
            const availableTypes = ['color', 'lock', 'pin'].filter(t => !usedTypes.includes(t));

            if (availableTypes.length > 0) {
              const newType = availableTypes[0];
              currentEditingAction.sessionProperties.push({
                type: newType,
                value: newType === 'color' ? 'none' : undefined
              });
              renderSmartGroupActionsList();
            }
          }
        }
      });

      valueContainer.appendChild(input);
    }
  };

  renderValue();

  typeSelect.addEventListener('change', () => {
    currentEditingAction.primaryAction = typeSelect.value;
    if (typeSelect.value === 'trash') {
      currentEditingAction.sessionName = '';
      currentEditingAction.sessionProperties = [];
    }
    renderValue();
    renderSmartGroupActionsList();
  });

  // Add plus button to add properties (only shown when tabGroup is selected and not all properties are added)
  const actionBtn = document.createElement('button');
  actionBtn.className = 'smart-group-pattern-add-btn';
  actionBtn.title = 'Add property';
  actionBtn.innerHTML = `
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="10" cy="10" r="9" stroke="currentColor" stroke-width="1.5"/>
      <path d="M10 6V14M6 10H14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    </svg>
  `;
  actionBtn.style.cssText = 'background: none; border: none; color: var(--text-tertiary); cursor: pointer; padding: 6px; border-radius: 6px; display: flex; align-items: center; justify-content: center;';
  actionBtn.addEventListener('click', () => {
    // Find first available property type
    const usedTypes = currentEditingAction.sessionProperties.map(p => p.type);
    const availableTypes = ['color', 'lock', 'pin'].filter(t => !usedTypes.includes(t));

    if (availableTypes.length === 0) {
      return; // All properties already added
    }

    const newType = availableTypes[0];
    currentEditingAction.sessionProperties.push({
      type: newType,
      value: newType === 'color' ? 'none' : undefined
    });
    renderSmartGroupActionsList();
  });

  // Only show the plus button when:
  // 1. Primary action is 'tabGroup'
  // 2. Not all 3 properties have been added
  const usedTypes = currentEditingAction.sessionProperties.map(p => p.type);
  const hasAvailableProperties = usedTypes.length < 3;
  const shouldShowPlus = currentEditingAction.primaryAction === 'tabGroup' && hasAvailableProperties;
  actionBtn.style.display = shouldShowPlus ? 'flex' : 'none';

  row.appendChild(typeSelect);
  row.appendChild(valueContainer);
  row.appendChild(actionBtn);

  return row;
}

// Create a session property row (Color, Lock, Pin)
function createPropertyRow(property, index, isLast) {
  const row = document.createElement('div');
  row.className = 'smart-group-pattern-row';
  row.style.cssText = 'display: flex; align-items: center; gap: 8px; padding: 10px 12px; background: var(--bg-primary); border-bottom: 1px solid var(--border-primary); border-left: 1px solid var(--border-primary); border-right: 1px solid var(--border-primary);';

  // Property type dropdown
  const typeSelect = document.createElement('select');
  typeSelect.className = 'custom-select';
  typeSelect.style.cssText = 'flex: 0 0 140px; padding: 6px 24px 6px 8px; border: 1px solid var(--border-primary); border-radius: 4px; font-size: 13px; color: var(--text-primary);';

  typeSelect.innerHTML = `
    <option value="color" ${property.type === 'color' ? 'selected' : ''}>${getMessage('actionSetColor') || 'Set Color'}</option>
    <option value="lock" ${property.type === 'lock' ? 'selected' : ''}>${getMessage('actionLockTabGroup') || 'Lock Tab Group'}</option>
    <option value="pin" ${property.type === 'pin' ? 'selected' : ''}>${getMessage('pinToTop') || 'Pin to Top'}</option>
  `;

  // Value container
  const valueContainer = document.createElement('div');
  valueContainer.style.cssText = 'flex: 1; display: flex; align-items: center; gap: 8px;';

  const renderValue = (type) => {
    valueContainer.innerHTML = '';

    if (type === 'color') {
      const colorPicker = createColorPickerForProperty(property, index);
      valueContainer.appendChild(colorPicker);
    }
    // Lock and Pin have no additional UI
  };

  renderValue(property.type);

  typeSelect.addEventListener('change', () => {
    const newType = typeSelect.value;
    property.type = newType;
    property.value = newType === 'color' ? 'none' : undefined;
    renderValue(newType);
  });

  // Plus and/or minus buttons
  const actionsContainer = document.createElement('div');
  actionsContainer.style.cssText = 'display: flex; align-items: center; gap: 4px;';

  // Always show minus button to remove this property
  const minusBtn = document.createElement('button');
  minusBtn.className = 'smart-group-pattern-remove-btn';
  minusBtn.title = 'Remove property';
  minusBtn.innerHTML = `
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="10" cy="10" r="9" stroke="currentColor" stroke-width="1.5"/>
      <path d="M6 10H14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    </svg>
  `;
  minusBtn.style.cssText = 'background: none; border: none; color: var(--text-tertiary); cursor: pointer; padding: 6px; border-radius: 6px; display: flex; align-items: center; justify-content: center;';
  minusBtn.addEventListener('click', () => {
    currentEditingAction.sessionProperties.splice(index, 1);
    renderSmartGroupActionsList();
  });
  actionsContainer.appendChild(minusBtn);

  // Show plus button only on the last row (if there are still types available)
  if (isLast) {
    const usedTypes = currentEditingAction.sessionProperties.map(p => p.type);
    const availableTypes = ['color', 'lock', 'pin'].filter(t => !usedTypes.includes(t));

    if (availableTypes.length > 0) {
      const plusBtn = document.createElement('button');
      plusBtn.className = 'smart-group-pattern-add-btn';
      plusBtn.title = 'Add property';
      plusBtn.innerHTML = `
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
          <circle cx="10" cy="10" r="9" stroke="currentColor" stroke-width="1.5"/>
          <path d="M10 6V14M6 10H14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
      `;
      plusBtn.style.cssText = 'background: none; border: none; color: var(--text-tertiary); cursor: pointer; padding: 6px; border-radius: 6px; display: flex; align-items: center; justify-content: center;';
      plusBtn.addEventListener('click', () => {
        const newType = availableTypes[0];
        currentEditingAction.sessionProperties.push({
          type: newType,
          value: newType === 'color' ? 'none' : undefined
        });
        renderSmartGroupActionsList();
      });
      actionsContainer.appendChild(plusBtn);
    }
  }

  row.appendChild(typeSelect);
  row.appendChild(valueContainer);
  row.appendChild(actionsContainer);

  return row;
}

// Render the actions list
function renderSmartGroupActionsList() {
  const listContainer = document.getElementById('smartGroupActionsList');
  if (!listContainer) return;

  listContainer.innerHTML = '';

  // Render primary action row
  const primaryRow = createPrimaryActionRow();
  listContainer.appendChild(primaryRow);

  // Render session property rows (only if primaryAction is 'tabGroup')
  if (currentEditingAction.primaryAction === 'tabGroup') {
    currentEditingAction.sessionProperties.forEach((prop, index) => {
      const isLast = index === currentEditingAction.sessionProperties.length - 1;
      const row = createPropertyRow(prop, index, isLast);
      listContainer.appendChild(row);
    });
  }

  // Add 'last-pattern-row' class to the actual last action row
  const allActionRows = listContainer.querySelectorAll('.smart-group-pattern-row');
  if (allActionRows.length > 0) {
    allActionRows[allActionRows.length - 1].classList.add('last-pattern-row');
  }
}

// Add a new pattern to the current Smart Group being edited
function addSmartGroupPattern() {
  const typeSelect = document.getElementById('smartGroupNewPatternType');
  const valueInput = document.getElementById('smartGroupNewPatternValue');

  if (!typeSelect || !valueInput) return;

  const type = typeSelect.value;
  const value = valueInput.value.trim();

  if (!value) {
    alert(getMessage('pleaseEnterPattern') || 'Please enter a pattern value');
    return;
  }

  // Validate regex if type is regex
  if (type === 'regex') {
    try {
      new RegExp(value, 'i');
    } catch (e) {
      alert((getMessage('invalidRegexPrefix') || 'Invalid regular expression: ') + e.message);
      return;
    }
  }

  // Add pattern
  currentEditingPatterns.push({ type, value });

  // Clear input
  valueInput.value = '';

  // Re-render and update preview
  renderSmartGroupPatternsList();
  updatePatternPreview();
  checkNonMatchingTabs();
}

// Remove a pattern from the current Smart Group being edited
function removeSmartGroupPattern(index) {
  currentEditingPatterns.splice(index, 1);
  renderSmartGroupPatternsList();
  updatePatternPreview();
  checkNonMatchingTabs();
}

// Update pattern help text based on selected type
function updatePatternHelp() {
  const patternTypeSelect = document.getElementById('smartGroupNewPatternType');
  const patternInput = document.getElementById('smartGroupNewPatternValue');
  const helpText = document.getElementById('smartGroupPatternHelp');

  if (!patternTypeSelect || !helpText) return;

  const type = patternTypeSelect.value;

  const helpMessages = {
    domain: 'Enter a domain name (e.g., apple.com). Matches exact domain and all subdomains.',
    keyword: 'Enter a keyword to search in URLs and page titles (e.g., "support"). Case-insensitive.',
    regex: 'Enter a regular expression pattern (e.g., (apple|icloud)\\.com). Matches against URL and title.'
  };

  const placeholders = {
    domain: 'apple.com',
    keyword: 'e.g., documentation',
    regex: 'e.g., (apple|icloud)\\.com'
  };

  helpText.textContent = helpMessages[type] || '';
  if (patternInput) patternInput.placeholder = placeholders[type] || '';
}

// Update pattern preview with live matching across all patterns
function updatePatternPreview() {
  const previewCount = document.getElementById('smartGroupPreviewCount');
  if (!previewCount) return;

  if (currentEditingPatterns.length === 0) {
    previewCount.textContent = '0 tabs';
    return;
  }

  // Get match mode
  const matchModeSelect = document.getElementById('smartGroupMatchModeSelect');
  const matchMode = matchModeSelect ? matchModeSelect.value : 'any';

  // Get all tabs from all sessions to test matching
  chrome.storage.local.get(['savedSessions'], (result) => {
    const sessions = result.savedSessions || [];
    const matchedTabs = new Set();

    sessions.forEach(session => {
      if (session.tabs && Array.isArray(session.tabs)) {
        session.tabs.forEach(tab => {
          if (tabMatchesPatterns(tab, currentEditingPatterns, matchMode)) {
            matchedTabs.add(tab.url); // Use URL as unique identifier
          }
        });
      }
    });

    const matchCount = matchedTabs.size;
    previewCount.textContent = `${matchCount} tab${matchCount !== 1 ? 's' : ''}`;
  });
}

// Helper function to test if tab matches pattern (client-side version)
function matchesPattern(tab, pattern, patternType) {
  const url = (tab.url || '').toLowerCase();
  const title = (tab.title || '').toLowerCase();
  const searchText = `${url} ${title}`;

  try {
    switch (patternType) {
      case 'domain': {
        let hostname = '';
        try {
          const urlObj = new URL(tab.url);
          hostname = urlObj.hostname.toLowerCase();
        } catch (e) {
          return false;
        }
        const patternLower = pattern.toLowerCase();
        return hostname === patternLower || hostname.endsWith('.' + patternLower);
      }

      case 'keyword': {
        const patternLower = pattern.toLowerCase();
        return searchText.includes(patternLower);
      }

      case 'regex': {
        const regex = new RegExp(pattern, 'i');
        return regex.test(searchText);
      }

      default:
        return false;
    }
  } catch (error) {
    return false;
  }
}

// Helper function to check if tab matches patterns array with match mode
function tabMatchesPatterns(tab, patterns, matchMode) {
  if (patterns.length === 0) return false;

  if (matchMode === 'all') {
    // ALL mode: Every pattern must match
    return patterns.every(pattern => matchesPattern(tab, pattern.value, pattern.type));
  } else {
    // ANY mode: At least one pattern must match (default)
    return patterns.some(pattern => matchesPattern(tab, pattern.value, pattern.type));
  }
}

// Check for tabs that no longer match when editing
function checkNonMatchingTabs() {
  // Only check when editing an existing Smart Group
  if (!currentEditingSmartGroup || !currentEditingSmartGroup.id) {
    // Hide warning for new groups
    const warning = document.getElementById('smartGroupNonMatchingWarning');
    if (warning) warning.style.display = 'none';
    return;
  }

  // Get current tabs in the group
  const groupTabs = currentEditingSmartGroup.tabs || [];
  if (groupTabs.length === 0) {
    // No tabs to check
    const warning = document.getElementById('smartGroupNonMatchingWarning');
    if (warning) warning.style.display = 'none';
    return;
  }

  // Get match mode
  const matchModeSelect = document.getElementById('smartGroupMatchModeSelect');
  const matchMode = matchModeSelect ? matchModeSelect.value : 'any';

  // Count non-matching tabs
  let nonMatchingCount = 0;
  groupTabs.forEach(tab => {
    if (!tabMatchesPatterns(tab, currentEditingPatterns, matchMode)) {
      nonMatchingCount++;
    }
  });

  // Show/hide warning
  const warning = document.getElementById('smartGroupNonMatchingWarning');
  const countSpan = document.getElementById('smartGroupNonMatchingCount');
  const nameSpan = document.getElementById('smartGroupNonMatchingName');

  if (warning && countSpan && nameSpan) {
    if (nonMatchingCount > 0) {
      countSpan.textContent = nonMatchingCount;
      nameSpan.textContent = currentEditingSmartGroup.name || 'Unnamed';
      warning.style.display = 'block';
    } else {
      warning.style.display = 'none';
    }
  }
}

// Save Smart Group
function saveSmartGroup() {
  const nameDisplay = document.getElementById('smartGroupNameDisplay');
  const nameError = document.getElementById('smartGroupNameError');

  if (!nameDisplay) return;

  const name = nameDisplay.textContent.trim();

  // Validation
  if (!name) {
    if (nameError) {
      nameError.textContent = 'Group name is required';
      nameError.style.display = 'block';
    }
    return;
  }

  // Check if there's a pattern value in the "new pattern" input field
  // If so, automatically add it before validating
  if (currentEditingPatterns.length === 0) {
    const patternsList = document.getElementById('smartGroupPatternsList');
    if (patternsList) {
      const lastRow = patternsList.lastElementChild;
      if (lastRow) {
        const typeSelect = lastRow.querySelector('.smart-group-pattern-type');
        const valueInput = lastRow.querySelector('.smart-group-pattern-value');

        if (typeSelect && valueInput && valueInput.value.trim()) {
          // There's a value in the new pattern input - add it automatically
          const type = typeSelect.value;
          const value = valueInput.value.trim();

          // Validate regex if needed
          if (type === 'regex') {
            try {
              new RegExp(value, 'i');
            } catch (e) {
              alert((getMessage('invalidRegexPrefix') || 'Invalid regular expression: ') + e.message);
              return;
            }
          }

          // Add the pattern
          currentEditingPatterns.push({ type, value });
          // Note: We don't re-render the UI here since we're about to save
        }
      }
    }
  }

  // Now validate - after potentially auto-adding the pattern
  if (currentEditingPatterns.length === 0) {
    alert(getMessage('atLeastOnePatternRequired') || 'At least one pattern is required');
    return;
  }

  // Get match mode
  const matchModeSelect = document.getElementById('smartGroupMatchModeSelect');
  const matchMode = matchModeSelect ? matchModeSelect.value : 'any';

  // Get pin state
  const pinnedCheckbox = document.getElementById('smartGroupPinned');
  const pinned = pinnedCheckbox ? pinnedCheckbox.checked : false;

  // Get auto-pin state
  const autoPinCheckbox = document.getElementById('smartGroupAutoPin');
  const autoPin = autoPinCheckbox ? autoPinCheckbox.checked : false;

  chrome.storage.local.get(['smartGroups', 'savedSessions'], (result) => {
    const smartGroups = result.smartGroups || [];
    const sessions = result.savedSessions || [];

    // Note: We allow duplicate Filter names since:
    // 1. Filters are identified by unique IDs
    // 2. Multiple filters can legitimately send tabs to the same session
    // 3. Users may want similar filter names for organization

    const now = Date.now();
    let nonMatchingTabs = [];

    if (currentEditingSmartGroup && currentEditingSmartGroup.id) {
      // Update existing Smart Group
      const group = smartGroups.find(g => g.id === currentEditingSmartGroup.id);
      if (group) {
        // Find tabs that no longer match
        const oldTabs = group.tabs || [];
        const matchingTabs = [];
        oldTabs.forEach(tab => {
          if (tabMatchesPatterns(tab, currentEditingPatterns, matchMode)) {
            matchingTabs.push(tab);
          } else {
            nonMatchingTabs.push(tab);
          }
        });

        // Update the group
        group.name = name;
        group.patterns = [...currentEditingPatterns];
        group.action = { ...currentEditingAction };
        group.matchMode = matchMode;
        group.tabs = matchingTabs;
        group.pinned = pinned;
        group.autoPin = autoPin;
        group.color = currentSmartGroupColor;

        // Create a new session with non-matching tabs if any
        if (nonMatchingTabs.length > 0) {
          const newSession = {
            timestamp: new Date().toISOString(),
            customName: (getMessage('removedFrom') || 'Removed from $1').replace('$1', name),
            tabs: nonMatchingTabs,
            locked: false
          };
          sessions.unshift(newSession);
        }
      }
    } else {
      // Create new Smart Group
      const newGroup = {
        id: now.toString(),
        name,
        patterns: [...currentEditingPatterns],
        action: { ...currentEditingAction },
        matchMode,
        priority: smartGroups.length,
        pinned: pinned,
        autoPin: autoPin,
        locked: false,
        color: currentSmartGroupColor,
        tabs: [],
        timestamp: new Date().toISOString(),
        createdAt: now
      };
      smartGroups.push(newGroup);
    }

    chrome.storage.local.set({ smartGroups, savedSessions: sessions }, () => {
      // Close editor
      const modal = document.getElementById('smartGroupEditorModal');
      if (modal) {
        modal.style.display = 'none';
        document.body.classList.remove('modal-open');
      }

      currentEditingSmartGroup = null;
      currentEditingPatterns = [];
      currentEditingActions = [];

      // Reopen Smart Groups modal
      openSmartGroupsModal();

      // Refresh session list if we created a session from removed tabs
      if (nonMatchingTabs.length > 0) {
        updateSessionList(sessions);
      }
    });
  });
}

// ===========================================
// Run Filters on Existing Sessions
// ===========================================

let runFiltersUndoTimeout = null;

function showRunFiltersConfirmation() {
  // Get count of unlocked sessions
  chrome.storage.local.get(['savedSessions', 'smartGroups'], (result) => {
    const sessions = result.savedSessions || [];
    const smartGroups = result.smartGroups || [];

    if (smartGroups.length === 0) {
      alert(getMessage('runFiltersNoFilters') || 'No filters defined. Create filters first.');
      return;
    }

    const unlocked = sessions.filter(s => !s.locked);
    if (unlocked.length === 0) {
      alert(getMessage('runFiltersNoSessions') || 'No unlocked sessions to process.');
      return;
    }

    const totalTabs = unlocked.reduce((sum, s) => sum + (s.tabs ? s.tabs.length : 0), 0);

    const message = getMessage('runFiltersConfirm') || `Will process ${unlocked.length} sessions with ${totalTabs} tabs. Proceed?`;
    const confirmText = message.replace('{sessions}', unlocked.length).replace('{tabs}', totalTabs);

    if (confirm(confirmText)) {
      // Run filters
      chrome.runtime.sendMessage({ action: 'runFiltersOnSessions' }, (response) => {
        if (!response || !response.success) {
          const error = response && response.error ? response.error : 'unknown';
          alert(`Failed to run filters: ${error}`);
        }
        // Success handling done via message listener
      });
    }
  });
}

function showRunFiltersUndo(stats) {
  // Clear any existing timeout
  if (runFiltersUndoTimeout) {
    clearTimeout(runFiltersUndoTimeout);
  }

  // Remove existing undo bubble if present
  const existing = document.querySelector('.undo-bubble[data-runfilters="true"]');
  if (existing) {
    existing.remove();
  }

  // Create undo bubble
  const bubble = document.createElement('div');
  bubble.className = 'undo-bubble show merge';
  bubble.dataset.runfilters = 'true';

  const textSpan = document.createElement('span');
  textSpan.className = 'undo-bubble-title';
  const message = getMessage('runFiltersSuccess') || `Processed ${stats.matchedCount} tabs`;
  textSpan.textContent = message.replace('{matched}', stats.matchedCount);

  const undoBtn = document.createElement('button');
  undoBtn.className = 'undo-bubble-btn';
  undoBtn.textContent = getMessage('undo') || 'Undo';
  undoBtn.setAttribute('aria-label', getMessage('undo') || 'Undo');

  bubble.addEventListener('click', (e) => {
    e.stopPropagation();
    undoRunFilters();
  });

  bubble.appendChild(textSpan);
  bubble.appendChild(undoBtn);

  undoContainer.appendChild(bubble);

  // Auto-hide after user's configured timeout
  runFiltersUndoTimeout = setTimeout(() => {
    bubble.classList.remove('show');
    setTimeout(() => bubble.remove(), 300);
  }, UNDO_TIMEOUT_MS);
}

function undoRunFilters() {
  // Clear timeout
  if (runFiltersUndoTimeout) {
    clearTimeout(runFiltersUndoTimeout);
  }

  // Remove undo bubble
  const bubble = document.querySelector('.undo-bubble[data-runfilters="true"]');
  if (bubble) {
    bubble.classList.remove('show');
    setTimeout(() => bubble.remove(), 300);
  }

  // Restore from snapshot
  chrome.storage.local.get(['undoRunFilters'], (result) => {
    const snapshot = result.undoRunFilters;
    if (!snapshot) {
      alert('Undo data expired or not available.');
      return;
    }

    // Check if expired
    if (Date.now() > snapshot.expiresAt) {
      alert('Undo period expired.');
      chrome.storage.local.remove(['undoRunFilters']);
      return;
    }

    // Restore sessions
    chrome.storage.local.set({ savedSessions: snapshot.sessions }, () => {
      chrome.storage.local.remove(['undoRunFilters']);
      loadSessions();
    });
  });
}
