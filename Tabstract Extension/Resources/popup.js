
const primaryButton = document.getElementById('primaryButton');
const homeTabLink = document.getElementById('homeTabLink');
const selectTabsLink = document.getElementById('selectTabsLink');
const snoozeLink = document.getElementById('snoozeLink');
const saveMoreBtn = document.getElementById('save-more-btn');
const saveDropdown = document.getElementById('save-dropdown');
const saveDropdownBackdrop = document.getElementById('save-dropdown-backdrop');

let originalButtonText = "";
let shiftDown = false;
let dropdownOpen = false;

// =============================
// Debug Logging Helper
// =============================

let DEBUG_MODE = false;

chrome.storage.local.get(['debugMode'], (result) => {
  DEBUG_MODE = !!result.debugMode;
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.debugMode) {
    DEBUG_MODE = !!changes.debugMode.newValue;
  }
});

function debug(...args) {
  if (!DEBUG_MODE) return;
  console.log('[Tabstract]', ...args);
  try {
    browser.runtime.sendNativeMessage("application.id", {
      action: "debugLog",
      level: "log",
      source: "popup",
      message: args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ').substring(0, 10000)
    }).catch(() => {});
  } catch (e) {}
}

// Capture and send a debug snapshot of this page's DOM, CSS, and state
function captureDebugSnapshot() {
  let cssText = '';
  for (const sheet of document.styleSheets) {
    try {
      for (const rule of sheet.cssRules) {
        cssText += rule.cssText + '\n';
      }
    } catch (e) {
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
        source: "popup",
        html: html,
        css: cssText,
        storage: storage,
        meta: meta
      }).catch(() => {});
    } catch (e) {}
  });
}

// Auto-snapshot after page load
setTimeout(() => {
  if (DEBUG_MODE) captureDebugSnapshot();
}, 2000);

// =============================
// Element Inspector (debug only)
// =============================

function inspectElement(selector) {
  const el = document.querySelector(selector);
  if (!el) return { error: `No element found for selector: ${selector}` };

  const computed = window.getComputedStyle(el);
  const computedStyles = {};
  for (let i = 0; i < computed.length; i++) {
    const prop = computed[i];
    computedStyles[prop] = computed.getPropertyValue(prop);
  }

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
  const ariaAttrs = {};
  for (const attr of el.attributes) {
    if (attr.name.startsWith('aria-') || attr.name === 'role') {
      ariaAttrs[attr.name] = attr.value;
    }
  }
  if (Object.keys(ariaAttrs).length > 0) state.aria = ariaAttrs;

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

let _elementInspectorInterval = null;
function startElementInspectorPolling() {
  if (_elementInspectorInterval) return;
  _elementInspectorInterval = setInterval(() => {
    if (!DEBUG_MODE) return;
    browser.runtime.sendNativeMessage("application.id", {
      action: "checkElementInspectorRequest",
      source: "popup"
    }).then((response) => {
      if (response && response.found && response.selector) {
        const result = inspectElement(response.selector);
        result.source = "popup";
        result.timestamp = new Date().toISOString();
        browser.runtime.sendNativeMessage("application.id", {
          action: "elementInspectorResult",
          source: "popup",
          ...result
        }).catch(() => {});
      }
    }).catch(() => {});
  }, 3000);
}

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

// Listen for snapshot requests from background
chrome.runtime.onMessage.addListener((message) => {
  if (message.action === "captureDebugSnapshot") {
    if (DEBUG_MODE) captureDebugSnapshot();
  }
});

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
  }
};

document.addEventListener('DOMContentLoaded', () => {
    applyDarkModeSetting();

    // Trigger iCloud sync pull on popup open for fresh data
    try { chrome.runtime.sendMessage({ action: "syncPullIfEnabled" }); } catch (e) {}

    // Check for due template schedules whenever popup opens
    chrome.runtime.sendMessage({ action: 'checkSchedulesNow' });

    // ---------------------------------------
    // Check current snooze state and update the "Snooze" link label.
    // ---------------------------------------
    chrome.storage.local.get(["badgeSnoozeUntil"], (res) => {
      const now = Date.now();
      const snoozeUntil = res.badgeSnoozeUntil || 0;

      // The <span> inside #snoozeLink is what we swap text on
      const snoozeSpan = snoozeLink.querySelector("span");

      if (snoozeUntil > now) {
        // Currently snoozed → show "Unsnooze"
        if (snoozeSpan) {
          snoozeSpan.textContent = getMessage("unsnooze") || "Unsnooze";
        }
        snoozeLink.dataset.snoozed = "true";
      } else {
        // Not snoozed → show "Snooze"
        if (snoozeSpan) {
          snoozeSpan.textContent = getMessage("navSnooze") || "Snooze";
        }
        snoozeLink.dataset.snoozed = "false";
      }
    });

  // ---------------------------------------
  // Check oneclickSave first
  // ---------------------------------------
  chrome.storage.local.get(["oneclickSave", "popupBehavior", "pinnedTabs"], (ocRes) => {
    if (ocRes.oneclickSave) {
      // If oneclickSave is true, we skip showing the UI and do an immediate save.
      // Body stays hidden (visibility: hidden in CSS)
      const skipPinned = !!ocRes.pinnedTabs;
      chrome.tabs.query({ currentWindow: true }, (tabs) => {
        const validTabs = tabs.filter(tab => {
          if (!tab.url) return false;
          if (tab.url.startsWith("safari-web-extension://")) return false;
          if (tab.url.startsWith("favorites://")) return false;
          if (tab.url === "about:blank") return false;
          if (skipPinned && tab.pinned) return false;
          return true;
        });

        if (!validTabs || validTabs.length === 0) {
          window.close();
          return;
        }

        // Respect popupBehavior: either saveAndClose or saveOnly
        if (ocRes.popupBehavior === "saveAndClose") {
          chrome.runtime.sendMessage({ action: "saveAndClose" });
        } else {
          chrome.runtime.sendMessage({ action: "saveTabs" });
        }
        window.close();
      });
      return;
    }

    // ------------------------------------------------------------
    // If oneclickSave is false, show the popup UI.
    // ------------------------------------------------------------
    document.body.style.visibility = 'visible';
      
    // Update button label and disabled state based on the number of open (non-pinned) tabs.
    const selectTabsLink = document.getElementById('selectTabsLink');
    chrome.storage.local.get('pinnedTabs', (settings) => {
      const skipPinned = !!settings.pinnedTabs;
      chrome.tabs.query({ currentWindow: true }, (tabs) => {
        const validTabs = tabs.filter(tab => {
          if (!tab.url) return false;
          if (tab.url.startsWith("safari-web-extension://")) return false;
          if (tab.url.startsWith("favorites://")) return false;
          if (tab.url === "about:blank") return false;
          if (skipPinned && tab.pinned) return false;
          return true;
        });
        if (validTabs.length === 0) {
          primaryButton.textContent = getMessage("noAvailableTabs");
          primaryButton.disabled = true;
          selectTabsLink.classList.add('disabled');
        } else if (validTabs.length === 1) {
          primaryButton.textContent = getMessage("saveTab");
          primaryButton.disabled = false;
          selectTabsLink.classList.remove('disabled');
        } else {
          primaryButton.textContent = getMessage("saveTabs");
          primaryButton.disabled = false;
          selectTabsLink.classList.remove('disabled');
        }
        originalButtonText = primaryButton.textContent;
      });
    });

    // Global shift key detection that updates the button text regardless of hover.
    document.addEventListener('keydown', (e) => {
      if (e.key === "Shift" && !primaryButton.disabled) {
        shiftDown = true;
        primaryButton.textContent = getMessage("saveTab");
      }
    });

    document.addEventListener('keyup', (e) => {
      if (e.key === "Shift" && !primaryButton.disabled) {
        shiftDown = false;
        primaryButton.textContent = originalButtonText;
      }
    });
      
    // The button's action is determined by user settings.
    primaryButton.addEventListener('click', (e) => {
      if (!primaryButton.disabled && e.shiftKey) {
        // Shift+click behavior: change text to "Save Tab" and send save-active-tab message.
        primaryButton.textContent = getMessage("saveTab");
        chrome.runtime.sendMessage({ action: "save-active-tab" });
        window.close();
        return;
      }

      chrome.storage.local.get(["popupBehavior"], (result) => {
        const mode = result.popupBehavior || "saveAndClose";
        if (mode === "saveOnly") {
          chrome.runtime.sendMessage({ action: "saveTabs" });
        } else {
          chrome.runtime.sendMessage({ action: "saveAndClose" });
        }
        window.close();
      });
    });

    // Helper function: search the current window for any tab that's list.html or settings.html.
    // If one is found, update its URL to the target page and activate it.
    // Otherwise, open a new tab.
    function openOrFocus(relativeUrl) {
      const targetUrl = chrome.runtime.getURL(relativeUrl);
      const candidateUrls = [
        chrome.runtime.getURL("list.html"),
        chrome.runtime.getURL("settings.html"),
        chrome.runtime.getURL("help.html")
      ];
      chrome.tabs.query({ currentWindow: true }, (tabs) => {
        const candidate = tabs.find(tab => candidateUrls.includes(tab.url));
        if (candidate) {
          chrome.tabs.update(candidate.id, { url: targetUrl, active: true }, () => {
            window.close();
          });
        } else {
          chrome.tabs.create({ url: targetUrl }, () => {
            window.close();
          });
        }
      });
    }

    // HomeTab icon -> open or focus list.html in the current window.
    homeTabLink.addEventListener('click', (e) => {
      e.preventDefault();
      openOrFocus("list.html");
    });

    // Wire up split-button dropdown
    saveMoreBtn.addEventListener('click', toggleSaveDropdown);
    saveDropdownBackdrop.addEventListener('click', closeSaveDropdown);
    saveDropdown.querySelectorAll('.save-dropdown-item').forEach(item => {
      item.addEventListener('click', () => {
        handleDropdownAction(item.dataset.scope);
      });
    });

    // Close-on-save toggle writes the same setting Settings exposes,
    // and leaves the dropdown open so the user can then pick a scope.
    const closeAfterSaveToggle = document.getElementById('closeAfterSaveToggle');
    if (closeAfterSaveToggle) {
      closeAfterSaveToggle.addEventListener('change', () => {
        chrome.storage.local.set({
          popupBehavior: closeAfterSaveToggle.checked ? 'saveAndClose' : 'saveOnly'
        });
      });
    }

    // Close dropdown on Escape
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && dropdownOpen) {
        closeSaveDropdown();
      }
    });

    // Select Tabs icon -> open tab selection mode
    selectTabsLink.addEventListener('click', (e) => {
      e.preventDefault();
      if (!selectTabsLink.classList.contains('disabled')) {
        showTabSelectionMode();
      }
    });

    // Snooze icon -> use the user's chosen hours.
    snoozeLink.addEventListener('click', (e) => {
      e.preventDefault();

      if (snoozeLink.dataset.snoozed === "true") {
        // Unsnooze: clear badgeSnoozeUntil and refresh badge
        chrome.storage.local.set({ badgeSnoozeUntil: 0 }, () => {
          chrome.runtime.sendMessage({ action: "refreshBadge" });
          window.close();
        });
      } else {
        // Snooze: grab user's chosen hours (default 24), then set snooze
        chrome.storage.local.get(["snoozeHours"], (res) => {
          const hours = res.snoozeHours || 24;
          chrome.runtime.sendMessage({ action: "snoozeBadge", hours });
          window.close();
        });
      }
    });
  });
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
  });
}

// ================================================
// SAVE DROPDOWN
// ================================================

function openSaveDropdown() {
  // Reflect the current close-on-save preference in the toggle
  chrome.storage.local.get(['pinnedTabs', 'popupBehavior'], (settings) => {
    const closeToggle = document.getElementById('closeAfterSaveToggle');
    if (closeToggle) {
      closeToggle.checked = (settings.popupBehavior || 'saveAndClose') === 'saveAndClose';
    }
    // Hide "Save All Tabs" when only one tab is open
    const skipPinned = !!settings.pinnedTabs;
    chrome.tabs.query({ currentWindow: true }, (tabs) => {
      const validCount = tabs.filter(tab => {
        if (!tab.url) return false;
        if (tab.url.startsWith('safari-web-extension://')) return false;
        if (tab.url.startsWith('favorites://')) return false;
        if (tab.url === 'about:blank') return false;
        if (skipPinned && tab.pinned) return false;
        return true;
      }).length;
      // With a single tab the primary button already covers both save
      // actions, so the menu collapses to just the close-on-save toggle.
      const singleTab = validCount <= 1;
      saveDropdown.querySelectorAll('.save-dropdown-item').forEach(item => {
        item.style.display = singleTab ? 'none' : '';
      });
      const toggleRow = saveDropdown.querySelector('.save-dropdown-toggle');
      if (toggleRow) {
        toggleRow.classList.toggle('only-row', singleTab);
      }
      const toggleLabel = document.getElementById('closeAfterSaveLabel');
      if (toggleLabel) {
        toggleLabel.textContent = getMessage(
          singleTab ? 'saveAlsoClosesLabelSingular' : 'saveAlsoClosesLabel'
        );
      }
    });
  });
  saveDropdown.style.display = '';
  saveDropdownBackdrop.style.display = '';
  saveMoreBtn.classList.add('open');
  saveMoreBtn.setAttribute('aria-expanded', 'true');
  dropdownOpen = true;
}

function closeSaveDropdown() {
  saveDropdown.style.display = 'none';
  saveDropdownBackdrop.style.display = 'none';
  saveMoreBtn.classList.remove('open');
  saveMoreBtn.setAttribute('aria-expanded', 'false');
  dropdownOpen = false;
}

function toggleSaveDropdown() {
  if (dropdownOpen) {
    closeSaveDropdown();
  } else {
    openSaveDropdown();
  }
}

// Map a menu scope ("tab" | "all") to a background action, using the
// close-on-save preference the dropdown's toggle writes.
function handleDropdownAction(scope) {
  chrome.storage.local.get('popupBehavior', (res) => {
    const closes = (res.popupBehavior || 'saveAndClose') === 'saveAndClose';
    let action;
    if (scope === 'all') {
      action = closes ? 'saveAndClose' : 'saveTabsNoClose';
    } else {
      action = closes ? 'saveActiveTabAndClose' : 'saveActiveTabNoClose';
    }
    closeSaveDropdown();
    chrome.runtime.sendMessage({ action: action });
    window.close();
  });
}

// ================================================
// TAB SELECTION MODE
// ================================================

let allTabs = []; // Store tabs for selection mode

function showTabSelectionMode() {
  // Expand the popup and show selection UI
  document.body.classList.add('popup-expanded');
  const tabSelectionView = document.getElementById('tabSelectionView');
  tabSelectionView.style.display = 'flex';

  // Query tabs and render the selection list
  chrome.storage.local.get(['pinnedTabs', 'saveAllWindows'], (settings) => {
    const skipPinned = !!settings.pinnedTabs;
    const saveAllWindows = !!settings.saveAllWindows;

    // Always query all tabs to show complete picture
    chrome.tabs.query({}, (allTabs) => {
      // Get current window ID to determine which tabs to pre-check
      chrome.windows.getCurrent((currentWindow) => {
        const currentWindowId = currentWindow.id;

        const validTabs = allTabs.filter(tab => {
          if (!tab.url) return false;
          if (tab.url.startsWith("safari-web-extension://")) return false;
          if (tab.url.startsWith("favorites://")) return false;
          if (tab.url === "about:blank") return false;
          if (skipPinned && tab.pinned) return false;
          return true;
        });

        allTabs = validTabs;
        renderTabList(validTabs, saveAllWindows, currentWindowId);
        setupTabSelectionHandlers();
        // Update global toggle state to match the initial checkbox state
        updateGlobalToggleState();
        updateWindowToggleStates();
      });
    });
  });
}

function renderTabList(tabs, saveAllWindows, currentWindowId) {
  const tabListContainer = document.getElementById('tabSelectionList');
  tabListContainer.innerHTML = '';

  if (tabs.length === 0) {
    tabListContainer.innerHTML = '<div style="padding: 20px; text-align: center; color: var(--text-secondary);">No tabs available to save</div>';
    return;
  }

  // Group tabs by window
  const tabsByWindow = {};
  tabs.forEach(tab => {
    if (!tabsByWindow[tab.windowId]) {
      tabsByWindow[tab.windowId] = [];
    }
    tabsByWindow[tab.windowId].push(tab);
  });

  const windowIds = Object.keys(tabsByWindow).sort((a, b) => parseInt(a) - parseInt(b));
  const hasMultipleWindows = windowIds.length > 1;

  let globalIndex = 0;

  windowIds.forEach((windowId, windowIndex) => {
    const windowTabs = tabsByWindow[windowId];

    // Add window header if there are multiple windows
    if (hasMultipleWindows) {
      const windowHeader = document.createElement('div');
      windowHeader.className = 'window-header';

      const windowToggleIcon = document.createElement('button');
      windowToggleIcon.type = 'button';
      windowToggleIcon.className = 'window-toggle-icon';
      windowToggleIcon.dataset.windowId = windowId;

      // Determine initial state based on settings and current window
      const isWindowChecked = saveAllWindows || (parseInt(windowId) === currentWindowId);
      windowToggleIcon.dataset.state = isWindowChecked ? 'all' : 'none';

      // SVG for filled state (all selected) and empty state (none selected)
      const iconFilledDisplay = isWindowChecked ? 'block' : 'none';
      const iconEmptyDisplay = isWindowChecked ? 'none' : 'block';

      windowToggleIcon.innerHTML = `
        <svg class="icon-filled" viewBox="0 0 28.6659 28.3319" style="display: ${iconFilledDisplay};">
          <path d="M0 8.23172L1.93438 8.23172L1.93438 4.70453C1.93438 2.90032 2.88094 1.97532 4.64203 1.97532L8.14766 1.97532L8.14766 0.0409374L4.60594 0.0409374C1.55828 0.0409374 0 1.57766 0 4.6086ZM9.9686 1.97532L18.3223 1.97532L18.3223 0.0409374L9.9686 0.0409374ZM26.3566 8.23172L28.2909 8.23172L28.2909 4.6086C28.2909 1.60297 26.7327 0.0409374 23.6802 0.0409374L20.1433 0.0409374L20.1433 1.97532L23.6489 1.97532C25.375 1.97532 26.3566 2.90032 26.3566 4.70453ZM26.3566 18.325L28.2909 18.325L28.2909 10.0478L26.3566 10.0478ZM20.1433 28.3319L23.6802 28.3319C26.7327 28.3319 28.2909 26.7698 28.2909 23.7642L28.2909 20.1411L26.3566 20.1411L26.3566 23.6683C26.3566 25.4725 25.375 26.3975 23.6489 26.3975L20.1433 26.3975ZM9.9686 28.3319L18.3223 28.3319L18.3223 26.3975L9.9686 26.3975ZM4.60594 28.3319L8.14766 28.3319L8.14766 26.3975L4.64203 26.3975C2.88094 26.3975 1.93438 25.4725 1.93438 23.6683L1.93438 20.1411L0 20.1411L0 23.7642C0 26.7952 1.55828 28.3319 4.60594 28.3319ZM0 18.325L1.93438 18.325L1.93438 10.0478L0 10.0478Z"/>
          <path d="M5.60782 24.5561L22.7095 24.5561C23.9689 24.5561 24.5512 23.963 24.5512 22.682L24.5512 5.63422C24.5512 4.35329 23.9689 3.76016 22.7095 3.76016L5.60782 3.76016C4.33766 3.76016 3.75532 4.35329 3.75532 5.63422L3.75532 22.682C3.75532 23.963 4.33766 24.5561 5.60782 24.5561Z"/>
        </svg>
        <svg class="icon-empty" viewBox="0 0 28.6659 28.3319" style="display: ${iconEmptyDisplay};">
          <path d="M0 8.23172L1.93438 8.23172L1.93438 4.70453C1.93438 2.90032 2.88094 1.97532 4.64203 1.97532L8.14766 1.97532L8.14766 0.0409374L4.60594 0.0409374C1.55828 0.0409374 0 1.57766 0 4.6086ZM9.9686 1.97532L18.3223 1.97532L18.3223 0.0409374L9.9686 0.0409374ZM26.3566 8.23172L28.2909 8.23172L28.2909 4.6086C28.2909 1.60297 26.7327 0.0409374 23.6802 0.0409374L20.1433 0.0409374L20.1433 1.97532L23.6489 1.97532C25.375 1.97532 26.3566 2.90032 26.3566 4.70453ZM26.3566 18.325L28.2909 18.325L28.2909 10.0478L26.3566 10.0478ZM20.1433 28.3319L23.6802 28.3319C26.7327 28.3319 28.2909 26.7698 28.2909 23.7642L28.2909 20.1411L26.3566 20.1411L26.3566 23.6683C26.3566 25.4725 25.375 26.3975 23.6489 26.3975L20.1433 26.3975ZM9.9686 28.3319L18.3223 28.3319L18.3223 26.3975L9.9686 26.3975ZM4.60594 28.3319L8.14766 28.3319L8.14766 26.3975L4.64203 26.3975C2.88094 26.3975 1.93438 25.4725 1.93438 23.6683L1.93438 20.1411L0 20.1411L0 23.7642C0 26.7952 1.55828 28.3319 4.60594 28.3319ZM0 18.325L1.93438 18.325L1.93438 10.0478L0 10.0478Z"/>
        </svg>
      `;

      const windowTitle = document.createElement('span');
      windowTitle.className = 'window-title';
      // Convert window index to letter (0 -> A, 1 -> B, etc.)
      const windowLetter = String.fromCharCode(65 + windowIndex);
      const windowMsg = getMessage("tabGroupLetter");
      const windowTitleText = windowMsg ? windowMsg.replace('{letter}', windowLetter) : `Window ${windowLetter}`;
      windowTitle.textContent = windowTitleText;

      // Set aria-label with window information
      windowToggleIcon.setAttribute('aria-label', `Toggle all tabs in ${windowTitleText}`);

      // Window-specific toggle handler (shared function)
      const toggleWindowTabs = () => {
        const checkboxes = document.querySelectorAll(`.tab-item[data-window-id="${windowId}"] input[type="checkbox"]`);
        const currentState = windowToggleIcon.dataset.state;
        const iconFilled = windowToggleIcon.querySelector('.icon-filled');
        const iconEmpty = windowToggleIcon.querySelector('.icon-empty');

        if (currentState === 'all') {
          checkboxes.forEach(cb => cb.checked = false);
          windowToggleIcon.dataset.state = 'none';
          iconFilled.style.display = 'none';
          iconEmpty.style.display = 'block';
        } else {
          checkboxes.forEach(cb => cb.checked = true);
          windowToggleIcon.dataset.state = 'all';
          iconFilled.style.display = 'block';
          iconEmpty.style.display = 'none';
        }

        updateSaveButtonState();
        updateGlobalToggleState();
      };

      // Make button itself clickable for keyboard accessibility
      windowToggleIcon.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleWindowTabs();
      });

      // Make entire window header clickable as fallback
      windowHeader.addEventListener('click', toggleWindowTabs);

      windowHeader.appendChild(windowToggleIcon);
      windowHeader.appendChild(windowTitle);
      tabListContainer.appendChild(windowHeader);
    }

    // Render tabs for this window
    windowTabs.forEach((tab) => {
      const tabItem = document.createElement('div');
      tabItem.className = 'tab-item';
      tabItem.dataset.tabIndex = globalIndex;
      tabItem.dataset.windowId = windowId;

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      // Check box if saveAllWindows is true, OR if this tab is in the current window
      checkbox.checked = saveAllWindows || (tab.windowId === currentWindowId);
      checkbox.dataset.tabId = tab.id;
      checkbox.id = `tab-checkbox-${globalIndex}`;

      const favicon = document.createElement('img');
      favicon.className = 'tab-item-icon';
      // Use favicone.com service like list.js does
      try {
        const domain = new URL(tab.url).hostname;
        favicon.src = `https://favicone.com/${domain}?s=32`;
      } catch (e) {
        favicon.src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="%23ddd"/></svg>';
      }
      favicon.onerror = () => {
        favicon.style.display = 'none';
      };

      const titleSpan = document.createElement('span');
      titleSpan.className = 'tab-item-title';
      titleSpan.textContent = tab.title || tab.url;
      titleSpan.title = tab.title || tab.url; // Tooltip for full title

      // Create label element for accessibility
      const label = document.createElement('label');
      label.htmlFor = `tab-checkbox-${globalIndex}`;
      label.className = 'tab-item-label';
      label.appendChild(favicon);
      label.appendChild(titleSpan);

      // Click on the row toggles the checkbox (keep for UX but label handles accessibility)
      tabItem.addEventListener('click', (e) => {
        if (e.target !== checkbox && !label.contains(e.target)) {
          checkbox.checked = !checkbox.checked;
          updateSaveButtonState();
        }
      });

      // Checkbox change also updates button state
      checkbox.addEventListener('change', () => {
        updateSaveButtonState();
        updateGlobalToggleState();
        updateWindowToggleStates();
      });

      tabItem.appendChild(checkbox);
      tabItem.appendChild(label);
      tabListContainer.appendChild(tabItem);

      globalIndex++;
    });

    // Add spacing between windows if there are multiple
    if (hasMultipleWindows && windowIndex < windowIds.length - 1) {
      const spacer = document.createElement('div');
      spacer.className = 'window-spacer';
      tabListContainer.appendChild(spacer);
    }
  });

  updateSaveButtonState();
}

function setupTabSelectionHandlers() {
  // Clone and replace buttons to remove any existing event listeners
  const globalToggleBtn = document.getElementById('globalToggleBtn');
  const saveSelectedBtn = document.getElementById('saveSelectedBtn');
  const cancelSelectionBtn = document.getElementById('cancelSelectionBtn');

  const newGlobalToggleBtn = globalToggleBtn.cloneNode(true);
  const newSaveSelectedBtn = saveSelectedBtn.cloneNode(true);
  const newCancelSelectionBtn = cancelSelectionBtn.cloneNode(true);

  globalToggleBtn.parentNode.replaceChild(newGlobalToggleBtn, globalToggleBtn);
  saveSelectedBtn.parentNode.replaceChild(newSaveSelectedBtn, saveSelectedBtn);
  cancelSelectionBtn.parentNode.replaceChild(newCancelSelectionBtn, cancelSelectionBtn);

  // Global toggle button
  newGlobalToggleBtn.addEventListener('click', () => {
    const checkboxes = document.querySelectorAll('.tab-item input[type="checkbox"]');
    const currentState = newGlobalToggleBtn.dataset.state;

    if (currentState === 'all') {
      // Currently all selected, so deselect all
      checkboxes.forEach(cb => cb.checked = false);
      newGlobalToggleBtn.dataset.state = 'none';
      newGlobalToggleBtn.textContent = getMessage("selectAll") || "Select All";
    } else {
      // Currently some/none selected, so select all
      checkboxes.forEach(cb => cb.checked = true);
      newGlobalToggleBtn.dataset.state = 'all';
      newGlobalToggleBtn.textContent = getMessage("selectNone") || "Select None";
    }

    updateSaveButtonState();
    updateWindowToggleStates();
  });

  // Save Selected
  newSaveSelectedBtn.addEventListener('click', () => {
    const checkboxes = document.querySelectorAll('.tab-item input[type="checkbox"]:checked');
    const selectedTabIds = Array.from(checkboxes).map(cb => parseInt(cb.dataset.tabId));

    if (selectedTabIds.length === 0) {
      return; // Button should be disabled, but just in case
    }

    // Send selected tabs to background script
    chrome.runtime.sendMessage({
      action: "saveSelectedTabs",
      tabIds: selectedTabIds
    });
    window.close();
  });

  // Cancel
  newCancelSelectionBtn.addEventListener('click', () => {
    hideTabSelectionMode();
  });
}

function updateSaveButtonState() {
  const saveSelectedBtn = document.getElementById('saveSelectedBtn');
  const checkboxes = document.querySelectorAll('.tab-item input[type="checkbox"]:checked');
  const selectedCount = checkboxes.length;

  if (selectedCount === 0) {
    saveSelectedBtn.disabled = true;
    saveSelectedBtn.textContent = getMessage("saveSelected") || "Save Selected";
  } else {
    saveSelectedBtn.disabled = false;
    const countText = selectedCount === 1 ?
      getMessage("saveSelectedSingular") || `Save 1 Tab` :
      (getMessage("saveSelectedPlural") || `Save ${selectedCount} Tabs`).replace('{count}', selectedCount);
    saveSelectedBtn.textContent = countText;
  }
}

function hideTabSelectionMode() {
  document.body.classList.remove('popup-expanded');
  const tabSelectionView = document.getElementById('tabSelectionView');
  tabSelectionView.style.display = 'none';
  allTabs = [];
}

function updateGlobalToggleState() {
  const globalToggleBtn = document.getElementById('globalToggleBtn');
  if (!globalToggleBtn) return;

  const checkboxes = document.querySelectorAll('.tab-item input[type="checkbox"]');
  const checkedCount = document.querySelectorAll('.tab-item input[type="checkbox"]:checked').length;

  if (checkedCount === checkboxes.length) {
    globalToggleBtn.dataset.state = 'all';
    globalToggleBtn.textContent = getMessage("selectNone") || "Select None";
  } else {
    globalToggleBtn.dataset.state = 'none';
    globalToggleBtn.textContent = getMessage("selectAll") || "Select All";
  }
}

function updateWindowToggleStates() {
  const windowToggleIcons = document.querySelectorAll('.window-toggle-icon');

  windowToggleIcons.forEach(icon => {
    const windowId = icon.dataset.windowId;
    const checkboxes = document.querySelectorAll(`.tab-item[data-window-id="${windowId}"] input[type="checkbox"]`);
    const checkedCount = document.querySelectorAll(`.tab-item[data-window-id="${windowId}"] input[type="checkbox"]:checked`).length;
    const iconFilled = icon.querySelector('.icon-filled');
    const iconEmpty = icon.querySelector('.icon-empty');

    if (checkedCount === checkboxes.length) {
      icon.dataset.state = 'all';
      iconFilled.style.display = 'block';
      iconEmpty.style.display = 'none';
    } else {
      icon.dataset.state = 'none';
      iconFilled.style.display = 'none';
      iconEmpty.style.display = 'block';
    }
  });
}
