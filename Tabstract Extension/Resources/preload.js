// CRITICAL: This script must load BEFORE CSS to prevent flash
// Applies dark mode, accent color, and language synchronously from localStorage

(function() {
  // 1. Apply dark mode
  const darkMode = localStorage.getItem('tabstract_darkMode') || 'Auto';
  const isDark = darkMode === 'Dark' ||
                (darkMode === 'Auto' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);

  if (isDark) {
    document.documentElement.classList.add('dark-mode');
  }

  // 2. Apply language attribute
  const preferredLang = localStorage.getItem('preferredLanguage');
  if (preferredLang && preferredLang !== 'auto') {
    document.documentElement.setAttribute('lang', preferredLang);
  }

  // 2. Apply accent color
  const accentColor = localStorage.getItem('tabstract_accentColor');
  if (accentColor && accentColor !== '#007AFF') {
    // Create inline style to override CSS variables immediately
    const style = document.createElement('style');
    style.id = 'preload-accent-color';

    // Calculate hover/pressed variants
    const rgb = hexToRgb(accentColor);
    let hoverColor, pressedColor, outlineColor30, outlineColor50, actionBgColor;

    if (isDark) {
      hoverColor = adjustBrightness(accentColor, 1.4);
      pressedColor = adjustBrightness(accentColor, 1.2);
    } else {
      hoverColor = adjustBrightness(accentColor, 0.75);
      pressedColor = adjustBrightness(accentColor, 0.6);
    }

    if (rgb) {
      outlineColor30 = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.3)`;
      outlineColor50 = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.5)`;
      actionBgColor = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${isDark ? 0.2 : 0.1})`;
    }

    // Calculate text-on-accent color
    const textOnAccent = isLightColor(accentColor) ?
      rgbToHex(Math.round(rgb.r * 0.4), Math.round(rgb.g * 0.4), Math.round(rgb.b * 0.4)) :
      rgbToHex(Math.round(255 - (255 - rgb.r) * 0.1), Math.round(255 - (255 - rgb.g) * 0.1), Math.round(255 - (255 - rgb.b) * 0.1));

    style.textContent = `
      :root {
        --info: ${accentColor} !important;
        --info-hover: ${hoverColor} !important;
        --info-pressed: ${pressedColor} !important;
        --border-accent: ${accentColor} !important;
        --text-on-accent: ${textOnAccent} !important;
        ${outlineColor30 ? `--info-outline-30: ${outlineColor30} !important;` : ''}
        ${outlineColor50 ? `--info-outline-50: ${outlineColor50} !important;` : ''}
        ${actionBgColor ? `--info-action-bg: ${actionBgColor} !important;` : ''}
      }
    `;

    document.head.appendChild(style);
  }

  // Helper functions for accent color calculations
  function hexToRgb(hex) {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? {
      r: parseInt(result[1], 16),
      g: parseInt(result[2], 16),
      b: parseInt(result[3], 16)
    } : null;
  }

  function rgbToHex(r, g, b) {
    return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1).toUpperCase();
  }

  function adjustBrightness(hex, factor) {
    const rgb = hexToRgb(hex);
    if (!rgb) return hex;
    const r = Math.min(255, Math.max(0, Math.round(rgb.r * factor)));
    const g = Math.min(255, Math.max(0, Math.round(rgb.g * factor)));
    const b = Math.min(255, Math.max(0, Math.round(rgb.b * factor)));
    return rgbToHex(r, g, b);
  }

  function getRelativeLuminance(hex) {
    const rgb = hexToRgb(hex);
    if (!rgb) return 0.5;
    const rsRGB = rgb.r / 255;
    const gsRGB = rgb.g / 255;
    const bsRGB = rgb.b / 255;
    const r = rsRGB <= 0.03928 ? rsRGB / 12.92 : Math.pow((rsRGB + 0.055) / 1.055, 2.4);
    const g = gsRGB <= 0.03928 ? gsRGB / 12.92 : Math.pow((gsRGB + 0.055) / 1.055, 2.4);
    const b = bsRGB <= 0.03928 ? bsRGB / 12.92 : Math.pow((bsRGB + 0.055) / 1.055, 2.4);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  function isLightColor(hex) {
    return getRelativeLuminance(hex) > 0.5;
  }
})();
