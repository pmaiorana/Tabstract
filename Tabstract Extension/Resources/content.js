//
//  content.js
//  Tabstract
//
//  Content script for extracting page metadata
//

(function() {
  'use strict';

  // Debug Logging Helper
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
      console.log('[Tabstract Content]', ...args);
    }
  }

  // Signal that content script is loaded
  debug('Content script loaded on:', window.location.hostname);

  /**
   * Extract description metadata from the page
   * Tries og:description first, then falls back to standard meta description
   * @returns {string|null} The description content, or null if not found
   */
  function getDescription() {
    try {
      // Try og:description first (more specific, often better quality)
      const ogDesc = document.querySelector('meta[property="og:description"]');
      if (ogDesc && ogDesc.content && ogDesc.content.trim()) {
        const description = ogDesc.content.trim();
        return description.length > 200 ? description.substring(0, 197) + '...' : description;
      }

      // Fall back to standard meta description
      const metaDesc = document.querySelector('meta[name="description"]');
      if (metaDesc && metaDesc.content && metaDesc.content.trim()) {
        const description = metaDesc.content.trim();
        return description.length > 200 ? description.substring(0, 197) + '...' : description;
      }

      return null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Extract all relevant metadata from the page
   * @returns {Object} Metadata object with available fields
   */
  function extractMetadata() {
    return {
      ogDescription: getDescription(),
      // Future: could add og:type, og:site_name, etc.
    };
  }

  // Listen for metadata requests from background script
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    debug('Received message:', request.action);
    if (request.action === "getMetadata") {
      const metadata = extractMetadata();
      debug('Metadata result:', {
        url: window.location.hostname,
        hasDescription: !!metadata.ogDescription,
        description: metadata.ogDescription ? metadata.ogDescription.substring(0, 100) : 'null'
      });
      sendResponse(metadata);
      return true; // Keep message channel open for async response
    }
  });

  // Send metadata proactively when page loads to cache before content script is killed
  if (document.readyState === 'complete') {
    chrome.runtime.sendMessage({
      action: "pageMetadata",
      metadata: extractMetadata(),
      url: window.location.href
    });
  } else {
    window.addEventListener('load', () => {
      chrome.runtime.sendMessage({
        action: "pageMetadata",
        metadata: extractMetadata(),
        url: window.location.href
      });
    });
  }
})();
