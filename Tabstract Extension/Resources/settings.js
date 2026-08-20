
// We do NOT define default settings here. Instead, we ask background.js to ensure defaults for us.
// That means background.js is the single source of truth.

// =============================
// Debug Logging Helper
// =============================

let DEBUG_MODE = false;

// Load debug mode setting on startup
chrome.storage.local.get(['debugMode'], (result) => {
  DEBUG_MODE = !!result.debugMode;
});

// Listen for debug mode changes
chrome.storage.onChanged.addListener((changes) => {
  if (changes.debugMode) {
    DEBUG_MODE = !!changes.debugMode.newValue;
  }
});

// Debug logging function
function debug(...args) {
  if (DEBUG_MODE) {
    console.log('[Tabstract]', ...args);
    try {
      browser.runtime.sendNativeMessage("application.id", {
        action: "debugLog",
        level: "log",
        source: "settings",
        message: args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ').substring(0, 10000)
      }).catch(() => {});
    } catch (e) {}
  }
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
        source: "settings",
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
      source: "settings"
    }).then((response) => {
      if (response && response.found && response.selector) {
        const result = inspectElement(response.selector);
        result.source = "settings";
        result.timestamp = new Date().toISOString();
        browser.runtime.sendNativeMessage("application.id", {
          action: "elementInspectorResult",
          source: "settings",
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
  },
  testAI: async () => {
    console.log('[Tabstract] Testing Apple Intelligence availability...');
    try {
      const response = await browser.runtime.sendNativeMessage(
        "application.id",
        { action: "ping" }
      );
      console.log('[Tabstract] AI Ping Response:', response);
      console.log('[Tabstract] Available:', response?.available === true);
      if (response?.reason) {
        console.log('[Tabstract] Reason:', response.reason);
      }
      return response;
    } catch (error) {
      console.error('[Tabstract] AI Test Failed:', error);
      return { error: String(error) };
    }
  }
};

// ------------------------------------------------
// 1) Grab references to UI elements
// ------------------------------------------------
const saveAlsoCloses = document.getElementById('saveAlsoCloses');
const deleteAfterRestore = document.getElementById('deleteAfterRestore');
const closeHomeTabOnOpen = document.getElementById('closeHomeTabOnOpen');
const restoreTabsToControl = document.getElementById('restoreTabsToControl');
const snoozeHours = document.getElementById('snoozeHours');
const snoozeSettingsRow = document.getElementById('snoozeSettingsRow');
const enableBadgeCheckbox = document.getElementById('enableBadgeCheckbox');
const undoTimeoutSec = document.getElementById('undoTimeoutSec');
const enableKeyboardShortcutsCheckbox = document.getElementById('enableKeyboardShortcuts');
const darkModeControl = document.getElementById('darkModeControl');
const languageSelect = document.getElementById('languageSelect');

// Additional checkboxes
const pinnedTabs = document.getElementById('pinnedTabs');
const avoidDuplicates = document.getElementById('avoidDuplicates');
const saveAllWindows = document.getElementById('saveAllWindows');
const opentabsBackground = document.getElementById('opentabsBackground');
const oneclickSave = document.getElementById('oneclickSave'); // NEW: reference for the oneclickSave checkbox
const launchOnStartup = document.getElementById('launchOnStartup');
const saveTabsOnStartup = document.getElementById('saveTabsOnStartup');

// AI Features
const aiTitleSuggestions = document.getElementById('aiTitleSuggestions');
const aiSmartCategorization = document.getElementById('aiSmartCategorization');
const aiSupportNotice = document.getElementById('aiSupportNotice');
const aiDisabledNotice = document.getElementById('aiDisabledNotice');
const aiExperimentalNotice = document.getElementById('aiExperimentalNotice');

// Export & Import UI
const exportButton = document.getElementById('exportButton');
const exportFormatSelect = document.getElementById('exportFormat');
const importFileInput = document.getElementById('importFile');
const importButton = document.getElementById('importButton');

// iCloud Sync UI
const icloudSyncToggle = document.getElementById('icloudSyncToggle');
const syncStatusRow = document.getElementById('syncStatusRow');
const syncStatusText = document.getElementById('syncStatusText');
const syncNowBtn = document.getElementById('syncNowBtn');
const syncErrorRow = document.getElementById('syncErrorRow');
const syncErrorText = document.getElementById('syncErrorText');

let aiLanguageLocked = false;

// ------------------------------------------------
// Helper: Get effective language (from localStorage or browser)
// ------------------------------------------------
function getEffectiveLanguage() {
  const preferredLang = localStorage.getItem('preferredLanguage');
  if (preferredLang && preferredLang !== 'auto') {
    return preferredLang;
  }
  return chrome.i18n.getUILanguage() || 'en';
}

// ------------------------------------------------
// 2) On Page Load, Re-Enforce Default Settings
//    (by sending a message to background.js)
// ------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  // Ensure missing keys are set to defaults.
  chrome.runtime.sendMessage({ action: "ensureDefaultSettings" }, () => {
    // Check language support BEFORE loading UI so aiLanguageLocked is set
    checkAILanguageSupport();
    loadUIFromStorage();
    applyDarkModeSetting();
    evaluateAIPlatformSupport();
    setupCheckboxBorderHandlers();
  });
});

// ------------------------------------------------
// Setup hover handlers for checkbox row borders
// ------------------------------------------------
function setupCheckboxBorderHandlers() {
  const settingsCards = document.querySelectorAll('.settings-card');

  settingsCards.forEach(card => {
    const listItems = card.querySelectorAll('li');

    listItems.forEach(li => {
      const checkbox = li.querySelector('input[type="checkbox"]');
      if (checkbox) {
        li.addEventListener('mouseenter', () => {
          li.classList.add('checkbox-hover');
          // Add class to previous sibling to hide its bottom border
          if (li.previousElementSibling) {
            li.previousElementSibling.classList.add('checkbox-hover-next');
          }
        });

        li.addEventListener('mouseleave', () => {
          li.classList.remove('checkbox-hover');
          if (li.previousElementSibling) {
            li.previousElementSibling.classList.remove('checkbox-hover-next');
          }
        });
      }
    });
  });
}

// ------------------------------------------------
// 3) loadUIFromStorage: read from local storage
// ------------------------------------------------
function loadUIFromStorage() {
  chrome.storage.local.get(null, (result) => {
    const popupBehavior = result.popupBehavior;
    saveAlsoCloses.checked = (popupBehavior === "saveAndClose");

    deleteAfterRestore.checked = !!result.deleteAfterRestore;
    closeHomeTabOnOpen.checked = !!result.closeHomeTabOnOpen;

    // Set restore tabs location radio button
    const restoreLocation = result.restoreTabsTo || "current";
    if (restoreLocation === "new") {
      document.getElementById("restoreTabsToNew").checked = true;
    } else {
      document.getElementById("restoreTabsToCurrent").checked = true;
    }

    snoozeHours.value = result.snoozeHours || 24;
    enableBadgeCheckbox.checked = !!result.enableBadge;
    undoTimeoutSec.value = result.undoTimeoutSec || 5;
    enableKeyboardShortcutsCheckbox.checked = !!result.enableKeyboardShortcuts;
    pinnedTabs.checked = !!result.pinnedTabs;
  avoidDuplicates.checked = (result.avoidDuplicates === undefined) ? true : !!result.avoidDuplicates;
    saveAllWindows.checked = !!result.saveAllWindows;
    launchOnStartup.checked = !!result.launchOnStartup;
    saveTabsOnStartup.checked = !!result.saveTabsOnStartup;

    // default to true if undefined
    opentabsBackground.checked = (result.opentabsBackground === undefined)
      ? true
      : !!result.opentabsBackground;

    // For dark mode, default is "Auto"
    if (result.darkMode === "Light") {
      document.getElementById("darkModeOff").checked = true;
    } else if (result.darkMode === "Dark") {
        document.getElementById("darkModeDark").checked = true;
      }
    else {
     document.getElementById("darkModeAuto").checked = true;
   }

  // Load language preference from localStorage (not chrome.storage)
  const preferredLanguage = localStorage.getItem('preferredLanguage') || 'auto';
  if (languageSelect) {
    languageSelect.value = preferredLanguage;
  }

  // NEW: load oneclickSave from storage
  oneclickSave.checked = !!result.oneclickSave;

  // AI Features - only available in supported languages
  // Disable if language is not supported by Apple Foundation Models
  if (aiLanguageLocked) {
    aiTitleSuggestions.checked = false;
    aiTitleSuggestions.disabled = true;
    aiSmartCategorization.checked = false;
    aiSmartCategorization.disabled = true;
  } else {
    aiTitleSuggestions.checked = !!result.aiTitleSuggestions;
    aiTitleSuggestions.disabled = false;
    aiSmartCategorization.checked = !!result.aiSmartCategorization;
    aiSmartCategorization.disabled = false;
  }

  toggleSnoozeUI(enableBadgeCheckbox.checked);
  toggleKeyboardCommandsUI(enableKeyboardShortcutsCheckbox.checked);
  // Smart categorization depends on title suggestions
  toggleAICategorizationUI(aiTitleSuggestions.checked);
  // Save tabs on startup depends on launch on startup
  toggleSaveTabsOnStartupUI(launchOnStartup.checked);
  updateAIExperimentalNotice();

  // iCloud Sync
  if (icloudSyncToggle) {
    icloudSyncToggle.checked = !!result.icloudSyncEnabled;
    toggleSyncUI(icloudSyncToggle.checked);
    if (icloudSyncToggle.checked) {
      refreshSyncStatus();
    }
  }
});
}

// Re-check sync status when settings page regains focus (catches iCloud sign-in/out)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && icloudSyncToggle && icloudSyncToggle.checked) {
    refreshSyncStatus();
  }
});

// ------------------------------------------------
// 4) Helper Functions
// ------------------------------------------------
function flashSavedRow(rowElement) {
  if (!rowElement) return;
  rowElement.classList.add("flash-saved-subtle");
  setTimeout(() => rowElement.classList.remove("flash-saved-subtle"), 300);
}

function toggleSnoozeUI(enable) {
  if (enable) {
    snoozeSettingsRow.classList.remove("disabled");
    snoozeHours.disabled = false;
  } else {
    snoozeSettingsRow.classList.add("disabled");
    snoozeHours.disabled = true;
  }
}

function toggleKeyboardCommandsUI(enabled) {
  const commandsRow = document.querySelector('.settings-card.keyboardshortcuts .settings-row.commands');
  if (commandsRow) {
    commandsRow.classList.remove('disabled');
    if (!enabled) {
      commandsRow.classList.add('disabled');
    }
  }
}

function toggleAICategorizationUI(enabled) {
  if (!aiSmartCategorization) return;
  const categorizationRow = aiSmartCategorization.closest('.settings-row');
  if (categorizationRow) {
    if (enabled) {
      categorizationRow.classList.remove('disabled');
      aiSmartCategorization.disabled = false;
    } else {
      categorizationRow.classList.add('disabled');
      aiSmartCategorization.disabled = true;
      aiSmartCategorization.checked = false;
      // Save the disabled state
      chrome.storage.local.set({ aiSmartCategorization: false });
    }
  }
}

function toggleSaveTabsOnStartupUI(enabled) {
  if (!saveTabsOnStartup) return;
  const saveTabsRow = saveTabsOnStartup.closest('.settings-row');
  if (saveTabsRow) {
    if (enabled) {
      saveTabsRow.classList.remove('disabled');
      saveTabsOnStartup.disabled = false;
    } else {
      saveTabsRow.classList.add('disabled');
      saveTabsOnStartup.disabled = true;
      saveTabsOnStartup.checked = false;
      // Save the disabled state
      chrome.storage.local.set({ saveTabsOnStartup: false });
    }
  }
}

function updateAIExperimentalNotice() {
  if (!aiExperimentalNotice) return;
  if (aiLanguageLocked) {
    aiExperimentalNotice.style.display = 'none';
    return;
  }
  const hasEnabledFeature = (aiTitleSuggestions && aiTitleSuggestions.checked) ||
    (aiSmartCategorization && aiSmartCategorization.checked);
  aiExperimentalNotice.style.display = hasEnabledFeature ? 'flex' : 'none';
}

function setAIControlsState(enabled, persistFalse = false) {
  if (!aiTitleSuggestions || !aiSmartCategorization) return;

  const aiTitleRow = aiTitleSuggestions.closest('.settings-row');
  const aiCategorizationRow = aiSmartCategorization.closest('.settings-row');

  if (enabled) {
    if (aiLanguageLocked) return;
    if (aiTitleRow) aiTitleRow.classList.remove('disabled');
    aiTitleSuggestions.disabled = false;
    toggleAICategorizationUI(aiTitleSuggestions.checked);
    updateAIExperimentalNotice();
    return;
  }

  if (aiTitleRow) aiTitleRow.classList.add('disabled');
  aiTitleSuggestions.disabled = true;

  if (aiCategorizationRow) aiCategorizationRow.classList.add('disabled');
  aiSmartCategorization.disabled = true;

  // Always uncheck when disabling
  aiTitleSuggestions.checked = false;
  aiSmartCategorization.checked = false;
  toggleAICategorizationUI(false);

  // Persist to storage if requested
  if (persistFalse) {
    chrome.storage.local.set({
      aiTitleSuggestions: false,
      aiSmartCategorization: false
    });
  }

  updateAIExperimentalNotice();
}

function hideAIPlatformNotices() {
  if (aiSupportNotice) aiSupportNotice.style.display = 'none';
  if (aiDisabledNotice) aiDisabledNotice.style.display = 'none';
}

function applyAIStatusUI(status) {
  hideAIPlatformNotices();

  if (aiLanguageLocked) {
    return;
  }

  if (!status || typeof status !== 'object') {
    return;
  }

  const isSupported = status.supported !== false;
  const isAvailable = status.available === true;

  if (!isSupported) {
    setAIControlsState(false, true);
    if (aiSupportNotice) {
      // Update the message with specific reason if provided
      if (status.reason) {
        const messageSpan = aiSupportNotice.querySelector('[data-i18n-html]');
        if (messageSpan) {
          messageSpan.innerHTML = `<strong>${status.reason}</strong>`;
        }
      }
      aiSupportNotice.style.display = 'flex';
    }
    return;
  }

  if (!isAvailable) {
    setAIControlsState(false, true);
    if (aiDisabledNotice) {
      const messageSpan = aiDisabledNotice.querySelector('[data-i18n-html]');
      if (messageSpan) {
        // If device appears supported but API is unavailable, provide detailed troubleshooting
        if (isSupported) {
          messageSpan.innerHTML = getMessage("aiEnabledButInaccessible") ||
            `<strong>Apple Intelligence appears to be enabled on your system, but Tabstract cannot access it.</strong><br><br>Common causes:<ul><li>Your macOS language and Siri language don't match. Apple requires that both are set to the same language.</li><li>Apple Intelligence is still initializing; wait a few minutes and reload Tabstract → Settings.</li><li>You are in an unsupported country. Apple Intelligence is not available on devices purchased in mainland China, or on devices used in mainland China with an Apple ID whose country or region is set to China mainland.</li></ul>`;
        } else if (status.reason) {
          // For unsupported devices, show the specific reason
          messageSpan.innerHTML = `<strong>${status.reason}</strong>`;
        }
      }
      aiDisabledNotice.style.display = 'flex';
    }
    return;
  }

  setAIControlsState(true);
}

function evaluateAIPlatformSupport() {
  if (!chrome || !chrome.runtime || typeof chrome.runtime.sendMessage !== 'function') {
    return;
  }

  chrome.runtime.sendMessage({ action: "checkAIStatus" }, (response) => {
    if (chrome.runtime.lastError) {
      debug('[Tabstract] Unable to check Apple Intelligence status:', chrome.runtime.lastError.message);
      applyAIStatusUI({ available: false, supported: null, reason: chrome.runtime.lastError.message });
      return;
    }
    applyAIStatusUI(response || {});
  });
}

/**
 * Check if the current language supports AI features
 * Apple Foundation Models only support certain languages
 */
function checkAILanguageSupport() {
  const aiLanguageNotice = document.getElementById('aiLanguageNotice');
  const currentLang = getEffectiveLanguage();
  const langCode = currentLang.toLowerCase();
  const langPrefix = langCode.split('-')[0];

  // Languages currently supported by Apple Foundation Models (as of macOS 26.2)
  // Includes languages added in iOS 18.4/macOS 15.4: da, nl, nb, pt-PT, sv, tr, vi
  const supportedLanguages = [
    'en', 'es', 'es-419', 'fr', 'fr-ca', 'de', 'it', 'ja', 'ko',
    'pt-br', 'pt-pt', 'zh-cn', 'zh-tw',
    'da', 'nl', 'nb', 'no', 'sv', 'tr', 'vi'
  ];

  // Check if the exact language code is supported
  let isSupported = supportedLanguages.includes(langCode);

  // If not an exact match, check language prefix for supported base languages
  if (!isSupported) {
    // For most languages, any variant is supported (en-US, en-GB, es-ES, es-MX, etc.)
    if (['en', 'es', 'fr', 'de', 'it', 'ja', 'ko', 'da', 'nl', 'nb', 'no', 'sv', 'tr', 'vi', 'pt'].includes(langPrefix)) {
      isSupported = true;
    }
    // Chinese: both zh-CN and zh-TW are supported
    else if (langPrefix === 'zh' && (langCode === 'zh-cn' || langCode === 'zh-tw')) {
      isSupported = true;
    }
  }

  if (!isSupported) {
    aiLanguageLocked = true;

    if (aiLanguageNotice) {
      const noticeText = document.getElementById('aiLanguageNoticeText');
      if (noticeText) {
        noticeText.textContent = getMessage("aiLanguageNotSupported") ||
          "AI features are not available in this language because Apple Intelligence does not support it yet.";
      }
      aiLanguageNotice.style.display = 'block';
    }

    updateAIExperimentalNotice();
    return false;
  }

  // Language is supported
  aiLanguageLocked = false;

  // Hide the language notice
  if (aiLanguageNotice) {
    aiLanguageNotice.style.display = 'none';
  }

  // Show experimental notice if appropriate
  updateAIExperimentalNotice();

  return true;
}

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

/**
 * applyDarkModeSetting applies the dark mode setting.
 */
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

// ------------------------------------------------
// 5) Update Storage Listeners
// ------------------------------------------------
saveAlsoCloses.addEventListener('change', function() {
  const newBehavior = this.checked ? "saveAndClose" : "saveOnly";
  chrome.storage.local.set({ popupBehavior: newBehavior }, () => {
    flashSavedRow(this.closest(".settings-row"));
  });
});

deleteAfterRestore.addEventListener('change', function() {
  const val = this.checked;
  chrome.storage.local.set({ deleteAfterRestore: val }, () => {
    flashSavedRow(this.closest(".settings-row"));
  });
});

closeHomeTabOnOpen.addEventListener('change', function() {
  const val = this.checked;
  chrome.storage.local.set({ closeHomeTabOnOpen: val }, () => {
    flashSavedRow(this.closest(".settings-row"));
  });
});

restoreTabsToControl.addEventListener('change', function() {
  const selected = document.querySelector('input[name="restoreTabsTo"]:checked').value;
  chrome.storage.local.set({ restoreTabsTo: selected }, () => {
    flashSavedRow(this.closest(".settings-row"));
  });
});

snoozeHours.addEventListener('change', function() {
  const val = parseInt(this.value, 10) || 0;
  chrome.storage.local.set({ snoozeHours: val }, () => {
    flashSavedRow(this.closest(".settings-row"));
  });
});

undoTimeoutSec.addEventListener('change', function() {
  const val = parseInt(this.value, 10) || 5;
  chrome.storage.local.set({ undoTimeoutSec: val }, () => {
    flashSavedRow(this.closest(".settings-row"));
  });
});

enableBadgeCheckbox.addEventListener('change', function () {
  const val = this.checked;
  chrome.storage.local.set({ enableBadge: val, badgeSnoozeUntil: 0 }, () => {
    chrome.runtime.sendMessage({ action: "snoozeBadge", hours: 0 });
    flashSavedRow(this.closest(".settings-row"));
  });
  toggleSnoozeUI(val);
});

enableKeyboardShortcutsCheckbox.addEventListener('change', function () {
  const val = this.checked;
  chrome.storage.local.set({ enableKeyboardShortcuts: val }, () => {
    flashSavedRow(this.closest(".settings-row"));
  });
  toggleKeyboardCommandsUI(val);
});

pinnedTabs.addEventListener('change', function() {
  const val = this.checked;
  chrome.storage.local.set({ pinnedTabs: val }, () => {
    flashSavedRow(this.closest(".settings-row"));
  });
});

avoidDuplicates.addEventListener('change', function() {
  const val = this.checked;
  chrome.storage.local.set({ avoidDuplicates: val }, () => {
    flashSavedRow(this.closest(".settings-row"));
  });
});

saveAllWindows.addEventListener('change', function() {
  const val = this.checked;
  chrome.storage.local.set({ saveAllWindows: val }, () => {
    flashSavedRow(this.closest(".settings-row"));
  });
});

opentabsBackground.addEventListener('change', function() {
  const val = this.checked;
  chrome.storage.local.set({ opentabsBackground: val }, () => {
    flashSavedRow(this.closest(".settings-row"));
  });
});

// NEW: oneclickSave event
oneclickSave.addEventListener('change', function() {
  const val = this.checked;
  chrome.storage.local.set({ oneclickSave: val }, () => {
    flashSavedRow(this.closest(".settings-row"));
  });
});

// NEW: Launch on startup
launchOnStartup.addEventListener('change', function() {
  const val = this.checked;
  chrome.storage.local.set({ launchOnStartup: val }, () => {
    flashSavedRow(this.closest('.settings-row'));
  });
  toggleSaveTabsOnStartupUI(val);
  if (val) {
    // Suppress auto-open for the current browser session; only open on next launch
    try { chrome.runtime.sendMessage({ action: 'suppressStartupLaunch' }); } catch (e) {}
  }
});

// NEW: Save tabs on startup
saveTabsOnStartup.addEventListener('change', function() {
  const val = this.checked;
  chrome.storage.local.set({ saveTabsOnStartup: val }, () => {
    flashSavedRow(this.closest('.settings-row'));
  });
});

// AI Features event listeners
aiTitleSuggestions.addEventListener('change', function() {
  const val = this.checked;
  chrome.storage.local.set({ aiTitleSuggestions: val }, () => {
    flashSavedRow(this.closest('.settings-row'));
    toggleAICategorizationUI(val);
    updateAIExperimentalNotice();
  });
  updateAIExperimentalNotice();
});

aiSmartCategorization.addEventListener('change', function() {
  const val = this.checked;
  chrome.storage.local.set({ aiSmartCategorization: val }, () => {
    flashSavedRow(this.closest('.settings-row'));
  });
  updateAIExperimentalNotice();
});

// Listen for changes to Dark Mode radio buttons
darkModeControl.addEventListener('change', function () {
  const selected = document.querySelector('input[name="darkMode"]:checked').value;
  // Sync to localStorage immediately for instant access on next page load
  localStorage.setItem('tabstract_darkMode', selected);
  chrome.storage.local.set({ darkMode: selected }, () => {
    flashSavedRow(this.closest(".settings-row"));
    applyDarkModeSetting();
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

// Populate language dropdown dynamically
async function populateLanguageDropdown() {
  if (!languageSelect) return;

  // Define language codes and their native names
  const languages = [
    { code: 'ar', nativeName: 'العربية', i18nKey: 'langNameArabic' },
    { code: 'da', nativeName: 'Dansk', i18nKey: 'langNameDanish' },
    { code: 'de', nativeName: 'Deutsch', i18nKey: 'langNameGerman' },
    { code: 'en', nativeName: 'English', i18nKey: 'langNameEnglish' },
    { code: 'es', nativeName: 'Español', i18nKey: 'langNameSpanish' },
    { code: 'es-419', nativeName: 'Español Latinoamericano', i18nKey: 'langNameSpanishLA' },
    { code: 'fr', nativeName: 'Français', i18nKey: 'langNameFrench' },
    { code: 'fr-CA', nativeName: 'Français Canadien', i18nKey: 'langNameFrenchCA' },
    { code: 'it', nativeName: 'Italiano', i18nKey: 'langNameItalian' },
    { code: 'ja', nativeName: '日本語', i18nKey: 'langNameJapanese' },
    { code: 'ko', nativeName: '한국어', i18nKey: 'langNameKorean' },
    { code: 'nb', nativeName: 'Norsk', i18nKey: 'langNameNorwegian' },
    { code: 'nl', nativeName: 'Nederlands', i18nKey: 'langNameDutch' },
    { code: 'pt-BR', nativeName: 'Português do Brasil', i18nKey: 'langNamePortugueseBR' },
    { code: 'pt-PT', nativeName: 'Português', i18nKey: 'langNamePortuguesePT' },
    { code: 'ru', nativeName: 'Русский', i18nKey: 'langNameRussian' },
    { code: 'sv', nativeName: 'Svenska', i18nKey: 'langNameSwedish' },
    { code: 'tr', nativeName: 'Türkçe', i18nKey: 'langNameTurkish' },
    { code: 'vi', nativeName: 'Tiếng Việt', i18nKey: 'langNameVietnamese' },
    { code: 'zh-CN', nativeName: '简体中文', i18nKey: 'langNameChineseCN' },
    { code: 'zh-TW', nativeName: '繁體中文', i18nKey: 'langNameChineseTW' }
  ];

  // Get user's preferred language (from Tabstract settings, not browser)
  let preferredLanguage = localStorage.getItem('preferredLanguage') || 'auto';
  let currentLang = preferredLanguage;

  // If set to auto, use browser's UI language
  if (currentLang === 'auto') {
    currentLang = chrome.i18n.getUILanguage().toLowerCase();
    // Normalize common variants
    if (currentLang === 'en-us' || currentLang === 'en-gb') currentLang = 'en';
    if (currentLang === 'pt') currentLang = 'pt-PT';
    if (currentLang === 'es-mx' || currentLang === 'es-ar') currentLang = 'es-419';
    if (currentLang === 'zh' || currentLang === 'zh-hans') currentLang = 'zh-CN';

    // Resolve to a locale we actually ship. Safari returns region-qualified
    // codes ('ja-JP', 'de-DE'), but _locales/ is keyed by base language for
    // most locales — and its folder names are case-sensitive, so 'pt-br' would
    // 404 even though pt-BR exists. Match case-insensitively, then fall back to
    // the base language. Anything unrecognized stays as-is for the English fallback.
    const exactMatch = languages.find(l => l.code.toLowerCase() === currentLang);
    if (exactMatch) {
      currentLang = exactMatch.code;
    } else {
      const baseMatch = languages.find(l => l.code.toLowerCase() === currentLang.split('-')[0]);
      if (baseMatch) currentLang = baseMatch.code;
    }
  }

  // Load the messages.json for the current language to get localized names
  let localizedMessages = {};
  try {
    const response = await fetch(`_locales/${currentLang}/messages.json`);
    const data = await response.json();
    localizedMessages = data;
  } catch (error) {
    debug('Failed to load messages for language dropdown:', error);
    // Fallback to English
    try {
      const response = await fetch('_locales/en/messages.json');
      const data = await response.json();
      localizedMessages = data;
    } catch (fallbackError) {
      debug('Failed to load fallback messages:', fallbackError);
    }
  }

  // Populate dropdown
  languages.forEach(lang => {
    const option = document.createElement('option');
    option.value = lang.code;

    // If this is the current language, show only native name
    // Otherwise show "Native Name (Localized Name)"
    if (lang.code === currentLang) {
      option.textContent = lang.nativeName;
    } else {
      const localizedName = localizedMessages[lang.i18nKey]?.message || lang.nativeName;
      option.textContent = `${lang.nativeName} (${localizedName})`;
    }

    languageSelect.appendChild(option);
  });
}

// Call after DOM is ready
populateLanguageDropdown();

// ------------------------------------------------
// 4.5) Globe Icon Region Mapping
// ------------------------------------------------

// SVG paths for each region's globe icon
const GLOBE_ICONS = {
  americas: 'M16.3273 28.0355C18.4853 28.0355 24.1028 20.6345 24.1028 17.8273C24.1028 16.1705 20.572 13.1095 18.7023 13.1095C17.8602 13.1095 16.5945 14.213 15.7697 14.213C14.9734 14.213 12.8528 12.5191 12.8528 11.843C12.8528 11.5263 13.3005 11.1809 13.6555 11.1809C14.1861 11.1809 15.7083 12.6341 16.6291 12.6341C17.8641 12.6341 18.6653 11.828 18.6653 10.5461C18.6653 10.0773 18.4681 9.62906 18.0086 8.99766C19.743 8.11782 23.1053 6.32641 23.982 4.08407L22.818 3.43203C22.1497 5.52188 18.4473 7.26906 16.573 8.24047C16.2873 8.38813 16.1483 8.69156 16.4027 9.04188C17.0723 9.97125 17.3488 10.3716 17.3488 10.7492C17.3488 11.0767 17.0983 11.3223 16.7648 11.3223C16.1911 11.3223 14.5025 9.86438 13.6555 9.86438C12.6813 9.86438 11.5411 10.9156 11.5411 11.843C11.5411 13.1836 14.3494 15.5247 15.7697 15.5247C16.6592 15.5247 18.183 14.4105 18.7023 14.4105C19.8063 14.4105 22.7911 16.912 22.7911 17.8273C22.7911 19.7486 17.7319 26.7238 16.2998 26.7238C15.8775 26.7238 15.3372 26.3316 15.3372 25.9523C15.3372 25.7756 15.3889 25.6167 15.5608 25.065C15.717 24.565 15.9466 23.9017 15.9309 23.1759C15.9153 22.2475 15.1986 21.582 13.3172 20.2464C12.9891 20.012 12.6405 19.7728 12.2967 19.512C11.7677 19.1128 11.5403 18.7508 11.5403 18.3273C11.5403 18.1048 11.592 17.8716 11.7483 17.3823C11.8986 16.8678 11.9778 16.5014 11.9778 16.2492C11.9778 15.6091 11.6669 15.1791 10.9169 14.5384C10.8075 14.4603 10.7294 14.3773 10.6356 14.2992L8.13078 12.0648C5.11719 9.37938 4.90516 7.55688 6.14657 5.42063L4.88656 5.16141C3.58 7.35313 3.7375 9.94734 7.26313 13.0538L9.74266 15.2413C10.3256 15.7666 10.6661 15.9891 10.6661 16.2816C10.6661 16.6689 10.2286 17.4033 10.2286 18.3273C10.2286 19.1792 10.6467 19.9277 11.5034 20.5645C13.4817 22.0558 14.6192 22.7138 14.6192 23.2023C14.6348 24.1942 14.0206 24.9803 14.0206 26.0148C14.0206 27.0058 15.2497 28.0355 16.3273 28.0355ZM15.6711 31.3422C24.3275 31.3422 31.347 24.3227 31.347 15.6711C31.347 7.01469 24.3275 0 15.6711 0C7.01953 0 0 7.01469 0 15.6711C0 24.3227 7.01953 31.3422 15.6711 31.3422ZM15.6711 29.6677C7.93953 29.6677 1.67453 23.4027 1.67453 15.6711C1.67453 7.93953 7.93953 1.67453 15.6711 1.67453C23.4027 1.67453 29.6725 7.93953 29.6725 15.6711C29.6725 23.4027 23.4027 29.6677 15.6711 29.6677Z',
  europe: 'M16.5938 27.5559C19.4802 27.5559 21.9463 23.0877 22.5917 22.0252C23.3703 20.7406 23.0098 19.4513 23.0098 18.6555C23.0098 18.0548 24.6661 16.9873 24.6661 15.5461C24.6661 14.0698 21.4581 13.0955 21.4581 12.343C21.4581 11.905 21.8239 11.3792 22.2188 11.3792C22.8959 11.3792 24.5205 13.5559 25.5469 13.5559C26.1622 13.5559 26.248 13.0091 26.6094 13.0091C27.0216 13.0091 27.4611 17.5044 29.4575 18.5447L29.9878 17.3688C28.0761 16.64 28.7233 11.5675 26.7812 11.5675C26.0938 11.5675 25.7736 12.1769 25.4062 12.1769C25.1714 12.1769 24.7216 11.7895 23.8191 11.0492C23.3659 10.6898 22.9359 10.2442 22.1406 10.2442C21.1966 10.2442 20.245 11.3434 20.245 12.3586C20.245 14.0908 23.3544 14.7683 23.3544 15.5461C23.3544 15.9394 23.1944 16.2545 22.6017 16.9302C21.9611 17.6489 21.6981 18.0945 21.6981 18.6555C21.6981 18.9163 21.7245 19.1614 21.7402 19.3958C21.828 20.5153 21.7617 20.9205 21.4116 21.4834C20.6589 22.6606 18.6169 26.2394 16.5938 26.2394C14.6828 26.2394 14.8536 23.5725 14.8536 21.2336C14.8536 19.0298 13.0992 17.3644 10.7656 17.3644C8.83359 17.3644 7.88 16.4097 7.88 14.5773C7.88 12.1398 10.3989 10.333 13.0156 10.333C14.6223 10.333 15.9144 11.2434 17.2344 11.2434C18.2377 11.2434 18.8994 9.85047 18.8994 8.64578C18.8994 7.23141 15.9859 5.70922 15.0387 5.70922C14.3361 5.70922 14.0661 6.10906 13.8438 7.04985L14.1562 6.99922L13.6514 6.63766C13.0291 6.21141 12.4698 5.93016 11.9148 5.93016C10.3955 5.93016 10.3378 7.88281 9.47313 7.88281C9.21672 7.88281 9.05672 7.72766 9.05672 7.475C9.05672 6.68578 10.7528 5.3086 10.7636 3.20157L10.7744 2.07641L9.5225 2.07641L9.5225 3.29375C9.5225 5.35766 7.82156 6.19531 7.82156 7.57797C7.82156 8.45516 8.41859 9.01016 9.35938 9.01016C11.1122 9.01016 11.0514 7.07532 12 7.07532C12.6906 7.09094 13.3442 8.04953 14.3525 8.04953C15.0277 8.04953 15.3036 7.64641 15.4661 6.76172L15.0286 6.87328C15.8606 7.18313 17.6475 8.01063 17.6475 8.7961C17.6475 9.28469 17.4514 9.92688 17.0312 9.92688C16.3303 9.92688 14.5695 9.02125 13.0156 9.02125C9.68969 9.02125 6.56828 11.4247 6.56828 14.5773C6.56828 17.155 8.08719 18.6809 10.7656 18.6809C12.3587 18.6809 13.5419 19.7547 13.5419 21.2336C13.5419 23.5509 13.2859 27.5559 16.5938 27.5559ZM20.6478 6.18453C20.977 6.18453 21.275 6.50297 21.8338 6.50297C22.1786 6.50297 22.4345 6.18453 22.4345 5.77719C22.4345 5.04063 21.6091 4.48188 20.5277 4.48188C19.248 4.48188 18.5114 4.9 18.5114 5.64141C18.5114 6.12203 18.8719 6.46688 19.3525 6.46688C19.8488 6.46688 20.0783 6.18453 20.6478 6.18453ZM15.6711 31.3422C24.3275 31.3422 31.347 24.3227 31.347 15.6711C31.347 7.01469 24.3275 0 15.6711 0C7.01953 0 0 7.01469 0 15.6711C0 24.3227 7.01953 31.3422 15.6711 31.3422ZM15.6711 29.6677C7.93953 29.6677 1.67453 23.4027 1.67453 15.6711C1.67453 7.93953 7.93953 1.67453 15.6711 1.67453C23.4027 1.67453 29.6725 7.93953 29.6725 15.6711C29.6725 23.4027 23.4027 29.6677 15.6711 29.6677Z',
  asia: 'M3.12391 22.4164L4.78188 19.1986C5.24844 18.293 5.73172 17.7811 6.26563 17.7811C6.78391 17.7811 7.34797 18.2763 8.12703 19.2983C9.57907 21.1673 10.5247 22.0623 11.4423 22.0623C12.3288 22.0623 13.4053 20.7261 13.4053 19.8322C13.4053 19.135 12.3806 18.5719 12.3806 18.2039C12.3806 17.9992 12.5842 17.8764 12.9419 17.8764C15.4363 17.8764 17.1397 15.827 17.1397 14.4616C17.1397 13.1608 15.6364 12.1311 15.6364 11.6031C15.6364 11.4706 15.7291 11.3731 15.847 11.3731C16.0022 11.3731 16.2139 11.5148 16.6653 11.83C18.2845 13.022 19.1305 12.5023 19.2334 11.5014C19.2766 11.1044 19.5125 10.7606 20.4252 10.3328C22.0211 9.56172 23.6241 8.07844 23.6241 6.9275C23.6241 5.44141 21.4361 4.76953 21.4361 4.32188C21.4361 4.04875 22.0534 3.72828 23.2025 3.38407L22.8797 2.11438C21.1519 2.57984 19.9998 3.3525 19.9998 4.25719C19.9998 5.54594 22.3123 6.10969 22.3123 6.9275C22.3123 7.62203 20.9794 8.58953 19.9175 9.11594C18.3813 9.92375 18.2738 10.4097 18.1277 11.0248C17.8678 11.7861 17.0005 10.2458 15.6794 10.2458C14.9466 10.2458 14.4061 10.7167 14.4061 11.4689C14.4061 12.6188 15.828 13.6469 15.828 14.4616C15.828 15.418 14.7638 16.6677 12.6438 16.6677C11.5694 16.6677 10.9659 17.152 10.9659 17.9764C10.9659 18.7609 12.0553 19.5034 12.0553 19.8322C12.0553 20.1484 11.6659 20.6584 11.4639 20.6584C11.1067 20.6584 10.3638 20.0211 9.16875 18.4942C8.15313 17.1661 7.23985 16.4645 6.33032 16.4645C5.12703 16.4645 4.33657 17.3995 3.78922 18.4306L2.2386 21.3352ZM22.6145 28.9023L23.667 28.0983C22.9639 27.1608 22.0927 25.9322 20.3447 25.9322C19.2573 25.9322 18.9891 26.3169 18.1255 26.3169C17.555 26.3169 17.2469 25.838 17.0292 24.8914C16.8175 24.0203 16.7539 23.4444 17.2625 23.2073C17.8638 22.9353 19.7931 22.7795 20.4289 20.7747C20.9208 19.2991 21.3959 18.7194 22.2477 18.7194C23.8481 18.7194 23.5083 20.18 25.0595 20.18C25.7336 20.18 26.1134 19.8734 26.6764 19.8734C27.4317 19.8734 27.9877 20.555 28.1562 22.3409L29.4486 21.7159C29.1539 19.6728 28.2131 18.5617 26.9 18.5617C26.5406 18.5617 26.0961 18.6291 25.6645 18.7697C25.0714 18.9561 24.9255 18.9055 24.4756 18.3834C23.8398 17.6636 23.3064 17.4077 22.44 17.4077C20.8377 17.4077 19.8995 18.1491 19.1641 20.3942C18.9523 21.0714 18.648 21.3084 17.4875 21.7389L16.8167 21.983C15.6211 22.4323 15.2956 23.295 15.7283 25.177C16.1141 26.8247 16.8878 27.6394 17.9848 27.6394C18.9811 27.6394 19.6244 27.2655 20.3447 27.2655C21.3872 27.2391 21.9044 27.9098 22.6145 28.9023ZM19.1897 14.6938C20.1908 14.6938 20.6391 13.7972 21.77 13.4631C22.52 13.2444 22.9166 12.4836 22.9166 11.837C22.9166 11.3106 22.6509 10.8623 22.0825 10.8623C21.4828 10.8623 20.9203 11.3263 20.5502 12.1134C20.347 12.5617 20.013 12.7805 19.1897 13.01C18.5383 13.2083 18.3088 13.4475 18.3088 13.9378C18.3088 14.4642 18.7258 14.6938 19.1897 14.6938ZM14.7069 21.8398C15.5878 21.8398 16.4531 20.8183 16.4531 19.9061C16.4531 18.78 15.9892 18.2536 15.452 18.2536C14.8631 18.2536 14.493 18.947 14.493 20.0047C14.493 20.5995 13.9666 20.62 13.9666 21.2245C13.9666 21.5947 14.2586 21.8398 14.7069 21.8398ZM12.0016 24.6702C12.6794 24.6702 13.0964 24.3156 13.0964 23.758C13.0964 23.3253 12.7731 23.0489 12.3092 23.0489C10.4428 23.0489 10.3647 21.9961 9.46813 21.9961C8.96813 21.9961 8.62438 22.2881 8.62438 22.7208C8.62438 23.0597 8.96813 23.3253 9.43203 23.3253C10.4272 23.3253 9.95844 24.6702 12.0016 24.6702ZM15.6711 31.3422C24.3275 31.3422 31.347 24.3227 31.347 15.6711C31.347 7.01469 24.3275 0 15.6711 0C7.01953 0 0 7.01469 0 15.6711C0 24.3227 7.01953 31.3422 15.6711 31.3422ZM15.6711 29.6677C7.93953 29.6677 1.67453 23.4027 1.67453 15.6711C1.67453 7.93953 7.93953 1.67453 15.6711 1.67453C23.4027 1.67453 29.6725 7.93953 29.6725 15.6711C29.6725 23.4027 23.4027 29.6677 15.6711 29.6677Z'
};

// Map language codes to regions
const LANGUAGE_TO_REGION = {
  // Americas
  'en': 'americas',
  'es-419': 'americas',
  'fr-CA': 'americas',
  'pt-BR': 'americas',
  // Europe & Africa
  'de': 'europe',
  'es': 'europe',
  'fr': 'europe',
  'it': 'europe',
  'nl': 'europe',
  'pt-PT': 'europe',
  'ru': 'europe',
  'sv': 'europe',
  'ar': 'europe',
  // Asia & Australia
  'ja': 'asia',
  'ko': 'asia',
  'zh-CN': 'asia',
  'zh-TW': 'asia'
};

/**
 * Update the globe icon to show the appropriate region for the selected language
 */
function updateGlobeIcon(languageCode) {
  const globeIcon = document.getElementById('languageGlobeIcon');
  if (!globeIcon) return;

  // For 'auto', detect system language
  let effectiveLang = languageCode;
  if (languageCode === 'auto') {
    effectiveLang = (chrome.i18n && chrome.i18n.getUILanguage()) || 'en';
  }

  // Normalize language code: try exact match first, then base language code
  // e.g., 'en-US' -> try 'en-US', then 'en'; 'es-419' -> try 'es-419', then 'es'
  let region = LANGUAGE_TO_REGION[effectiveLang];

  if (!region) {
    // Try base language code (e.g., 'en-US' -> 'en')
    const baseLang = effectiveLang.split('-')[0];
    region = LANGUAGE_TO_REGION[baseLang];
  }

  // Default to Americas for English variants if not found
  if (!region && effectiveLang.startsWith('en')) {
    region = 'americas';
  }

  // Final fallback
  region = region || 'europe';

  const pathData = GLOBE_ICONS[region];

  // Update the SVG path
  const pathElement = globeIcon.querySelector('g path');
  if (pathElement && pathData) {
    pathElement.setAttribute('d', pathData);
  }
}

// Update globe icon on page load
chrome.storage.local.get(['preferredLanguage'], (result) => {
  const currentLang = result.preferredLanguage || 'auto';
  updateGlobeIcon(currentLang);
});

// Listen for language picker changes
if (languageSelect) {
  languageSelect.addEventListener('change', function() {
    const selectedLang = this.value;

    // Update globe icon immediately before reload
    updateGlobeIcon(selectedLang);

    // Save to both localStorage (for UI) and chrome.storage (for background.js)
    localStorage.setItem('preferredLanguage', selectedLang);
    chrome.storage.local.set({ preferredLanguage: selectedLang });
    flashSavedRow(this.closest('.settings-row'));

    // Reload page after a brief delay to apply new language
    setTimeout(() => {
      window.location.reload();
    }, 300);
  });
}

// Full-row click toggling for non-snooze rows
document.querySelectorAll('.settings-row:not(.snoozehours):not(.accent-color)').forEach(row => {
  row.addEventListener('click', function(e) {
    const tag = e.target.tagName.toLowerCase();
    if (["input", "label", "button", "svg", "path", "select", "strong", "em", "span"].includes(tag)) {
      return;
    }
    const checkbox = row.querySelector('input[type="checkbox"]');
    if (checkbox) {
      checkbox.checked = !checkbox.checked;
      checkbox.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
});

// ------------------------------------------------
// 9) Accent Color Picker Functionality
// ------------------------------------------------
// Note: Core accent color functions (hexToRgb, adjustBrightness, applyAccentColor, etc.)
// are now in the shared accentColor.js module

const accentColorPicker = document.getElementById('accentColorPicker');
const colorPresets = document.querySelectorAll('.color-preset');

/**
 * Update the color picker UI with the current color
 */
function updateColorPickerUI(color) {
  // Update active state on color presets
  colorPresets.forEach(preset => {
    if (preset.dataset.color.toUpperCase() === color.toUpperCase()) {
      preset.classList.add('active');
    } else {
      preset.classList.remove('active');
    }
  });

  // Sync the color picker value
  if (accentColorPicker) {
    accentColorPicker.value = color;
  }
}

/**
 * Save accent color to storage and apply it
 */
function saveAccentColor(color) {
  // Sync to localStorage immediately for instant access on next page load
  localStorage.setItem('tabstract_accentColor', color);

  chrome.storage.local.set({ accentColor: color }, () => {
    applyAccentColor(color);
    updateColorPickerUI(color);
    // Notify background script to update badge color
    chrome.runtime.sendMessage({ action: "updateAccentColor", color: color });
  });
}

/**
 * Load and apply accent color, then update the UI
 */
function loadAccentColorForSettings() {
  chrome.storage.local.get(['accentColor'], (result) => {
    const color = result.accentColor || DEFAULT_ACCENT_COLOR;
    applyAccentColor(color);
    updateColorPickerUI(color);
  });
}

// Load accent color on page load (in addition to what accentColor.js does)
if (accentColorPicker) {
  loadAccentColorForSettings();

  // Color picker change event
  accentColorPicker.addEventListener('input', function() {
    const color = this.value.toUpperCase();
    saveAccentColor(color);
  });
}

// Color preset click events
colorPresets.forEach(preset => {
  preset.addEventListener('click', function() {
    const color = this.dataset.color;
    saveAccentColor(color);
    flashSavedRow(this.closest('.settings-row'));
  });
});

// Re-apply accent color when dark mode changes
const originalApplyDarkMode = applyDarkModeSetting;
applyDarkModeSetting = function() {
  originalApplyDarkMode();
  // Use the shared function from accentColor.js
  loadAndApplyAccentColor();
  // Update the UI to reflect the current color
  chrome.storage.local.get(['accentColor'], (result) => {
    const color = result.accentColor || DEFAULT_ACCENT_COLOR;
    updateColorPickerUI(color);
  });
};

// ------------------------------------------------
// 6) Clipboard Functionality with Fallbacks
// ------------------------------------------------
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

// ------------------------------------------------
// 7) Export Functionality
// ------------------------------------------------
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

function generatePlainTextExport(sessions) {
  let output = "";
  sessions.forEach(session => {
    const title = session.customName || new Date(session.timestamp).toLocaleString();
    output += "Session: " + title + "\n";
    session.tabs.forEach(tab => {
      output += tab.title + "\t" + tab.url + "\n";
    });
    output += "\n";
  });
  return output;
}

function generateMarkdownExport(sessions) {
  let output = "";
  sessions.forEach(session => {
    const title = session.customName || new Date(session.timestamp).toLocaleString();
    output += "### " + title + "\n\n";
    session.tabs.forEach(tab => {
      output += "- [" + (tab.title || tab.url) + "](" + tab.url + ")\n";
    });
    output += "\n";
  });
  return output;
}

function generateHTMLExport(sessions) {
  let body = "";
  sessions.forEach(session => {
    const title = session.customName || new Date(session.timestamp).toLocaleString();
    body += "<h3>" + title + "</h3>\n<ul>\n";
    session.tabs.forEach(tab => {
      body += "<li><a href=\"" + tab.url + "\">" + (tab.title || tab.url) + "</a></li>\n";
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

exportButton?.addEventListener('click', () => {
  chrome.storage.local.get(["savedSessions"], (result) => {
    let sessions = result.savedSessions || [];
    if (!sessions || sessions.length === 0) {
      alert(getMessage("noSavedLinksToExport"));
      return;
    }
    const format = exportFormatSelect.value;
    let exportText = "";
    let mimeType = "text/plain";
    let fileExtension = "txt";
    
    switch (format) {
      case "clipboard":
        exportText = generatePlainTextExport(sessions);
        // Try multiple clipboard methods for better compatibility
        copyToClipboard(exportText)
          .then(() => {
            // Temporarily change button text to show success
            const originalText = exportButton.textContent;
            exportButton.textContent = getMessage("copiedToClipboard") || "Copied!";
            exportButton.disabled = true;
            setTimeout(() => {
              exportButton.textContent = originalText;
              exportButton.disabled = false;
            }, 2000);
          })
          .catch(err => {
            debug('Failed to copy to clipboard:', err);
            alert(getMessage("clipboardError") || "Failed to copy to clipboard");
          });
        return; // Exit early for clipboard option
      case "plain":
        exportText = generatePlainTextExport(sessions);
        fileExtension = "txt";
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
    const blob = new Blob([exportText], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    
    // Generate date string in YYYYMMDD format
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const dateString = `${year}${month}${day}`;
    
    a.download = `tabstract-export-${dateString}.${fileExtension}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });
});

// ------------------------------------------------
// 8) Import Functionality
// ------------------------------------------------
// Helper to detect JSON-based formats and import accordingly.
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

importButton?.addEventListener('click', (e) => {
  e.preventDefault();
  if (!importFileInput.files || importFileInput.files.length === 0) {
    alert(getMessage("selectFileToImport"));
    return;
  }
  const file = importFileInput.files[0];
  const reader = new FileReader();
  reader.onload = (ev) => {
    try {
      // Show loading indicator
      importButton.disabled = true;
      importButton.textContent = getMessage("importing") || "Importing...";

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
      } else if (extension === "md") {
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
        alert(getMessage("unrecognizedFileFormat"));
      }
    } catch (error) {
      debug('[Tabstract Import] Import failed:', error);
      alert((getMessage('importFailedPrefix') || 'Import failed: ') + error.message);
    } finally {
      // Reset button
      importButton.disabled = false;
      importButton.textContent = getMessage("import") || "Import";
    }
  };
  reader.readAsText(file);
});

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
    alert(getMessage("errorParsingJson", [e.message]));
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
    alert(getMessage("errorParsingJson", [e.message]));
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
    alert(getMessage("errorParsingJson", [e.message]));
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

// ------------------------------------------------
// Title Fetching Utilities
// ------------------------------------------------

/**
 * Fetches the page title for a given URL
 * @param {string} url - The URL to fetch the title from
 * @returns {Promise<string|null>} The page title or null if fetch failed
 */
async function fetchPageTitle(url) {
  debug('[Tabstract Import] Fetching title for:', url);
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

    debug('[Tabstract Import] Response status for', url, ':', response.status);

    // Reject error status codes - these often have generic/unhelpful titles
    if (!response.ok || response.status >= 400) {
      debug('[Tabstract Import] Rejected due to status code:', response.status);
      return null;
    }

    // Also reject redirects that might have changed the URL significantly
    if (response.status >= 300 && response.status < 400) {
      debug('[Tabstract Import] Rejected due to redirect');
      return null;
    }

    const html = await response.text();
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);

    if (titleMatch && titleMatch[1]) {
      // Decode HTML entities and clean up
      const title = titleMatch[1]
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .trim();

      debug('[Tabstract Import] Found title for', url, ':', title);
      return title || null;
    }

    debug('[Tabstract Import] No title tag found for', url);
    return null;
  } catch (error) {
    // Failed to fetch - could be CORS, timeout, network error, etc.
    debug('[Tabstract Import] Fetch error for', url, ':', error.message);
    return null;
  }
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
    });
  });
}

// ------------------------------------------------
// iCloud Sync Handlers
// ------------------------------------------------

function toggleSyncUI(enabled) {
  if (syncStatusRow) syncStatusRow.style.display = enabled ? '' : 'none';
  if (syncErrorRow) syncErrorRow.style.display = 'none';
}

function refreshSyncStatus() {
  chrome.runtime.sendMessage({ action: "getSyncStatus" }, (response) => {
    if (chrome.runtime.lastError || !response) return;

    // Update last synced text
    if (response.lastSyncTime) {
      const date = new Date(response.lastSyncTime);
      const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const dateStr = date.toLocaleDateString();
      const now = new Date();
      const isToday = date.toDateString() === now.toDateString();
      if (syncStatusText) {
        const label = chrome.i18n.getMessage("lastSynced") || "Last synced";
        syncStatusText.textContent = `${label}: ${isToday ? timeStr : dateStr + ' ' + timeStr}`;
      }
    } else {
      if (syncStatusText) {
        syncStatusText.textContent = chrome.i18n.getMessage("neverSynced") || "Never synced";
      }
    }

    // Show account error in place of Sync Now link
    const noAccount = response.enabled && (response.accountStatus === 'noAccount' || response.accountStatus === 'restricted');
    if (noAccount) {
      if (syncNowBtn) { syncNowBtn.style.display = 'none'; }
      if (icloudSyncToggle) { icloudSyncToggle.disabled = true; }
      if (syncStatusText) {
        syncStatusText.textContent = chrome.i18n.getMessage("syncNoAccount") || "Sign in to iCloud to sync";
      }
      if (syncErrorRow) syncErrorRow.style.display = 'none';
    } else {
      if (syncNowBtn) { syncNowBtn.style.display = ''; }
      if (icloudSyncToggle) { icloudSyncToggle.disabled = false; }
      if (response.lastError) {
        if (syncErrorRow) syncErrorRow.style.display = '';
        if (syncErrorText) {
          syncErrorText.textContent = getSyncErrorMessage(response.lastError);
        }
      } else {
        if (syncErrorRow) syncErrorRow.style.display = 'none';
      }
    }
  });
}

function getSyncErrorMessage(errorCode) {
  const messages = {
    notAuthenticated: chrome.i18n.getMessage("syncErrorNotAuthenticated") || "Sign in to iCloud to sync",
    networkUnavailable: chrome.i18n.getMessage("syncErrorNetwork") || "No network connection",
    quotaExceeded: chrome.i18n.getMessage("syncErrorQuota") || "iCloud storage is full",
    rateLimited: chrome.i18n.getMessage("syncErrorRateLimited") || "Too many requests, try again later",
    zoneBusy: chrome.i18n.getMessage("syncErrorZoneBusy") || "iCloud is busy, try again later"
  };
  return messages[errorCode] || (chrome.i18n.getMessage("syncErrorGeneric") || "Sync error, will retry automatically");
}

// Toggle handler
if (icloudSyncToggle) {
  icloudSyncToggle.addEventListener('change', () => {
    const enabled = icloudSyncToggle.checked;
    const action = enabled ? "enableSync" : "disableSync";

    // Disable toggle and show loading state during operation
    icloudSyncToggle.disabled = true;
    if (enabled) {
      if (syncStatusRow) syncStatusRow.style.display = '';
      if (syncStatusText) syncStatusText.textContent = chrome.i18n.getMessage("syncing") || "Syncing...";
      if (syncNowBtn) { syncNowBtn.classList.add('syncing'); syncNowBtn.textContent = chrome.i18n.getMessage("syncing") || "Syncing..."; }
    }

    chrome.runtime.sendMessage({ action }, (response) => {
      icloudSyncToggle.disabled = false;
      if (syncNowBtn) { syncNowBtn.classList.remove('syncing'); syncNowBtn.textContent = chrome.i18n.getMessage("syncNow") || "Sync Now"; }

      if (response && response.success) {
        toggleSyncUI(enabled);
        if (enabled) {
          refreshSyncStatus();
        }
      } else {
        // Revert toggle on failure
        icloudSyncToggle.checked = !enabled;
        toggleSyncUI(!enabled);
        // Show error
        if (response?.error === 'noAccount') {
          if (syncErrorRow) syncErrorRow.style.display = '';
          if (syncErrorText) {
            syncErrorText.textContent = chrome.i18n.getMessage("syncNoAccount") || "Sign in to iCloud to sync";
          }
        }
      }
    });
  });
}

// Sync Now link handler
if (syncNowBtn) {
  syncNowBtn.addEventListener('click', (e) => {
    e.preventDefault();
    if (syncNowBtn.classList.contains('syncing')) return;

    // Show syncing state immediately
    syncNowBtn.classList.add('syncing');
    syncNowBtn.textContent = chrome.i18n.getMessage("syncing") || "Syncing...";

    chrome.runtime.sendMessage({ action: "triggerSync" }, (response) => {
      // Brief "Synced!" confirmation before reverting
      syncNowBtn.classList.remove('syncing');
      syncNowBtn.classList.add('synced');
      syncNowBtn.textContent = chrome.i18n.getMessage("synced") || "Synced!";
      setTimeout(() => {
        syncNowBtn.classList.remove('synced');
        syncNowBtn.textContent = chrome.i18n.getMessage("syncNow") || "Sync Now";
      }, 1500);
      refreshSyncStatus();
    });
  });
}
