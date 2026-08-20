/**
 * accentColor.js
 * Shared module for applying custom accent colors across all Tabstract pages
 */

const DEFAULT_ACCENT_COLOR = '#007AFF';

/**
 * Convert hex color to RGB object
 */
function hexToRgb(hex) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16)
  } : null;
}

/**
 * Convert RGB to hex color
 */
function rgbToHex(r, g, b) {
  return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1).toUpperCase();
}

/**
 * Adjust color brightness
 * factor > 1 makes it lighter, factor < 1 makes it darker
 */
function adjustBrightness(hex, factor) {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;

  const r = Math.min(255, Math.max(0, Math.round(rgb.r * factor)));
  const g = Math.min(255, Math.max(0, Math.round(rgb.g * factor)));
  const b = Math.min(255, Math.max(0, Math.round(rgb.b * factor)));

  return rgbToHex(r, g, b);
}

/**
 * Calculate the relative luminance of a color
 * Uses the WCAG formula for perceived brightness
 */
function getRelativeLuminance(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0.5; // fallback to middle value

  // Convert RGB to sRGB
  const rsRGB = rgb.r / 255;
  const gsRGB = rgb.g / 255;
  const bsRGB = rgb.b / 255;

  // Apply gamma correction
  const r = rsRGB <= 0.03928 ? rsRGB / 12.92 : Math.pow((rsRGB + 0.055) / 1.055, 2.4);
  const g = gsRGB <= 0.03928 ? gsRGB / 12.92 : Math.pow((gsRGB + 0.055) / 1.055, 2.4);
  const b = bsRGB <= 0.03928 ? bsRGB / 12.92 : Math.pow((bsRGB + 0.055) / 1.055, 2.4);

  // Calculate relative luminance
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Determine if a color is light or dark
 * Returns true if the color is light (needs dark text)
 */
function isLightColor(hex) {
  const luminance = getRelativeLuminance(hex);
  // Threshold of 0.5 works well for most cases
  // Colors with luminance > 0.5 are considered light
  return luminance > 0.5;
}

/**
 * Determine if dark mode is active (checking both body class and system preference)
 */
function isDarkModeActive() {
  // Check if dark-mode class is on body
  if (document.documentElement.classList.contains('dark-mode')) {
    return true;
  }

  // Fallback: check system preference
  if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
    return true;
  }

  return false;
}

/**
 * Apply accent color to the current page
 */
function applyAccentColor(color) {
  if (!color) color = DEFAULT_ACCENT_COLOR;

  const isDark = isDarkModeActive();

  // Calculate variations
  let hoverColor, pressedColor, outlineColor30, outlineColor50, actionBgColor;

  if (isDark) {
    // For dark mode, make colors lighter for hover/active states
    hoverColor = adjustBrightness(color, 1.4);
    pressedColor = adjustBrightness(color, 1.2);
  } else {
    // For light mode, make colors darker for hover/active states
    hoverColor = adjustBrightness(color, 0.75);
    pressedColor = adjustBrightness(color, 0.6);
  }

  // Calculate semi-transparent versions for outlines and backgrounds
  const rgb = hexToRgb(color);
  if (rgb) {
    outlineColor30 = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.3)`;
    outlineColor50 = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.5)`;
    actionBgColor = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${isDark ? 0.2 : 0.1})`;
  }

  // Calculate appropriate text color for accessibility with tinting
  let textOnAccent;
  if (isLightColor(color)) {
    // For light backgrounds, use a darker version of the accent color for text
    // Use 40% of the accent color brightness for a balanced tint
    const tintedDark = hexToRgb(color);
    if (tintedDark) {
      const r = Math.round(tintedDark.r * 0.4);
      const g = Math.round(tintedDark.g * 0.4);
      const b = Math.round(tintedDark.b * 0.4);
      textOnAccent = rgbToHex(r, g, b);
    } else {
      textOnAccent = '#000000';
    }
  } else {
    // For dark backgrounds, blend the accent color with white for a tinted light text
    // Mix 90% white with 10% of the accent color for a subtle tint
    const tintedLight = hexToRgb(color);
    if (tintedLight) {
      const r = Math.round(255 - (255 - tintedLight.r) * 0.1);
      const g = Math.round(255 - (255 - tintedLight.g) * 0.1);
      const b = Math.round(255 - (255 - tintedLight.b) * 0.1);
      textOnAccent = rgbToHex(r, g, b);
    } else {
      textOnAccent = '#FFFFFF';
    }
  }

  // Apply CSS custom properties directly on body element for higher specificity
  document.body.style.setProperty('--info', color);
  document.body.style.setProperty('--info-hover', hoverColor);
  document.body.style.setProperty('--info-pressed', pressedColor);
  document.body.style.setProperty('--border-accent', color);
  document.body.style.setProperty('--text-on-accent', textOnAccent);

  if (outlineColor30 && outlineColor50 && actionBgColor) {
    document.body.style.setProperty('--info-outline-30', outlineColor30);
    document.body.style.setProperty('--info-outline-50', outlineColor50);
    document.body.style.setProperty('--info-action-bg', actionBgColor);
  }
}

/**
 * Load accent color from storage and apply it
 * Also checks dark mode setting to ensure correct color variations
 */
function loadAndApplyAccentColor() {
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    // Get both accent color and dark mode setting from storage
    chrome.storage.local.get(['accentColor', 'darkMode'], (result) => {
      const color = result.accentColor || DEFAULT_ACCENT_COLOR;
      const darkModeSetting = result.darkMode || 'Auto';

      // Sync to localStorage for instant access on next page load
      localStorage.setItem('tabstract_accentColor', color);

      // Determine if dark mode should be active
      let shouldBeDark = false;
      if (darkModeSetting === 'Dark') {
        shouldBeDark = true;
      } else if (darkModeSetting === 'Light') {
        shouldBeDark = false;
      } else {
        // Auto mode - check system preference
        shouldBeDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
      }

      // Temporarily set html class if it's not set yet (for initial load)
      const htmlHadDarkClass = document.documentElement.classList.contains('dark-mode');
      if (shouldBeDark && !htmlHadDarkClass) {
        document.documentElement.classList.add('dark-mode');
      } else if (!shouldBeDark && htmlHadDarkClass) {
        document.documentElement.classList.remove('dark-mode');
      }

      // Now apply the accent color
      applyAccentColor(color);
    });
  } else {
    // Fallback to default if chrome storage is not available
    applyAccentColor(DEFAULT_ACCENT_COLOR);
  }
}

// Auto-load accent color when this script is included
// Now that we check storage directly, we don't need complex timing logic
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', loadAndApplyAccentColor);
} else {
  loadAndApplyAccentColor();
}

// Listen for accent color changes and dark mode changes
if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local') {
      // Re-apply if accent color or dark mode changed
      if (changes.accentColor || changes.darkMode) {
        loadAndApplyAccentColor();
      }
    }
  });
}

// Listen for system dark mode changes (when user has "Auto" selected)
if (typeof window !== 'undefined' && window.matchMedia) {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    // Re-apply accent color to recalculate variations for new mode
    loadAndApplyAccentColor();
  });
}
