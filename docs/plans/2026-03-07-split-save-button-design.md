# Split Save Button with Dropdown — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a split button with dropdown to the iOS save button, offering "Save This Tab" and the inverse of the user's close-on-save setting.

**Architecture:** The existing single `<button id="save-btn">` becomes a flex container with two tap zones (main label + chevron) and a dropdown panel that appears below. All logic stays in `ios-popup.js`; background.js already handles `saveTabs`, `saveAndClose`, and `save-active-tab` actions.

**Tech Stack:** HTML/CSS/JS (Safari Web Extension), no frameworks.

---

## Design Reference

```
+----------------------------+-----+
|        Save Tabs           |  v  |
+----------------------------+-----+
         (tap chevron)
+----------------------------+-----+
|        Save Tabs           |  ^  |
+----------------------------+-----+
+----------------------------------+
|  Save This Tab                   |
+----------------------------------+
|  Save without Closing            |
+----------------------------------+
```

- Chevron toggles panel open/closed. Tap outside or tap an option also dismisses.
- Menu item 1: "Save This Tab" → `{ action: 'save-active-tab' }`
- Menu item 2: inverse of `popupBehavior` setting:
  - If `saveAndClose` → "Save without Closing" → `{ action: 'saveTabs' }`
  - If `saveOnly` → "Save & Close Tabs" → `{ action: 'saveAndClose' }`

---

### Task 1: Restructure HTML — split button + dropdown panel

**Files:**
- Modify: `Tabstract iOS Extension/Resources/ios-popup.html:14-18`

**Step 1: Replace the save-section header**

Replace lines 14-18:
```html
<header id="save-section">
    <button id="save-btn" class="save-button">
        <span id="save-label">Save Tabs</span>
    </button>
</header>
```

With:
```html
<header id="save-section">
    <div class="split-save">
        <button id="save-btn" class="save-button split-save-main">
            <span id="save-label">Save Tabs</span>
        </button>
        <div class="split-save-divider"></div>
        <button id="save-more-btn" class="save-button split-save-chevron" aria-label="More save options" aria-expanded="false">
            <svg width="12" height="7" viewBox="0 0 12 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="1,1 6,6 11,1"/>
            </svg>
        </button>
    </div>
    <div id="save-dropdown" class="save-dropdown" style="display: none;">
        <button class="save-dropdown-item" data-action="save-active-tab">Save This Tab</button>
        <button class="save-dropdown-item" id="save-toggle-close">Save without Closing</button>
    </div>
    <div id="save-dropdown-backdrop" class="save-dropdown-backdrop" style="display: none;"></div>
</header>
```

**Step 2: Commit**
```bash
git add "Tabstract iOS Extension/Resources/ios-popup.html"
git commit -m "feat(ios): restructure save button HTML for split button + dropdown"
```

---

### Task 2: CSS — split button layout and dropdown styling

**Files:**
- Modify: `Tabstract iOS Extension/Resources/ios-popup.css:85-147` (save section)

**Step 1: Replace the save-section CSS**

Replace the existing `.save-button` and related rules (lines 96-147) with the split button styles. Keep `#save-section` (lines 88-94) unchanged.

After the `#save-section` rule, replace:
```css
.save-button {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 50px;
    border: none;
    border-radius: var(--card-radius);
    background: var(--accent-color);
    color: #FFFFFF;
    font-size: 17px;
    font-weight: 600;
    cursor: pointer;
    transition: opacity 0.15s ease, transform 0.1s ease;
    -webkit-appearance: none;
}
```

With:
```css
/* ---- Split save button ---- */
.split-save {
    display: flex;
    width: 100%;
    height: 50px;
    border-radius: var(--card-radius);
    overflow: hidden;
}

.save-button {
    border: none;
    background: var(--accent-color);
    color: #FFFFFF;
    font-size: 17px;
    font-weight: 600;
    cursor: pointer;
    -webkit-appearance: none;
    transition: opacity 0.15s ease;
}

.split-save-main {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    justify-content: center;
}

.split-save-divider {
    width: 1px;
    background: linear-gradient(
        to bottom,
        transparent 15%,
        rgba(255, 255, 255, 0.25) 20%,
        rgba(255, 255, 255, 0.25) 80%,
        transparent 85%
    );
}

.split-save-chevron {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 44px;
    flex-shrink: 0;
    padding: 0;
}

.split-save-chevron svg {
    transition: transform 0.2s ease;
}

.split-save-chevron.open svg {
    transform: rotate(180deg);
}
```

**Step 2: Add dropdown panel + backdrop styles**

Append after the `.save-button:disabled` rule:
```css
/* ---- Save dropdown panel ---- */
.save-dropdown {
    margin-top: 6px;
    background: var(--card-bg);
    border-radius: var(--card-radius);
    overflow: hidden;
    box-shadow: 0 2px 12px rgba(0, 0, 0, 0.12),
                0 0.5px 2px rgba(0, 0, 0, 0.08);
    z-index: 15;
    position: relative;
}

.save-dropdown-item {
    display: flex;
    align-items: center;
    width: 100%;
    min-height: var(--touch-min);
    padding: 12px 16px;
    border: none;
    background: none;
    color: var(--text);
    font-size: 16px;
    text-align: left;
    cursor: pointer;
    -webkit-appearance: none;
}

.save-dropdown-item + .save-dropdown-item {
    border-top: 0.5px solid var(--border);
}

.save-dropdown-item:active {
    background-color: rgba(128, 128, 128, 0.1);
}

.save-dropdown-backdrop {
    position: fixed;
    inset: 0;
    z-index: 9;
}
```

**Step 3: Keep active/disabled states for .save-button**

Verify that the existing `.save-button:active` and `.save-button:disabled` rules still apply (they target `.save-button` which both main and chevron buttons have). No change needed.

**Step 4: Commit**
```bash
git add "Tabstract iOS Extension/Resources/ios-popup.css"
git commit -m "feat(ios): add split save button and dropdown CSS"
```

---

### Task 3: JavaScript — dropdown toggle, dismiss, and actions

**Files:**
- Modify: `Tabstract iOS Extension/Resources/ios-popup.js:37-41` (DOM references)
- Modify: `Tabstract iOS Extension/Resources/ios-popup.js:637-648` (handleSave)
- Modify: `Tabstract iOS Extension/Resources/ios-popup.js:993-999` (init)

**Step 1: Add DOM references**

After line 41 (`const emptyMessage`), add:
```javascript
const saveMoreBtn   = document.getElementById('save-more-btn');
const saveDropdown  = document.getElementById('save-dropdown');
const saveBackdrop  = document.getElementById('save-dropdown-backdrop');
const saveToggleCloseBtn = document.getElementById('save-toggle-close');
```

**Step 2: Add dropdown toggle + dismiss logic**

After the existing `handleSave()` function (after line 648), add:
```javascript
/* ------------------------------------------------------------------ */
/*  Save dropdown                                                     */
/* ------------------------------------------------------------------ */
var dropdownOpen = false;

function openDropdown() {
    /* Update the toggle-close label based on current setting */
    chrome.storage.local.get('popupBehavior', function (res) {
        var mode = res.popupBehavior || 'saveAndClose';
        if (mode === 'saveAndClose') {
            saveToggleCloseBtn.textContent = 'Save without Closing';
            saveToggleCloseBtn.dataset.action = 'saveTabs';
        } else {
            saveToggleCloseBtn.textContent = 'Save & Close Tabs';
            saveToggleCloseBtn.dataset.action = 'saveAndClose';
        }
    });
    saveDropdown.style.display = '';
    saveBackdrop.style.display = '';
    saveMoreBtn.classList.add('open');
    saveMoreBtn.setAttribute('aria-expanded', 'true');
    dropdownOpen = true;
}

function closeDropdown() {
    saveDropdown.style.display = 'none';
    saveBackdrop.style.display = 'none';
    saveMoreBtn.classList.remove('open');
    saveMoreBtn.setAttribute('aria-expanded', 'false');
    dropdownOpen = false;
}

function toggleDropdown() {
    if (dropdownOpen) {
        closeDropdown();
    } else {
        openDropdown();
    }
}

function handleDropdownAction(action) {
    closeDropdown();
    saveBtn.disabled = true;
    chrome.runtime.sendMessage({ action: action }, function () {
        saveLabel.textContent = '\u2713';
        setTimeout(function () {
            saveLabel.textContent = t('saveTabs');
            saveBtn.disabled = false;
        }, 600);
        loadSessions();
    });
}
```

**Step 3: Wire up event listeners in init**

In the DOMContentLoaded handler, after `saveBtn.addEventListener('click', handleSave);` (line 999), add:
```javascript
/* wire up split-button dropdown */
saveMoreBtn.addEventListener('click', toggleDropdown);
saveBackdrop.addEventListener('click', closeDropdown);
saveDropdown.querySelectorAll('.save-dropdown-item').forEach(function (item) {
    item.addEventListener('click', function () {
        handleDropdownAction(this.dataset.action);
    });
});
```

**Step 4: Commit**
```bash
git add "Tabstract iOS Extension/Resources/ios-popup.js"
git commit -m "feat(ios): wire up split save dropdown toggle and actions"
```

---

### Task 4: Build and verify

**Step 1: Build iOS**
```bash
xcodebuild -scheme "Tabstract iOS" -destination "generic/platform=iOS Simulator" build
```

**Step 2: Manual test checklist**
- [ ] Split button renders with divider and chevron
- [ ] Main "Save Tabs" button still works as before
- [ ] Chevron opens dropdown panel
- [ ] Chevron again closes dropdown
- [ ] Tapping outside (backdrop) closes dropdown
- [ ] "Save This Tab" executes and shows checkmark
- [ ] Toggle-close label reads "Save without Closing" when close-on-save is ON
- [ ] Toggle-close label reads "Save & Close Tabs" when close-on-save is OFF
- [ ] Tapping a dropdown option executes, shows checkmark, closes panel, reloads sessions

**Step 3: Commit any fixes, then final commit**
```bash
git add "Tabstract iOS Extension/Resources/"
git commit -m "feat(ios): split save button with dropdown — complete"
```
