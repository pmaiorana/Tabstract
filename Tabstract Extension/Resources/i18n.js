// =============================
// Custom i18n System
// =============================

// Load custom messages if user has set a language preference
let customMessages = null;
let effectiveLanguage = null;

(function initializeI18n() {
  const preferredLang = localStorage.getItem('preferredLanguage');
  const browserLang = chrome.i18n.getUILanguage() || 'en';

  // Determine which language to use
  if (preferredLang && preferredLang !== 'auto') {
    effectiveLanguage = preferredLang;
  } else {
    effectiveLanguage = browserLang;
  }

  // Load custom messages if different from browser language
  if (effectiveLanguage !== browserLang) {
    customMessages = loadMessagesSync(effectiveLanguage);
  }

  // Set the HTML lang attribute to match the effective language
  // Only set if not already set by preload.js to avoid flashing
  if (document.documentElement && !document.documentElement.hasAttribute('lang')) {
    document.documentElement.setAttribute('lang', effectiveLanguage);
  }
})();

/**
 * Load messages.json synchronously for a specific language
 */
function loadMessagesSync(lang) {
  try {
    const url = chrome.runtime.getURL(`_locales/${lang}/messages.json`);
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url, false); // Synchronous
    xhr.send();

    if (xhr.status === 200) {
      return JSON.parse(xhr.responseText);
    }
  } catch (error) {
    // Silent — falls back to English or chrome.i18n.getMessage
  }

  // Fallback to English if failed
  if (lang !== 'en') {
    try {
      const url = chrome.runtime.getURL('_locales/en/messages.json');
      const xhr = new XMLHttpRequest();
      xhr.open('GET', url, false);
      xhr.send();

      if (xhr.status === 200) {
        return JSON.parse(xhr.responseText);
      }
    } catch (error) {
      // Silent — getMessage() will return empty string
    }
  }

  return null;
}

/**
 * Get a localized message
 * This is our custom API that replaces chrome.i18n.getMessage calls
 */
window.getMessage = function(key, substitutions) {
  let message = null;

  // Try custom messages first
  if (customMessages && customMessages[key]) {
    message = customMessages[key].message;
  } else {
    // Fallback to browser's i18n
    message = chrome.i18n.getMessage(key, substitutions);
    if (message) return message;
  }

  // Handle placeholder substitutions
  if (message && substitutions) {
    const subs = Array.isArray(substitutions) ? substitutions : [substitutions];
    subs.forEach((sub, index) => {
      message = message.replace(new RegExp('\\$' + (index + 1), 'g'), sub);
    });
  }

  return message || '';
};

/**
 * Get the effective language being used
 */
window.getEffectiveLanguage = function() {
  return effectiveLanguage || chrome.i18n.getUILanguage() || 'en';
};

/**
 * Get the locale for date/time formatting
 */
window.getEffectiveLocale = function() {
  return getEffectiveLanguage();
};

/**
 * Apply internationalization to all elements with data-i18n attributes
 */
window.applyInternationalization = function applyInternationalization() {
  // Text content internationalization
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    const message = getMessage(key);
    if (message) {
      el.textContent = message;
    }
  });

  // Elements that need HTML
  document.querySelectorAll('[data-i18n-html]').forEach(el => {
    const key = el.getAttribute('data-i18n-html');
    const message = getMessage(key);
    if (message) {
      el.innerHTML = message;
    }
  });

  // Placeholder internationalization
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const key = el.getAttribute('data-i18n-placeholder');
    const message = getMessage(key);
    if (message) {
      el.placeholder = message;
    }
  });

  // Title (tooltip) internationalization
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    const key = el.getAttribute('data-i18n-title');
    const message = getMessage(key);
    if (message) {
      el.title = message;
      // Also set aria-label for accessibility if not already set
      if (!el.hasAttribute('data-i18n-aria') && !el.getAttribute('aria-label')) {
        el.setAttribute('aria-label', message);
      }
    }
  });

  // ARIA label internationalization (for elements with explicit aria label keys)
  document.querySelectorAll('[data-i18n-aria]').forEach(el => {
    const key = el.getAttribute('data-i18n-aria');
    const message = getMessage(key);
    if (message) {
      el.setAttribute('aria-label', message);
    }
  });
}

// Auto-apply translations as soon as DOM is ready
// This runs before any page-specific scripts, eliminating the flash
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', applyInternationalization, { once: true });
} else {
  // DOM already loaded
  applyInternationalization();
}

// Also ensure settings are initialized (but don't wait for it to translate)
document.addEventListener('DOMContentLoaded', () => {
  chrome.runtime.sendMessage({ action: "ensureDefaultSettings" });
});
