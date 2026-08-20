//
//  help.js
//  Tabstract
//
//  Created by Paul Maiorana on 3/25/25.
//

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
  }
}

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

// Support / Debug UI
const downloadReportButton = document.getElementById('downloadReportButton');
const emailSupportButton = document.getElementById('emailSupportButton');
const importDataButton = document.getElementById('importDataButton');
const importFileInput = document.getElementById('importFileInput');
const clearDataButton = document.getElementById('clearDataButton');
const backupNowButton = document.getElementById('backupNowButton');
const backupListContainer = document.getElementById('backupListContainer');
const lastBackupTimeEl = document.getElementById('lastBackupTime');

// Global delegated handlers for backup action menus (avoids per-item document listeners)
function closeAllBackupMenus() {
  document.querySelectorAll('.backup-actions-menu.show').forEach((m) => {
    m.classList.remove('show');
    m.style.top = '';
    m.style.right = '';
    const btn = m.previousElementSibling;
    if (btn) btn.setAttribute('aria-expanded', 'false');
  });
  document.body.classList.remove('backup-menu-open');
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('.backup-actions-menu-container')) closeAllBackupMenus();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeAllBackupMenus();
});
// Close menus on scroll since they're fixed-positioned
document.addEventListener('scroll', closeAllBackupMenus, true);

// ------------------------------------------------
// 2) On Page Load, Re-Enforce Default Settings
// ------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  applyDarkModeSetting();
  updateGuideImages();
  initializeGuideVideos();
  initGuideSlider();
  loadLastBackupTime();
  loadBackupList();
});

// Re-apply dark mode automatically if system theme changes while in Auto mode
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  chrome.storage.local.get('darkMode', (result) => {
    if ((result.darkMode || 'Auto') === 'Auto') {
      applyDarkModeSetting();
      updateGuideImages();
    }
  });
});

// ------------------------------------------------
// 4) Helper Functions
// ------------------------------------------------
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
    // Update guide images after dark mode is applied
    updateGuideImages();
  });
}

function flashSavedRow(rowElement) {
  if (!rowElement) return;
  rowElement.classList.add("flash-saved-subtle");
  setTimeout(() => rowElement.classList.remove("flash-saved-subtle"), 300);
}

// ------------------------------------------------
// Backup UI Functions
// ------------------------------------------------

function loadLastBackupTime() {
  chrome.storage.local.get(['lastBackupTimestamp'], (result) => {
    if (!lastBackupTimeEl) return;
    if (result.lastBackupTimestamp) {
      const date = new Date(result.lastBackupTimestamp);
      lastBackupTimeEl.textContent = (getMessage("lastBackup") || "Last backup:") + " " + formatBackupDate(date);
    } else {
      lastBackupTimeEl.textContent = (getMessage("lastBackup") || "Last backup:") + " —";
    }
  });
}

function formatBackupDate(date) {
  const now = new Date();
  const diff = now - date;
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const locale = getEffectiveLocale();
  const timeStr = date.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });

  if (mins < 1) return getMessage("justNow") || "Just now";
  if (mins === 1) return getMessage("minuteAgo", ["1"]) || "1 minute ago";
  if (mins < 60) return getMessage("minutesAgo", [String(mins)]) || `${mins} minutes ago`;
  if (hours < 2) return getMessage("hourAgo", ["1"]) || "1 hour ago";
  if (hours < 12) return getMessage("hoursAgo", [String(hours)]) || `${hours} hours ago`;

  // Check if same calendar day
  const isToday = date.toDateString() === now.toDateString();
  if (isToday) return getMessage("todayAt", [timeStr]) || `Today, ${timeStr}`;

  // Check if yesterday
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return getMessage("yesterdayAt", [timeStr]) || `Yesterday, ${timeStr}`;

  // Within last 7 days — show day name
  if (diff < 7 * 86400000) {
    const dayName = date.toLocaleDateString(locale, { weekday: 'long' });
    return `${dayName}, ${timeStr}`;
  }

  return date.toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric' });
}

function loadBackupList() {
  if (!backupListContainer) return;
  backupListContainer.innerHTML = `<p class="backup-loading">${getMessage("loadingBackups") || "Loading backups..."}</p>`;

  chrome.runtime.sendMessage({ action: "listBackups" }, (response) => {
    if (chrome.runtime.lastError || !response || !response.success) {
      backupListContainer.innerHTML = `<p class="backup-loading">${getMessage("backupLoadError") || "Failed to load backups."}</p>`;
      return;
    }

    const backups = response.backups || [];
    if (backups.length === 0) {
      backupListContainer.innerHTML = `<p class="backup-loading">${getMessage("noBackupsYet") || "No backups yet"}</p>`;
      return;
    }

    backupListContainer.innerHTML = '';
    backups.forEach((backup) => {
      const item = createBackupItem(backup);
      backupListContainer.appendChild(item);
    });
  });
}

function createBackupItem(backup) {
  const item = document.createElement('div');
  item.className = 'backup-item';
  item.dataset.filename = backup.filename;

  const header = document.createElement('div');
  header.className = 'backup-item-header';

  const dateEl = document.createElement('span');
  dateEl.className = 'backup-date';
  const date = new Date(backup.timestamp);
  dateEl.textContent = formatBackupDate(date);
  dateEl.title = date.toLocaleString(getEffectiveLocale());

  header.appendChild(dateEl);

  const summary = backup.summary;
  if (summary && summary.tabCount) {
    const summaryEl = document.createElement('span');
    summaryEl.className = 'backup-summary';
    summaryEl.textContent = getMessage("backupTabCount", [String(summary.tabCount)]) || `${summary.tabCount} tabs`;
    header.appendChild(summaryEl);
  }

  if (backup.trigger === 'manual') {
    const badge = document.createElement('span');
    badge.className = 'backup-trigger-badge backup-trigger-manual';
    badge.textContent = getMessage("backupManualBadge") || "Manual";
    header.appendChild(badge);
  } else if (backup.trigger === 'pre-restore') {
    const badge = document.createElement('span');
    badge.className = 'backup-trigger-badge backup-trigger-pre-restore';
    badge.textContent = getMessage("backupPreRestoreBadge") || "Pre-Restore";
    header.appendChild(badge);
  }

  if (backup.label) {
    const labelEl = document.createElement('span');
    labelEl.className = 'backup-label';
    labelEl.textContent = backup.label;
    header.appendChild(labelEl);
  }

  // Actions dropdown menu (in header, far right)
  const menuContainer = document.createElement('div');
  menuContainer.className = 'backup-actions-menu-container';

  const menuBtn = document.createElement('button');
  menuBtn.className = 'backup-actions-menu-btn';
  menuBtn.setAttribute('aria-label', getMessage('backupActionsLabel') || 'Backup actions');
  menuBtn.setAttribute('aria-expanded', 'false');
  menuBtn.setAttribute('aria-haspopup', 'true');
  menuBtn.innerHTML = `
    <svg viewBox="0 0 32.4375 8.10938" aria-hidden="true">
      <path d="M28.0156 8.09375C30.25 8.09375 32.0625 6.26562 32.0625 4.04688C32.0625 1.8125 30.25 0 28.0156 0C25.7969 0 23.9688 1.8125 23.9688 4.04688C23.9688 6.26562 25.7969 8.09375 28.0156 8.09375Z" fill="currentColor"/>
      <path d="M16.0312 8.09375C18.2656 8.09375 20.0781 6.26562 20.0781 4.04688C20.0781 1.8125 18.2656 0 16.0312 0C13.7969 0 11.9844 1.8125 11.9844 4.04688C11.9844 6.26562 13.7969 8.09375 16.0312 8.09375Z" fill="currentColor"/>
      <path d="M4.04688 8.09375C6.26562 8.09375 8.09375 6.26562 8.09375 4.04688C8.09375 1.8125 6.26562 0 4.04688 0C1.8125 0 0 1.8125 0 4.04688C0 6.26562 1.8125 8.09375 4.04688 8.09375Z" fill="currentColor"/>
    </svg>
  `;

  const menu = document.createElement('div');
  menu.className = 'backup-actions-menu';
  menu.setAttribute('role', 'menu');

  const menuItems = [
    {
      label: getMessage("backupMenuRestoreReplace") || "Restore Tabs (Replace)",
      icon: '<svg class="backup-actions-menu-icon" viewBox="0 0 151.475 127.295" aria-hidden="true"><g><path d="M4.00886 51.8066C0.00495365 51.8066-1.11809 54.541 1.17683 57.7148L15.044 77.4414C16.8995 80.127 19.585 80.0781 21.3917 77.4414L35.2589 57.666C37.4561 54.541 36.3819 51.8066 32.4268 51.8066ZM139.312 63.623C139.312 28.5156 110.845 0 75.7374 0C40.63 0 12.212 28.4668 12.1632 63.6719C12.212 66.2109 14.2139 68.1641 16.6553 68.1641C19.1456 68.1641 21.2452 66.1621 21.2452 63.623C21.2452 33.4961 45.6104 9.13086 75.7374 9.13086C105.864 9.13086 130.23 33.4961 130.23 63.623C130.23 93.75 105.864 118.115 75.7374 118.115C57.0362 118.115 40.5811 108.643 30.9132 94.3848C29.3018 92.1875 26.7628 91.5039 24.5167 92.8711C22.3682 94.1406 21.7335 97.2168 23.4913 99.6094C34.9659 116.26 53.9112 127.197 75.7374 127.197C110.845 127.197 139.312 98.7305 139.312 63.623Z" fill="currentColor"/><path d="M75.6885 74.9512C78.3253 74.9512 79.8878 73.3887 79.9366 70.5078L80.7178 36.9629C80.7667 34.1309 78.5694 32.0312 75.6397 32.0312C72.6612 32.0312 70.6104 34.082 70.6593 36.9141L71.3917 70.5078C71.4405 73.3398 73.003 74.9512 75.6885 74.9512ZM75.6885 94.8242C79.0577 94.8242 81.8897 92.1387 81.8897 88.8184C81.8897 85.4492 79.1065 82.8125 75.6885 82.8125C72.3194 82.8125 69.5362 85.498 69.5362 88.8184C69.5362 92.0898 72.3682 94.8242 75.6885 94.8242Z" fill="currentColor"/></g></svg>',
      action: () => restoreBackup(backup.filename, 'tabsOnly')
    },
    {
      label: getMessage("backupMenuRestoreMerge") || "Restore Tabs (Merge)",
      icon: '<svg class="backup-actions-menu-icon" viewBox="0 0 127.197 151.555" aria-hidden="true"><g><path d="M75.3906 3.97581C75.3906 0.0207307 72.6562-1.10232 69.4824 1.14378L49.7559 15.011C47.0703 16.9153 47.1191 19.6008 49.7559 21.4074L69.5312 35.2746C72.6562 37.4719 75.3906 36.3977 75.3906 32.4426ZM63.5742 139.327C98.6816 139.327 127.197 110.861 127.197 75.7532C127.197 40.6457 98.7305 12.1789 63.5254 12.1301C60.9863 12.1789 59.0332 14.2297 59.0332 16.6711C59.0332 19.1614 61.0352 21.261 63.5742 21.261C93.7012 21.261 118.066 45.6262 118.066 75.7532C118.066 105.88 93.7012 130.245 63.5742 130.245C33.4473 130.245 9.08203 105.88 9.08203 75.7532C9.08203 57.052 18.5547 40.5969 32.8125 30.9289C35.0098 29.2688 35.6934 26.7297 34.3262 24.4836C33.0566 22.3352 29.9805 21.7004 27.5879 23.4582C10.9375 34.9328 0 53.927 0 75.7532C0 110.861 28.4668 139.327 63.5742 139.327Z" fill="currentColor"/><path d="M68.0664 99.9231L68.0664 51.4367C68.0664 48.7024 66.2109 46.7981 63.5254 46.7981C60.9375 46.7981 59.082 48.7024 59.082 51.4367L59.082 99.9231C59.082 102.609 60.9375 104.513 63.5254 104.513C66.2109 104.513 68.0664 102.657 68.0664 99.9231ZM39.3555 80.1477L87.8906 80.1477C90.5273 80.1477 92.4316 78.341 92.4316 75.7532C92.4316 73.0188 90.5762 71.1633 87.8906 71.1633L39.3555 71.1633C36.6211 71.1633 34.7656 73.0188 34.7656 75.7532C34.7656 78.341 36.6211 80.1477 39.3555 80.1477Z" fill="currentColor"/></g></svg>',
      action: () => restoreBackup(backup.filename, 'tabsMerge')
    },
    { separator: true },
    {
      label: getMessage("backupMenuRestoreSystem") || "Restore System (Full Reset)",
      icon: '<svg class="backup-actions-menu-icon" viewBox="0 0 152.842 127.295" aria-hidden="true"><g><path d="M148.833 54.7852L120.415 54.7852C116.46 54.7852 115.337 57.5195 117.583 60.6445L131.45 80.4199C133.257 83.0566 135.942 83.1055 137.798 80.4199L151.665 60.6934C153.911 57.5195 152.837 54.7852 148.833 54.7852ZM76.421 9.13086C106.548 9.13086 130.913 33.4961 130.913 63.623C130.913 66.0645 132.964 68.1152 135.503 68.1152C137.944 68.1152 139.946 66.1133 139.995 63.6719C139.946 28.4668 111.528 0 76.421 0C57.7198 0 40.63 8.1543 28.96 21.3379C26.7628 23.7305 27.4952 26.8555 29.4971 28.2715C31.255 29.5898 33.5987 29.6387 35.796 27.2949C45.8546 16.0156 60.4053 9.13086 76.421 9.13086ZM4.00886 72.4121L32.4268 72.4121C36.3819 72.4121 37.4561 69.6777 35.2589 66.5527L21.3917 46.7773C19.585 44.1895 16.8995 44.1406 15.044 46.7773L1.17683 66.5039C-1.11809 69.6777 0.00495365 72.4121 4.00886 72.4121ZM76.421 118.115C46.294 118.115 21.9288 93.75 21.9288 63.623C21.9288 61.1328 19.878 59.082 17.3389 59.082C14.8975 59.082 12.8956 61.084 12.8468 63.5742C12.8956 98.7793 41.3135 127.197 76.421 127.197C95.1221 127.197 112.212 119.043 123.882 105.908C126.079 103.467 125.347 100.391 123.345 98.9258C121.587 97.6562 119.243 97.5586 117.046 99.9512C106.987 111.182 92.4366 118.115 76.421 118.115Z" fill="currentColor"/><path d="M76.3721 74.9512C79.0089 74.9512 80.5714 73.3887 80.6202 70.5078L81.4014 36.9629C81.4503 34.1309 79.253 32.0312 76.3233 32.0312C73.3448 32.0312 71.294 34.082 71.3428 36.9141L72.0753 70.5078C72.1241 73.3398 73.6866 74.9512 76.3721 74.9512ZM76.3721 94.8242C79.7413 94.8242 82.5733 92.1387 82.5733 88.8184C82.5733 85.4492 79.7901 82.8125 76.3721 82.8125C73.003 82.8125 70.2198 85.498 70.2198 88.8184C70.2198 92.0898 73.0518 94.8242 76.3721 94.8242Z" fill="currentColor"/></g></svg>',
      action: () => restoreBackup(backup.filename, 'everything')
    },
    { separator: true },
    {
      label: getMessage("exportBackupShowInFinder") || "Show in Finder",
      icon: '<svg class="backup-actions-menu-icon" viewBox="0 0 141.846 114.697" aria-hidden="true"><path d="M18.9941 114.014L124.316 114.014C135.498 114.014 141.846 107.617 141.846 95.2148L141.846 30.4199C141.846 17.9688 135.449 11.6211 122.852 11.6211L62.0605 11.6211C57.4707 11.6211 54.9805 10.6445 51.709 7.8125L47.998 4.6875C43.8477 1.07422 40.8691 0 34.5703 0L16.6504 0C5.95703 0 0 5.9082 0 17.8711L0 95.2148C0 107.666 6.39648 114.014 18.9941 114.014ZM19.1895 105.371C12.3535 105.371 8.64258 101.758 8.64258 94.7266L8.64258 18.4082C8.64258 11.8652 12.0117 8.59375 18.3594 8.59375L32.4219 8.59375C36.9141 8.59375 39.3555 9.57031 42.6758 12.5L46.3867 15.625C50.3906 19.0918 53.6133 20.2637 59.9121 20.2637L122.705 20.2637C129.395 20.2637 133.203 23.877 133.203 30.8594L133.203 94.7754C133.203 101.758 129.395 105.371 122.705 105.371ZM15.625 38.623L126.172 38.623L126.172 35.498C126.172 31.3965 123.975 29.1504 119.336 29.1504L22.4609 29.1504C17.8223 29.1504 15.625 31.3965 15.625 35.498Z" fill="currentColor"/></svg>',
      action: () => showBackupInFinder(backup.filename)
    },
    { separator: true },
    {
      label: getMessage("deleteBackup") || "Delete Backup",
      icon: '<svg class="backup-actions-menu-icon" viewBox="0 0 30.252 37.0259" aria-hidden="true"><g><path d="M10.185 29.7998C9.70156 29.7998 9.39812 29.5083 9.37656 29.0453L8.86422 11.4353C8.85344 10.9734 9.16656 10.6759 9.65594 10.6759C10.1033 10.6759 10.432 10.9627 10.4428 11.41L10.9767 29.0405C10.9875 29.4878 10.6733 29.7998 10.185 29.7998ZM14.9458 29.7998C14.4672 29.7998 14.1373 29.4975 14.1373 29.0405L14.1373 11.4353C14.1373 10.9783 14.4672 10.6759 14.9458 10.6759C15.4244 10.6759 15.765 10.9783 15.765 11.4353L15.765 29.0405C15.765 29.4975 15.4244 29.7998 14.9458 29.7998ZM19.7077 29.8047C19.2242 29.8047 18.91 29.4975 18.9208 29.0453L19.4439 11.4256C19.4547 10.9675 19.7834 10.6808 20.2308 10.6808C20.7202 10.6808 21.0333 10.9783 21.0225 11.4402L20.5102 29.055C20.4886 29.5131 20.1803 29.8047 19.7077 29.8047ZM8.26078 6.78703L10.1736 6.78703L10.1736 3.47235C10.1736 2.4461 10.8713 1.805 11.9734 1.805L17.8869 1.805C18.9939 1.805 19.6916 2.4461 19.6916 3.47235L19.6916 6.78703L21.6044 6.78703L21.6044 3.36938C21.6044 1.26359 20.2422 0 17.9861 0L11.8694 0C9.62297 0 8.26078 1.26359 8.26078 3.36938ZM0.915158 7.74641L28.9823 7.74641C29.4825 7.74641 29.877 7.32547 29.877 6.83016C29.877 6.32516 29.4777 5.91984 28.9823 5.91984L0.915158 5.91984C0.430626 5.91984 0 6.33 0 6.83016C0 7.3411 0.430626 7.74641 0.915158 7.74641ZM7.86219 34.453L22.0305 34.453C24.042 34.453 25.4936 33.058 25.5933 31.0609L26.7645 7.42313L3.12703 7.42313L4.30906 31.0717C4.40875 33.0688 5.83391 34.453 7.86219 34.453Z" fill="currentColor"/></g></svg>',
      danger: true,
      action: () => deleteBackup(backup.filename, item)
    },
  ];

  menuItems.forEach((mi) => {
    if (mi.separator) {
      const hr = document.createElement('hr');
      hr.className = 'backup-actions-menu-separator';
      menu.appendChild(hr);
      return;
    }
    const btn = document.createElement('button');
    btn.className = 'backup-actions-menu-item' + (mi.danger ? ' backup-actions-menu-item-danger' : '');
    btn.setAttribute('role', 'menuitem');
    btn.innerHTML = mi.icon + '<span>' + mi.label + '</span>';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeBackupMenu();
      mi.action();
    });
    menu.appendChild(btn);
  });

  menuContainer.appendChild(menuBtn);
  menuContainer.appendChild(menu);
  header.appendChild(menuContainer);

  // Menu open/close logic
  let menuLeaveTimeout = null;

  function openBackupMenu() {
    // Close any other open backup menus first
    closeAllBackupMenus();
    menu.classList.add('show');
    menuBtn.setAttribute('aria-expanded', 'true');
    document.body.classList.add('backup-menu-open');

    // Position fixed menu relative to button
    const btnRect = menuBtn.getBoundingClientRect();
    menu.style.right = (window.innerWidth - btnRect.right) + 'px';

    // Show below button by default; flip above if it would overflow viewport
    const menuHeight = menu.offsetHeight;
    if (btnRect.bottom + 4 + menuHeight > window.innerHeight) {
      menu.style.top = (btnRect.top - menuHeight - 4) + 'px';
    } else {
      menu.style.top = (btnRect.bottom + 4) + 'px';
    }
  }

  function closeBackupMenu() {
    menu.classList.remove('show');
    menuBtn.setAttribute('aria-expanded', 'false');
    menu.style.top = '';
    menu.style.right = '';
  }

  menuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menu.classList.contains('show')) {
      closeBackupMenu();
    } else {
      openBackupMenu();
      // Focus first menu item for keyboard users
      const firstItem = menu.querySelector('[role="menuitem"]');
      if (firstItem) firstItem.focus();
    }
  });

  // Keyboard navigation for the menu
  menuBtn.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      if (!menu.classList.contains('show')) {
        e.preventDefault();
        e.stopPropagation();
        openBackupMenu();
        const firstItem = menu.querySelector('[role="menuitem"]');
        if (firstItem) firstItem.focus();
      }
    }
  });

  menu.addEventListener('keydown', (e) => {
    const items = Array.from(menu.querySelectorAll('[role="menuitem"]'));
    const idx = items.indexOf(document.activeElement);

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = idx < items.length - 1 ? idx + 1 : 0;
      items[next].focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prev = idx > 0 ? idx - 1 : items.length - 1;
      items[prev].focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeBackupMenu();
      menuBtn.focus();
    } else if (e.key === 'Tab') {
      closeBackupMenu();
    }
  });

  menuContainer.addEventListener('mouseleave', () => {
    menuLeaveTimeout = setTimeout(closeBackupMenu, 600);
  });
  menuContainer.addEventListener('mouseenter', () => {
    if (menuLeaveTimeout) { clearTimeout(menuLeaveTimeout); menuLeaveTimeout = null; }
  });

  // Expandable preview
  const preview = document.createElement('div');
  preview.className = 'backup-item-preview';
  preview.style.display = 'none';

  const previewContent = document.createElement('div');
  previewContent.className = 'backup-preview-content';
  previewContent.textContent = '';

  preview.appendChild(previewContent);

  // Click/keyboard header to toggle expand
  header.setAttribute('tabindex', '0');
  header.setAttribute('role', 'button');
  header.setAttribute('aria-expanded', 'false');
  function togglePreview() {
    const isExpanded = preview.style.display !== 'none';
    if (isExpanded) {
      preview.style.display = 'none';
      item.classList.remove('expanded');
      header.setAttribute('aria-expanded', 'false');
    } else {
      preview.style.display = 'block';
      item.classList.add('expanded');
      header.setAttribute('aria-expanded', 'true');
      // Load preview if not already loaded
      if (!previewContent.dataset.loaded) {
        loadBackupPreview(backup.filename, previewContent);
      }
    }
  }
  header.addEventListener('click', togglePreview);
  header.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target === header) {
      e.preventDefault();
      togglePreview();
    }
  });

  item.appendChild(header);
  item.appendChild(preview);
  return item;
}

function loadBackupPreview(filename, el) {
  el.textContent = '...';
  chrome.runtime.sendMessage({ action: "readBackup", filename }, (response) => {
    if (chrome.runtime.lastError || !response || !response.success) {
      el.textContent = getMessage("backupLoadError") || "Failed to load backup.";
      return;
    }

    const data = response.backup.data || {};
    const sessions = data.savedSessions || [];
    el.innerHTML = '';
    el.dataset.loaded = 'true';

    if (sessions.length === 0) {
      el.textContent = getMessage("noSessions") || "No sessions";
      return;
    }

    const list = document.createElement('ul');
    list.className = 'backup-preview-list';
    sessions.forEach((session) => {
      const li = document.createElement('li');
      li.className = 'backup-preview-session';
      const name = session.customName || session.defaultTitle || (getMessage("untitledSession") || "Untitled Session");
      const tabCount = (session.tabs || []).length;
      li.textContent = `${name} (${tabCount} tabs)`;
      list.appendChild(li);
    });
    el.appendChild(list);
  });
}

function restoreBackup(filename, mode) {
  if (mode === 'everything') {
    const msg = getMessage("confirmRestoreEverything") ||
      "This will replace ALL your current Tabstract data with data from this backup.\n\nA pre-restore backup will be created first.\n\nContinue?";
    if (!confirm(msg)) return;
  } else if (mode === 'tabsOnly') {
    const msg = getMessage("confirmRestoreTabsOnly") ||
      "This will replace only your saved sessions with sessions from this backup.\n\nA pre-restore backup will be created first.\n\nContinue?";
    if (!confirm(msg)) return;
  } else if (mode === 'tabsMerge') {
    const msg = getMessage("confirmRestoreTabsMerge") ||
      "This will merge the backup sessions alongside your existing tabs.\n\nA pre-restore backup will be created first.\n\nContinue?";
    if (!confirm(msg)) return;
  }

  chrome.runtime.sendMessage({ action: "readBackup", filename }, (response) => {
    if (chrome.runtime.lastError || !response || !response.success) {
      alert(getMessage("restoreError") || "Failed to restore from backup.");
      return;
    }

    const backupData = response.backup.data || {};
    if (!backupData.savedSessions || !Array.isArray(backupData.savedSessions)) {
      alert(getMessage("restoreError") || "This backup appears to be empty or corrupted.");
      return;
    }

    chrome.runtime.sendMessage({
      action: "restoreFromBackup",
      backupData,
      mode
    }, (restoreResponse) => {
      if (chrome.runtime.lastError || !restoreResponse || !restoreResponse.success) {
        alert(getMessage("restoreError") || "Failed to restore from backup.");
        return;
      }
      alert(getMessage("restoreSuccess") || "Restore complete! Tabstract will now reload.");
      window.location.reload();
    });
  });
}

function showBackupInFinder(filename) {
  chrome.runtime.sendMessage({ action: "showBackupInFinder", filename }, (response) => {
    if (chrome.runtime.lastError) {
      debug('[Backup] showBackupInFinder error:', chrome.runtime.lastError.message);
    }
  });
}

function deleteBackup(filename, itemEl) {
  const msg = getMessage("confirmDeleteBackup") || "Are you sure you want to delete this backup? This cannot be undone.";
  if (!confirm(msg)) return;

  chrome.runtime.sendMessage({ action: "deleteBackup", filename }, (response) => {
    if (chrome.runtime.lastError || !response || !response.success) return;
    itemEl.remove();
    // If list is now empty, show the empty state
    if (backupListContainer && backupListContainer.children.length === 0) {
      backupListContainer.innerHTML = `<p class="backup-loading">${getMessage("noBackupsYet") || "No backups yet"}</p>`;
    }
  });
}

// ------------------------------------------------
// Guide Slider
// ------------------------------------------------

let currentGuideSlide = 0;

function initGuideSlider() {
  const prevBtn = document.querySelector('.guide-prev');
  const nextBtn = document.querySelector('.guide-next');

  if (prevBtn) prevBtn.addEventListener('click', () => navigateGuideSlide(-1));
  if (nextBtn) nextBtn.addEventListener('click', () => navigateGuideSlide(1));

  // Initialize first slide title
  showGuideSlide(0);
}

function navigateGuideSlide(direction) {
  const slides = document.querySelectorAll('#user-guide .guide-slide');
  const totalSlides = slides.length;
  const newIndex = (currentGuideSlide + direction + totalSlides) % totalSlides;
  showGuideSlide(newIndex);
}

function showGuideSlide(index) {
  const slides = document.querySelectorAll('#user-guide .guide-slide');
  const titleEl = document.getElementById('guideSlideTitle');

  // Pause video on current slide
  const currentSlideEl = slides[currentGuideSlide];
  if (currentSlideEl) {
    const video = currentSlideEl.querySelector('video');
    if (video && !video.paused) video.pause();
  }

  // Show target slide, hide others
  slides.forEach((slide, i) => {
    slide.classList.toggle('active', i === index);
  });

  // Update title
  const targetSlide = slides[index];
  if (targetSlide && titleEl) {
    const titleKey = targetSlide.dataset.titleKey;
    const titleDefault = targetSlide.dataset.titleDefault;
    titleEl.textContent = getMessage(titleKey) || titleDefault;
  }

  // Play video on new slide
  const newVideo = targetSlide ? targetSlide.querySelector('video') : null;
  if (newVideo) {
    if (newVideo.readyState >= 3) {
      newVideo.play().catch(() => {});
    } else {
      newVideo.preload = 'auto';
      newVideo.load();
      newVideo.addEventListener('canplay', () => {
        newVideo.play().catch(() => {});
      }, { once: true });
    }
  }

  currentGuideSlide = index;
}

function updateGuideImages() {
  const isDarkMode = document.documentElement.classList.contains('dark-mode');
  const guideImages = document.querySelectorAll('.guide-image');

  guideImages.forEach(img => {
    const lightSrc = img.getAttribute('src');
    const darkSrc = img.getAttribute('data-dark-src');

    if (isDarkMode && darkSrc) {
      // Store original light src if not already stored
      if (!img.hasAttribute('data-light-src')) {
        img.setAttribute('data-light-src', lightSrc);
      }
      img.src = darkSrc;
    } else {
      // Restore light mode image
      const originalLightSrc = img.getAttribute('data-light-src') || lightSrc;
      img.src = originalLightSrc;
    }
  });
}

function initializeGuideVideos() {
  const guideVideos = document.querySelectorAll('video.guide-image');

  guideVideos.forEach(video => {
    // Don't preload videos - wait for IntersectionObserver
    video.preload = 'none';
    let hasStartedLoading = false;

    // Add intersection observer for lazy loading
    if ('IntersectionObserver' in window) {
      const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            // Only play if this video's slide is active (grid stacking makes all visible to observer)
            const parentSlide = video.closest('.guide-slide');
            if (parentSlide && !parentSlide.classList.contains('active')) return;

            // Start loading the video when it comes into view
            if (!hasStartedLoading) {
              hasStartedLoading = true;
              video.preload = 'auto';
              video.load();

              // Wait for video to be ready before playing to avoid flicker
              const playWhenReady = () => {
                if (video.paused) {
                  video.play().catch(() => {
                    // Autoplay might be blocked, that's okay - poster will remain visible
                  });
                }
              };

              if (video.readyState >= 3) {
                // Video already has enough data
                playWhenReady();
              } else {
                // Wait for video to load enough data
                video.addEventListener('canplay', playWhenReady, { once: true });
              }
            } else if (video.paused && video.readyState >= 3) {
              // Video already loaded, just play it
              video.play().catch(() => {});
            }
          } else {
            // Pause video when it leaves the viewport
            if (!video.paused) {
              video.pause();
            }
          }
        });
      }, {
        threshold: 0.95
      });

      observer.observe(video);
    }
  });
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

// ------------------------------------------------
// 8) Delete Data + Reset (with confirmation dialog)
// ------------------------------------------------
clearDataButton?.addEventListener('click', () => {
  const confirmed = confirm(getMessage("confirmReset"));
  if (!confirmed) return;
  // Create a safety backup before clearing all data
  chrome.runtime.sendMessage({ action: "createPreRestoreBackup" }, () => {
    chrome.storage.local.clear(() => {
      window.location.reload();
    });
  });
});

// ------------------------------------------------
// 9) Backup Now Button
// ------------------------------------------------
backupNowButton?.addEventListener('click', () => {
  backupNowButton.disabled = true;
  backupNowButton.textContent = getMessage("backingUp") || "Backing up...";

  chrome.runtime.sendMessage({ action: "createManualBackup" }, (response) => {
    if (chrome.runtime.lastError || !response || !response.success) {
      backupNowButton.textContent = getMessage("backupFailed") || "Backup failed";
    } else {
      backupNowButton.textContent = getMessage("backupComplete") || "Backup complete!";
      loadLastBackupTime();
      loadBackupList();
    }

    setTimeout(() => {
      backupNowButton.disabled = false;
      backupNowButton.textContent = getMessage("backupNow") || "Backup Now";
    }, 2000);
  });
});

downloadReportButton?.addEventListener('click', () => {
  chrome.storage.local.get(null, (allData) => {
    const userAgent = navigator.userAgent;
    const platform = navigator.platform || "Unknown";
    const manifest = chrome.runtime.getManifest();
    const extensionVersion = manifest.version || "Unknown";
    const now = new Date().toISOString();

    const debugInfo = {
      extensionVersion,
      userAgent,
      platform,
      localStorage: allData,
      generatedAt: now
    };
    const debugJson = JSON.stringify(debugInfo, null, 2);
    const blob = new Blob([debugJson], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Tabstract_System_Report_${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });
});

// ------------------------------------------------
// 10) Email Support
// ------------------------------------------------
emailSupportButton?.addEventListener('click', () => {
  chrome.storage.local.get(null, (allData) => {
    const localDataStr = JSON.stringify(allData, null, 2);
    const subject = encodeURIComponent("Need Help with Tabstract");
    const body = encodeURIComponent(
      "Hi there,\n\nI'm having an issue with Tabstract.\n\nFollow these steps to reproduce my problem:\n1.\n2.\n3.\n\n\n" +
      "Here is my local storage data for troubleshooting:\n\n" + localDataStr
    );
    const mailtoUrl = `mailto:help@tabstract.app?subject=${subject}&body=${body}`;
    window.open(mailtoUrl, "_top");
  });
});

// ------------------------------------------------
// 12) Import Data
// ------------------------------------------------
importDataButton?.addEventListener('click', () => {
  importFileInput.click();
});

importFileInput?.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (event) => {
    try {
      let importedData = JSON.parse(event.target.result);

      // Detect backup-wrapped files and extract the data portion
      if (importedData.backupVersion && importedData.data) {
        importedData = importedData.data;
      }

      // Show confirmation dialog with detailed warning
      const confirmMessage = getMessage("confirmImport") ||
        "WARNING: This will completely replace all your current Tabstract data (settings, saved sessions, trash, etc.) with the imported data.\n\nThis action cannot be undone.\n\nAre you sure you want to continue?";

      if (!confirm(confirmMessage)) {
        // Reset the file input so the same file can be selected again if needed
        importFileInput.value = '';
        return;
      }

      // Create a safety backup before importing, then clear and import
      chrome.runtime.sendMessage({ action: "createPreRestoreBackup" }, () => {
        chrome.storage.local.clear(() => {
          chrome.storage.local.set(importedData, () => {
            // Show success message
            alert(getMessage("importSuccess") || "Data imported successfully! Tabstract will now reload.");
            // Reload the page to reflect the imported data
            window.location.reload();
          });
        });
      });
    } catch (error) {
      debug("Failed to import data:", error);
      alert(getMessage("importError") || "Failed to import data. Please make sure the file is a valid Tabstract data export.");
      // Reset the file input
      importFileInput.value = '';
    }
  };

  reader.onerror = () => {
    alert(getMessage("importError") || "Failed to read the file. Please try again.");
    importFileInput.value = '';
  };

  reader.readAsText(file);
});
