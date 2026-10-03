/* ios-popup.js — Tabstract iOS Safari Extension */

(function () {
    'use strict';

    /* ------------------------------------------------------------------ */
    /*  Serialized storage writes                                         */
    /*  Prevents read-modify-write races when rapid actions (e.g. two     */
    /*  tab deletes + lock toggle) each do get→modify→set on the same key */
    /* ------------------------------------------------------------------ */
    var _storageQueue = Promise.resolve();
    function withSavedSessions(mutate) {
        _storageQueue = _storageQueue.then(function () {
            return new Promise(function (resolve) {
                chrome.storage.local.get('savedSessions', function (data) {
                    var sessions = data.savedSessions || [];
                    var result = mutate(sessions);
                    if (result === false) { resolve(); return; }
                    chrome.storage.local.set({ savedSessions: sessions }, function () {
                        try { chrome.runtime.sendMessage({ action: "syncFlushAndPush" }); } catch (e) {}
                        resolve();
                    });
                });
            });
        });
        return _storageQueue;
    }

    /* ------------------------------------------------------------------ */
    /*  i18n helper (falls back to hardcoded English)                     */
    /* ------------------------------------------------------------------ */
    /* Key mapping: iOS short names → shared messages.json keys */
    var keyMap = {
        restore: 'bulkActionRestore',
        lock: 'lockSession',
        unlock: 'unlockSession',
        'delete': 'draftDelete',
        untitled: 'untitledSession',
        expiringToday: 'trashExpiringToday',
        expiringTomorrow: 'trashExpiringTomorrow',
        expiringThisWeek: 'trashExpiringThisWeek',
        expiringSoon: 'trashExpiringSoon',
        expired: 'expiredLabel',
        restoredFromTrash: 'restoredFromTrashSessionName',
        pinned: 'columnPinned',
        locked: 'columnLock'
    };

    function t(key, substitutions) {
        var mappedKey = keyMap[key] || key;
        var msg = '';
        if (typeof getMessage === 'function') {
            try { msg = getMessage(mappedKey); } catch (_) { /* ignore */ }
        }
        if (!msg) msg = key;
        if (substitutions) {
            Object.keys(substitutions).forEach(function (k) {
                msg = msg.replace('%' + k + '%', substitutions[k]);
            });
        }
        return msg;
    }

    /* ------------------------------------------------------------------ */
    /*  DOM references                                                    */
    /* ------------------------------------------------------------------ */
    const saveBtn       = document.getElementById('save-btn');
    const saveLabel     = document.getElementById('save-label');
    const sessionList   = document.getElementById('session-list');
    const emptyState    = document.getElementById('empty-state');
    const emptyMessage  = document.getElementById('empty-message');
    const saveMoreBtn   = document.getElementById('save-more-btn');
    const saveDropdown  = document.getElementById('save-dropdown');
    const saveBackdrop  = document.getElementById('save-dropdown-backdrop');

    /* ------------------------------------------------------------------ */
    /*  Relative-time helper                                              */
    /* ------------------------------------------------------------------ */
    function getRelativeTime(timestamp) {
        var now   = Date.now();
        var ts    = typeof timestamp === 'string' ? new Date(timestamp).getTime() : timestamp;
        var delta = now - ts;
        var secs  = Math.floor(delta / 1000);
        var mins  = Math.floor(secs / 60);
        var hrs   = Math.floor(mins / 60);
        var days  = Math.floor(hrs / 24);
        var weeks = Math.floor(days / 7);

        // chrome.i18n.getMessage requires string substitutions, not numbers
        if (secs < 60)   return getMessage('justNow') || 'just now';
        if (mins === 1)   return getMessage('minuteAgo', ['1']) || '1 minute ago';
        if (mins < 60)    return getMessage('minutesAgo', [String(mins)]) || mins + ' minutes ago';
        if (hrs === 1)    return getMessage('hourAgo', ['1']) || '1 hour ago';
        if (hrs < 24)     return getMessage('hoursAgo', [String(hrs)]) || hrs + ' hours ago';
        if (days === 1)   return getMessage('dayAgo', ['1']) || '1 day ago';
        if (days < 7)     return getMessage('daysAgo', [String(days)]) || days + ' days ago';
        if (weeks === 1)  return getMessage('weekAgo', ['1']) || '1 week ago';
        return getMessage('weeksAgo', [String(weeks)]) || weeks + ' weeks ago';
    }

    /* ------------------------------------------------------------------ */
    /*  Swipe engine                                                      */
    /* ------------------------------------------------------------------ */
    var _openSwipe = null; // currently open swipe container
    var _lastScrollTime = 0;
    var _scrollContainer = document.scrollingElement || document.documentElement;

    // Track when page is actively scrolling
    window.addEventListener('scroll', function () {
        _lastScrollTime = Date.now();
    }, { passive: true });

    function closeOpenSwipe() {
        if (_openSwipe) {
            _openSwipe.querySelector('.swipe-content').style.transform = '';
            _openSwipe._swipeOpen = false;
            _openSwipe.classList.remove('swipe-active', 'swipe-dir-left', 'swipe-dir-right');
            _openSwipe = null;
        }
    }

    function makeSwipeable(container, content, leftWidth, rightWidth) {
        var startX = 0, startY = 0, currentX = 0, isSwiping = false, isScrolling = false, directionLocked = false;
        var maxLeft = leftWidth || 0;   // swipe right to reveal left actions
        var maxRight = rightWidth || 0; // swipe left to reveal right actions
        var THRESHOLD = 50;
        var CLOSE_THRESHOLD = 30; // easier to snap closed when already open
        var DEAD_ZONE = 15; // pixels before committing to a direction

        container._swipeOpen = false;

        content.addEventListener('touchstart', function (e) {
            // Close any other open swipe first
            if (_openSwipe && _openSwipe !== container) {
                closeOpenSwipe();
            }
            var touch = e.touches[0];
            startX = touch.clientX;
            startY = touch.clientY;
            currentX = 0;
            isSwiping = false;
            directionLocked = false;

            // If page was scrolling recently, assume this touch is a scroll continuation
            isScrolling = (Date.now() - _lastScrollTime) < 150;
        }, { passive: true });

        content.addEventListener('touchmove', function (e) {
            if (isScrolling) return;
            var touch = e.touches[0];
            var dx = touch.clientX - startX;
            var dy = touch.clientY - startY;

            // Wait for movement to exceed dead zone before locking direction
            if (!directionLocked) {
                var totalMove = Math.abs(dx) + Math.abs(dy);
                if (totalMove < DEAD_ZONE) return;

                // Lock direction — require horizontal to dominate by 2:1 ratio
                if (Math.abs(dx) > Math.abs(dy) * 2) {
                    directionLocked = true;
                    isSwiping = true;
                    container.classList.add('swipe-active');
                    content.classList.add('swiping');
                } else {
                    directionLocked = true;
                    isScrolling = true;
                    return;
                }
            }

            // If already open, offset from open position
            if (container._swipeOpen) {
                if (container._swipeDir === 'left') {
                    dx = dx - maxRight;
                } else {
                    dx = dx + maxLeft;
                }
            }

            // Clamp: allow right pull (positive) up to maxLeft, left pull (negative) up to maxRight
            if (dx > 0 && maxLeft > 0) {
                currentX = Math.min(dx, maxLeft + 20);
                container.classList.add('swipe-dir-right');
                container.classList.remove('swipe-dir-left');
            } else if (dx < 0 && maxRight > 0) {
                currentX = Math.max(dx, -(maxRight + 20));
                container.classList.add('swipe-dir-left');
                container.classList.remove('swipe-dir-right');
            } else {
                currentX = 0;
            }

            content.style.transform = 'translateX(' + currentX + 'px)';
        }, { passive: true });

        content.addEventListener('touchend', function () {
            content.classList.remove('swiping');
            if (!isSwiping) return;

            // Decide snap — use smaller threshold when already open (closing)
            var wasOpen = container._swipeOpen;
            var snapThreshold = wasOpen ? CLOSE_THRESHOLD : THRESHOLD;

            if (!wasOpen && currentX > snapThreshold && maxLeft > 0) {
                // Snap open left actions
                content.style.transform = 'translateX(' + maxLeft + 'px)';
                container._swipeOpen = true;
                container._swipeDir = 'right';
                _openSwipe = container;
            } else if (!wasOpen && currentX < -snapThreshold && maxRight > 0) {
                // Snap open right actions
                content.style.transform = 'translateX(' + (-maxRight) + 'px)';
                container._swipeOpen = true;
                container._swipeDir = 'left';
                _openSwipe = container;
            } else if (wasOpen && Math.abs(currentX) < (wasOpen && container._swipeDir === 'left' ? maxRight : maxLeft) - CLOSE_THRESHOLD) {
                // Swiped back enough — snap closed
                content.style.transform = '';
                container._swipeOpen = false;
                container.classList.remove('swipe-active', 'swipe-dir-left', 'swipe-dir-right');
                if (_openSwipe === container) _openSwipe = null;
            } else if (wasOpen) {
                // Didn't swipe back enough — re-snap to open
                if (container._swipeDir === 'left') {
                    content.style.transform = 'translateX(' + (-maxRight) + 'px)';
                } else {
                    content.style.transform = 'translateX(' + maxLeft + 'px)';
                }
            } else {
                // Snap closed
                content.style.transform = '';
                container._swipeOpen = false;
                container.classList.remove('swipe-active', 'swipe-dir-left', 'swipe-dir-right');
                if (_openSwipe === container) _openSwipe = null;
            }
        }, { passive: true });
    }

    // Close swipe on any tap outside
    document.addEventListener('touchstart', function (e) {
        if (_openSwipe && !_openSwipe.contains(e.target)) {
            closeOpenSwipe();
        }
    }, { passive: true });

    /* ------------------------------------------------------------------ */
    /*  Drag-to-reorder engine                                            */
    /* ------------------------------------------------------------------ */
    var _dragState = null;
    var LONG_PRESS_MS = 400;
    var DRAG_DEAD_ZONE = 8;

    function initDrag(card, header) {
        var pressTimer = null;
        var startX = 0, startY = 0;

        header.addEventListener('touchstart', function (e) {
            // Don't start drag if swipe is open or expanded
            if (_openSwipe) return;
            var touch = e.touches[0];
            startX = touch.clientX;
            startY = touch.clientY;

            pressTimer = setTimeout(function () {
                pressTimer = null;
                startDrag(card, touch);
            }, LONG_PRESS_MS);
        }, { passive: true });

        header.addEventListener('touchmove', function (e) {
            if (pressTimer) {
                var touch = e.touches[0];
                var dx = Math.abs(touch.clientX - startX);
                var dy = Math.abs(touch.clientY - startY);
                if (dx > DRAG_DEAD_ZONE || dy > DRAG_DEAD_ZONE) {
                    clearTimeout(pressTimer);
                    pressTimer = null;
                }
            }
            if (_dragState && _dragState.card === card) {
                e.preventDefault();
                moveDrag(e.touches[0]);
            }
        }, { passive: false });

        header.addEventListener('touchend', function () {
            if (pressTimer) {
                clearTimeout(pressTimer);
                pressTimer = null;
            }
            if (_dragState && _dragState.card === card) {
                endDrag();
            }
        }, { passive: true });

        header.addEventListener('touchcancel', function () {
            if (pressTimer) {
                clearTimeout(pressTimer);
                pressTimer = null;
            }
            if (_dragState && _dragState.card === card) {
                endDrag();
            }
        }, { passive: true });
    }

    function startDrag(card, touch) {
        closeOpenSwipe();
        // Collapse card if expanded
        card.classList.remove('expanded');
        var hdr = card.querySelector('.card-header');
        if (hdr) hdr.setAttribute('aria-expanded', 'false');

        var cards = Array.from(sessionList.querySelectorAll('.session-card'));
        var rects = cards.map(function (c) { return c.getBoundingClientRect(); });
        var cardIndex = cards.indexOf(card);
        var rect = rects[cardIndex];

        _dragState = {
            card: card,
            cards: cards,
            rects: rects,
            startIndex: cardIndex,
            currentIndex: cardIndex,
            startY: touch.clientY,
            offsetY: touch.clientY - rect.top,
            cardHeight: rect.height,
            listTop: rects[0] ? rects[0].top : 0
        };

        // Disable text selection while dragging
        document.body.style.userSelect = 'none';
        document.body.style.webkitUserSelect = 'none';

        // Style the dragged card
        card.classList.add('dragging');
        card.style.position = 'fixed';
        card.style.left = rect.left + 'px';
        card.style.width = rect.width + 'px';
        card.style.top = (touch.clientY - _dragState.offsetY) + 'px';
        card.style.zIndex = '100';

        // Add placeholder
        var placeholder = document.createElement('div');
        placeholder.className = 'drag-placeholder';
        placeholder.style.height = rect.height + 'px';
        card.parentNode.insertBefore(placeholder, card);
        _dragState.placeholder = placeholder;

        // Dim other cards
        cards.forEach(function (c) {
            if (c !== card) c.classList.add('drag-dimmed');
        });
    }

    function moveDrag(touch) {
        var ds = _dragState;
        if (!ds) return;

        // Move card with finger
        ds.card.style.top = (touch.clientY - ds.offsetY) + 'px';

        // Determine new index based on finger position
        var fingerY = touch.clientY;
        var newIndex = ds.currentIndex;

        for (var i = 0; i < ds.cards.length; i++) {
            if (ds.cards[i] === ds.card) continue;
            var r = ds.cards[i].getBoundingClientRect();
            var mid = r.top + r.height / 2;
            if (i < ds.currentIndex && fingerY < mid) {
                newIndex = i;
                break;
            }
            if (i > ds.currentIndex && fingerY > mid) {
                newIndex = i;
            }
        }

        if (newIndex !== ds.currentIndex) {
            // Move placeholder to new position
            var refCard = ds.cards[newIndex];
            if (newIndex > ds.currentIndex) {
                refCard.parentNode.insertBefore(ds.placeholder, refCard.nextSibling);
            } else {
                refCard.parentNode.insertBefore(ds.placeholder, refCard);
            }
            ds.currentIndex = newIndex;
        }
    }

    function endDrag() {
        var ds = _dragState;
        if (!ds) return;
        _dragState = null;

        // Re-enable text selection
        document.body.style.userSelect = '';
        document.body.style.webkitUserSelect = '';

        var card = ds.card;

        // Remove fixed positioning
        card.classList.remove('dragging');
        card.style.position = '';
        card.style.left = '';
        card.style.width = '';
        card.style.top = '';
        card.style.zIndex = '';

        // Insert card at placeholder position
        ds.placeholder.parentNode.insertBefore(card, ds.placeholder);
        ds.placeholder.remove();

        // Un-dim
        ds.cards.forEach(function (c) { c.classList.remove('drag-dimmed'); });

        // Prevent click from firing after drag
        if (card._setDragJustEnded) card._setDragJustEnded();

        // Persist new order if changed
        if (ds.startIndex !== ds.currentIndex) {
            persistSessionOrder();
        }
    }

    var _suppressOnChanged = false;

    function persistSessionOrder() {
        // Read current DOM order and update storage
        var cards = Array.from(sessionList.querySelectorAll('.session-card'));
        var timestamps = cards.map(function (c) { return String(c.dataset.timestamp); });

        _suppressOnChanged = true;
        withSavedSessions(function (sessions) {
            // Build a map for lookup (use string keys for safety)
            var sessionMap = {};
            sessions.forEach(function (s) { sessionMap[String(s.timestamp)] = s; });

            // Reorder based on DOM order — mutate the array in place
            var reordered = [];
            var used = {};
            timestamps.forEach(function (ts) {
                if (sessionMap[ts] && !used[ts]) {
                    reordered.push(sessionMap[ts]);
                    used[ts] = true;
                }
            });
            // Append any sessions not in the DOM (safety)
            sessions.forEach(function (s) {
                if (!used[String(s.timestamp)]) reordered.push(s);
            });

            // Replace array contents in place
            sessions.length = 0;
            reordered.forEach(function (s) { sessions.push(s); });
        }).then(function () {
            _suppressOnChanged = false;
        });
    }

    /* ------------------------------------------------------------------ */
    /*  Build a single session card                                       */
    /* ------------------------------------------------------------------ */
    function createSessionCard(session, nextSession) {
        const card = document.createElement('div');
        card.className = 'session-card expanded';
        card.dataset.timestamp = session.timestamp;

        /* ---- swipeable header wrapper ---- */
        const swipeWrap = document.createElement('div');
        swipeWrap.className = 'swipe-container';

        /* left actions (swipe right): Restore + More */
        const leftActions = document.createElement('div');
        leftActions.className = 'swipe-actions-left';

        const swipeRestore = document.createElement('button');
        swipeRestore.className = 'swipe-action swipe-restore';
        swipeRestore.innerHTML = '<svg viewBox="0 0 28.5004 38.1558" fill="currentColor"><path d="M0 20.1866C0 27.9557 6.29112 34.2518 14.0652 34.2518C21.8343 34.2518 28.1254 27.9557 28.1254 20.1866C28.1254 19.1228 27.3954 18.3872 26.3615 18.3872C25.3538 18.3872 24.6558 19.1228 24.6558 20.1759C24.6558 26.0228 19.912 30.7665 14.0652 30.7665C8.21339 30.7665 3.47457 26.0228 3.47457 20.1759C3.47457 14.3241 8.21339 9.58532 14.0652 9.58532C14.9205 9.58532 15.7062 9.6386 16.3647 9.79276L12.4935 13.6277C12.1732 13.9317 12.0099 14.3145 12.0099 14.7817C12.0099 15.7439 12.7499 16.4789 13.6908 16.4789C14.1808 16.4789 14.5713 16.3035 14.8802 16.0052L21.283 9.54145C21.6536 9.18142 21.8283 8.75961 21.8283 8.27105C21.8283 7.80806 21.638 7.35996 21.283 7.00562L14.8909 0.499216C14.577 0.164749 14.1808 0 13.6908 0C12.7499 0 12.0099 0.766214 12.0099 1.7334C12.0099 2.20064 12.1789 2.5827 12.4829 2.88736L15.9627 6.30753C15.3944 6.20097 14.7401 6.1214 14.0652 6.1214C6.29112 6.1214 0 12.4175 0 20.1866Z"/></svg><span>' + t('restore') + '</span>';
        swipeRestore.addEventListener('click', function (e) {
            e.stopPropagation();
            closeOpenSwipe();
            handleRestore(session.timestamp);
        });
        leftActions.appendChild(swipeRestore);

        var swipeMore = document.createElement('button');
        swipeMore.className = 'swipe-action swipe-more';
        swipeMore.innerHTML = '<svg viewBox="0 0 20 20" width="18" height="18"><circle cx="4" cy="10" r="2" fill="currentColor"/><circle cx="10" cy="10" r="2" fill="currentColor"/><circle cx="16" cy="10" r="2" fill="currentColor"/></svg><span>' + t('moreShort') + '</span>';
        swipeMore.addEventListener('click', function (e) {
            e.stopPropagation();
            closeOpenSwipe();
            showActionSheet(session);
        });
        leftActions.appendChild(swipeMore);
        swipeWrap.appendChild(leftActions);

        /* right actions (swipe left): Merge + Delete */
        const rightActions = document.createElement('div');
        rightActions.className = 'swipe-actions-right';

        var swipeMerge = document.createElement('button');
        swipeMerge.className = 'swipe-action swipe-merge';
        swipeMerge.innerHTML = '<svg viewBox="0 0 95.3047 112.053" fill="currentColor"><path d="M95.3047 106.169C95.3047 102.797 92.8818 100.276 89.5498 100.276L5.8437 100.276C2.46287 100.276 0 102.797 0 106.169C0 109.532 2.46287 112.053 5.8437 112.053L89.5498 112.053C92.8818 112.053 95.3047 109.532 95.3047 106.169ZM6.08392 47.6602C2.82321 47.6602 0.377914 50.1416 0.377914 53.5254C0.377914 55.0586 0.949198 56.498 2.22067 57.792L43.2178 98.4063C44.4365 99.6475 45.9648 100.383 47.6523 100.383C49.3398 100.383 50.8681 99.6475 52.0869 98.4063L93.0928 57.792C94.3642 56.498 94.9355 55.0586 94.9355 53.5254C94.9355 50.1416 92.4902 47.6602 89.2295 47.6602C87.5557 47.6602 86.0088 48.3506 84.9903 49.4092L69.291 64.9132L47.6523 88.6886L26.0049 64.9132L10.3231 49.4092C9.29581 48.3418 7.75774 47.6602 6.08392 47.6602ZM52.8662 89.0421L53.5927 69.338L53.5927 6.00581C53.5927 2.46287 51.165 0 47.6523 0C44.1309 0 41.7119 2.46287 41.7119 6.00581L41.7119 69.338L42.4297 89.0421C42.5713 91.877 44.8086 94.2247 47.6523 94.2247C50.4961 94.2247 52.7246 91.877 52.8662 89.0421Z"/></svg><span>' + t('restoreTabsMerge') + '</span>';
        if (session.locked || !nextSession || nextSession.locked) swipeMerge.disabled = true;
        swipeMerge.addEventListener('click', function (e) {
            e.stopPropagation();
            closeOpenSwipe();
            handleMerge(session.timestamp);
        });
        rightActions.appendChild(swipeMerge);

        const swipeDelete = document.createElement('button');
        swipeDelete.className = 'swipe-action swipe-delete';
        swipeDelete.innerHTML = '<svg viewBox="0 0 31.179 38.1519" fill="currentColor"><path d="M10.8009 29.9681C11.4594 29.9681 11.8837 29.5509 11.8681 28.9366L11.3894 12.5553C11.3709 11.9465 10.9409 11.5422 10.3109 11.5422C9.65812 11.5422 9.23655 11.9594 9.25218 12.5709L9.71812 28.945C9.73655 29.5666 10.1694 29.9681 10.8009 29.9681ZM15.4034 29.9681C16.0506 29.9681 16.5062 29.5566 16.5062 28.9478L16.5062 12.5653C16.5062 11.9565 16.0506 11.5422 15.4034 11.5422C14.7534 11.5422 14.3106 11.9565 14.3106 12.5653L14.3106 28.9478C14.3106 29.5566 14.7534 29.9681 15.4034 29.9681ZM20.0159 29.9681C20.6375 29.9681 21.0675 29.5666 21.0859 28.945L21.5519 12.5709C21.5675 11.9594 21.1459 11.5422 20.4931 11.5422C19.8631 11.5422 19.4331 11.9465 19.4147 12.5681L18.9487 28.9366C18.9331 29.5509 19.3575 29.9681 20.0159 29.9681ZM8.305 7.18844L11.1887 7.18844L11.1887 3.94312C11.1887 3.13405 11.7547 2.61499 12.6247 2.61499L18.1537 2.61499C19.0237 2.61499 19.5897 3.13405 19.5897 3.94312L19.5897 7.18844L22.4734 7.18844L22.4734 3.79812C22.4734 1.40875 20.9484 0 18.3594 0L12.4191 0C9.83 0 8.305 1.40875 8.305 3.79812ZM1.3828 8.88842L29.434 8.88842C30.204 8.88842 30.804 8.27686 30.804 7.50686C30.804 6.74249 30.204 6.14375 29.434 6.14375L1.3828 6.14375C0.625622 6.14375 0 6.74249 0 7.50686C0 8.28967 0.625622 8.88842 1.3828 8.88842ZM8.22749 35.2581L22.5894 35.2581C24.9812 35.2581 26.5347 33.7937 26.6469 31.3991L27.7209 8.58873L24.8228 8.58873L23.7956 30.9337C23.7644 31.8712 23.1459 32.4937 22.255 32.4937L8.53624 32.4937C7.67092 32.4937 7.05248 31.8556 7.00842 30.9337L5.92998 8.58873L3.08312 8.58873L4.17 31.4119C4.285 33.8065 5.81 35.2581 8.22749 35.2581Z"/></svg><span>' + t('delete') + '</span>';
        if (session.locked) swipeDelete.disabled = true;
        swipeDelete.addEventListener('click', function (e) {
            e.stopPropagation();
            closeOpenSwipe();
            handleDelete(session.timestamp);
        });
        rightActions.appendChild(swipeDelete);
        swipeWrap.appendChild(rightActions);

        /* swipe content = the header */
        const swipeContent = document.createElement('div');
        swipeContent.className = 'swipe-content';

        const header = document.createElement('button');
        header.className = 'card-header';
        header.setAttribute('aria-expanded', 'true');

        const titleRow = document.createElement('div');
        titleRow.className = 'card-title-row';

        const title = document.createElement('span');
        title.className = 'card-title';
        title.textContent = session.customName || session.defaultTitle || t('untitled');

        /* Rename is handled via the More action sheet */

        if (session.pinned) {
            const pinIcon = document.createElement('span');
            pinIcon.className = 'pin-indicator';
            pinIcon.setAttribute('aria-label', t('pinned'));
            pinIcon.innerHTML = '<svg viewBox="0 0 23.6864 36.9547" width="9" height="14" fill="currentColor"><path d="M0 23.1814C0 24.3206 0.788907 25.0745 2.03047 25.0745L10.5417 25.0745L10.5417 33.3208C10.5417 35.2852 11.3383 36.9547 11.6611 36.9547C11.978 36.9547 12.7745 35.2852 12.7745 33.3208L12.7745 25.0745L21.2809 25.0745C22.5225 25.0745 23.3114 24.3206 23.3114 23.1814C23.3114 19.8458 20.6805 16.4825 16.4255 14.9808L15.9244 7.71203C17.9005 6.54594 19.7755 5.09172 20.5928 3.99641C20.9506 3.51844 21.1392 3.04531 21.1392 2.63469C21.1392 1.79297 20.492 1.17219 19.5097 1.17219L3.8125 1.17219C2.81937 1.17219 2.18297 1.79297 2.18297 2.63469C2.18297 3.04531 2.36078 3.51844 2.71859 3.99641C3.54078 5.09172 5.41578 6.55078 7.38703 7.71203L6.88594 14.9808C2.63094 16.4825 0 19.8458 0 23.1814Z"/></svg>';
            titleRow.appendChild(pinIcon);
        }

        titleRow.appendChild(title);

        const meta = document.createElement('span');
        meta.className = 'card-meta';
        const count = session.tabs ? session.tabs.length : 0;
        var tabWord = count === 1 ? (getMessage('tabSingular') || 'tab') : (getMessage('tabPlural') || 'tabs');
        meta.textContent = count + ' ' + tabWord + '  \u00B7  ' + getRelativeTime(session.timestamp);

        if (session.locked) {
            const lockIcon = document.createElement('span');
            lockIcon.className = 'lock-indicator';
            lockIcon.setAttribute('aria-label', t('locked'));
            lockIcon.innerHTML = '<svg viewBox="0 0 21.5869 31.1647" width="9" height="12" fill="currentColor"><path d="M3.31703 30.3269L17.8948 30.3269C19.9931 30.3269 21.2119 29.0672 21.2119 26.8213L21.2119 15.6584C21.2119 13.4125 19.9931 12.1636 17.8948 12.1636L3.31703 12.1636C1.21875 12.1636 0 13.4125 0 15.6584L0 26.8213C0 29.0672 1.21875 30.3269 3.31703 30.3269ZM2.7925 13.0809L4.71985 13.0809L4.71985 8.31313C4.71985 4.23516 7.2936 1.83141 10.5981 1.83141C13.8978 1.83141 16.5028 4.23516 16.5028 8.31313L16.5028 13.0809L18.4145 13.0809L18.4145 8.52125C18.4145 3.01922 14.842 0 10.5981 0C6.36985 0 2.7925 3.01922 2.7925 8.52125Z"/></svg>';
            meta.appendChild(lockIcon);
        }

        const chevron = document.createElement('span');
        chevron.className = 'chevron';
        chevron.textContent = '\u203A'; // single right-pointing angle

        titleRow.appendChild(chevron);
        header.appendChild(titleRow);
        header.appendChild(meta);
        swipeContent.appendChild(header);
        swipeWrap.appendChild(swipeContent);

        // Measure action widths after render, fallback to computed
        var leftW = 150; // 75 * 2 (Restore + More)
        var rightW = 150; // 75 * 2 (Merge + Delete)
        makeSwipeable(swipeWrap, swipeContent, leftW, rightW);

        /* ---- accordion body ---- */
        const body = document.createElement('div');
        body.className = 'card-body';

        /* tab list */
        const tabList = document.createElement('ul');
        tabList.className = 'tab-list';
        if (session.tabs) {
            session.tabs.forEach(function (tab, tabIndex) {
                const li = document.createElement('li');
                li.className = 'tab-row swipe-container';

                /* right action: delete tab (not on locked sessions) */
                if (!session.locked) {
                    const tabRightActions = document.createElement('div');
                    tabRightActions.className = 'swipe-actions-right';
                    const tabDeleteBtn = document.createElement('button');
                    tabDeleteBtn.className = 'swipe-action swipe-delete';
                    tabDeleteBtn.textContent = t('delete');
                    tabDeleteBtn.addEventListener('click', function (e) {
                        e.stopPropagation();
                        closeOpenSwipe();
                        handleDeleteTab(session.timestamp, tabIndex);
                    });
                    tabRightActions.appendChild(tabDeleteBtn);
                    li.appendChild(tabRightActions);
                }

                /* swipe content: the actual tab row */
                const tabContent = document.createElement('div');
                tabContent.className = 'swipe-content tab-content-row';

                const favicon = document.createElement('img');
                favicon.className = 'tab-favicon';
                var faviconSrc = '';
                try {
                    var domain = new URL(tab.url).hostname;
                    if (domain) faviconSrc = 'https://favicone.com/' + domain + '?s=32';
                } catch (_) {}
                favicon.src = faviconSrc || 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" rx="3" fill="%23C7C7CC"/></svg>';
                favicon.width = 16;
                favicon.height = 16;
                favicon.alt = '';
                favicon.onerror = function () {
                    this.onerror = null;
                    this.src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" rx="3" fill="%23C7C7CC"/></svg>';
                };

                const link = document.createElement('a');
                link.className = 'tab-link';
                link.href = tab.url || '#';
                link.textContent = tab.title || tab.url || 'Untitled';
                link.addEventListener('click', function (e) {
                    e.preventDefault();
                    chrome.runtime.sendMessage({
                        action: 'openSingleTab',
                        url: tab.url,
                        timestamp: session.timestamp
                    });
                });

                tabContent.appendChild(favicon);
                tabContent.appendChild(link);
                li.appendChild(tabContent);

                if (!session.locked) {
                    makeSwipeable(li, tabContent, 0, 70);
                }
                tabList.appendChild(li);
            });
        }
        body.appendChild(tabList);

        /* action buttons removed — restore/lock/delete available via swipe */

        /* ---- toggle accordion ---- */
        var _dragJustEnded = false;
        header.addEventListener('click', function () {
            // Don't toggle if we just finished a swipe or drag
            if (swipeWrap._swipeOpen || _dragJustEnded) return;
            const expanded = card.classList.toggle('expanded');
            header.setAttribute('aria-expanded', String(expanded));
        });
        // Flag to prevent click after drag
        card._setDragJustEnded = function () {
            _dragJustEnded = true;
            setTimeout(function () { _dragJustEnded = false; }, 100);
        };

        card.appendChild(swipeWrap);
        card.appendChild(body);

        /* ---- long-press drag reorder ---- */
        initDrag(card, swipeContent);

        return card;
    }

    /* ------------------------------------------------------------------ */
    /*  Load & render sessions                                            */
    /* ------------------------------------------------------------------ */
    var _expandedTimestamp = null;
    var _preserveExpandState = null;

    function captureExpandState() {
        var cards = sessionList.querySelectorAll('.session-card');
        var state = {};
        for (var i = 0; i < cards.length; i++) {
            state[cards[i].dataset.timestamp] = cards[i].classList.contains('expanded');
        }
        _preserveExpandState = state;
    }

    function loadSessions() {
        closeOpenSwipe();
        _dragState = null;
        _undoTabData = null;
        chrome.storage.local.get('savedSessions', function (data) {
            var sessions = data.savedSessions || [];

            /* Sort: pinned first (most recently pinned first), then unpinned in current order */
            var pinned = sessions.filter(function (s) { return s.pinned; });
            var unpinned = sessions.filter(function (s) { return !s.pinned; });
            pinned.sort(function (a, b) {
                return (new Date(b.pinnedAt || 0).getTime()) - (new Date(a.pinnedAt || 0).getTime());
            });
            sessions = pinned.concat(unpinned);

            /* clear existing cards (keep empty-state node) */
            var child = sessionList.firstChild;
            while (child) {
                var next = child.nextSibling;
                if (child !== emptyState) sessionList.removeChild(child);
                child = next;
            }

            if (sessions.length === 0) {
                emptyState.style.display = '';
            } else {
                emptyState.style.display = 'none';
                var expandTs = _expandedTimestamp;
                _expandedTimestamp = null;
                var savedState = _preserveExpandState;
                _preserveExpandState = null;
                sessions.forEach(function (session, idx) {
                    var card = createSessionCard(session, sessions[idx + 1]);
                    var tsKey = String(session.timestamp);
                    if (savedState && tsKey in savedState) {
                        // Restore exact expand/collapse state
                        if (!savedState[tsKey]) {
                            card.classList.remove('expanded');
                            var hdr = card.querySelector('.card-header');
                            if (hdr) hdr.setAttribute('aria-expanded', 'false');
                        }
                    } else if (expandTs && session.timestamp === expandTs) {
                        // Re-expand card if it was open before (e.g. after tab delete)
                        card.classList.add('expanded');
                        var hdr2 = card.querySelector('.card-header');
                        if (hdr2) hdr2.setAttribute('aria-expanded', 'true');
                    }
                    sessionList.appendChild(card);
                });
            }
        });
    }

    /* ------------------------------------------------------------------ */
    /*  Actions                                                           */
    /* ------------------------------------------------------------------ */
    function updateSaveLabel() {
        chrome.tabs.query({ currentWindow: true }, function (tabs) {
            var validCount = tabs.filter(function (tab) {
                if (!tab.url) return false;
                if (tab.url.startsWith('safari-web-extension://')) return false;
                if (tab.url.startsWith('favorites://')) return false;
                if (tab.url === 'about:blank') return false;
                return true;
            }).length;
            saveLabel.textContent = validCount <= 1 ? t('saveTab') : t('saveTabs');
        });
    }

    function handleSave() {
        saveBtn.disabled = true;
        /* Use iOS-aware actions: saveTabsNoClose (no list.html opened) or
           saveAndCloseIOS (opens saved.html instead of list.html) */
        chrome.storage.local.get('popupBehavior', function (res) {
            var action = (res.popupBehavior === 'saveAndClose')
                ? 'saveAndCloseIOS'
                : 'saveTabsNoClose';
            chrome.runtime.sendMessage({ action: action }, function () {
                saveLabel.textContent = '\u2713';
                setTimeout(function () {
                    updateSaveLabel();
                    saveBtn.disabled = false;
                }, 600);
                loadSessions();
            });
        });
    }

    /* ------------------------------------------------------------------ */
    /*  Save dropdown                                                     */
    /* ------------------------------------------------------------------ */
    var dropdownOpen = false;

    function openDropdown() {
        /* Reflect the current close-on-save preference in the toggle */
        chrome.storage.local.get('popupBehavior', function (res) {
            var closeToggle = document.getElementById('closeAfterSaveToggle');
            if (closeToggle) {
                closeToggle.checked = (res.popupBehavior || 'saveAndClose') === 'saveAndClose';
            }
        });
        /* Hide "Save All Tabs" when only one tab is open */
        chrome.tabs.query({ currentWindow: true }, function (tabs) {
            var validCount = tabs.filter(function (tab) {
                if (!tab.url) return false;
                if (tab.url.startsWith('safari-web-extension://')) return false;
                if (tab.url.startsWith('favorites://')) return false;
                if (tab.url === 'about:blank') return false;
                return true;
            }).length;
            /* With a single tab the primary button already covers both save
               actions, so the menu collapses to just the close-on-save toggle. */
            var singleTab = validCount <= 1;
            saveDropdown.querySelectorAll('.save-dropdown-item').forEach(function (item) {
                item.style.display = singleTab ? 'none' : '';
            });
            var toggleRow = saveDropdown.querySelector('.save-dropdown-toggle');
            if (toggleRow) {
                toggleRow.classList.toggle('only-row', singleTab);
            }
            var toggleLabel = document.getElementById('closeAfterSaveLabel');
            if (toggleLabel) {
                toggleLabel.textContent = t(singleTab ? 'saveAlsoClosesLabelSingular' : 'saveAlsoClosesLabel');
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

    /* Map a menu scope ("tab" | "all") to a background action, using the
       close-on-save preference the dropdown's toggle writes. */
    function handleDropdownAction(scope) {
        chrome.storage.local.get('popupBehavior', function (res) {
            var closes = (res.popupBehavior || 'saveAndClose') === 'saveAndClose';
            var action;
            if (scope === 'all') {
                action = closes ? 'saveAndCloseIOS' : 'saveTabsNoClose';
            } else {
                action = closes ? 'saveActiveTabAndClose' : 'saveActiveTabNoClose';
            }
            closeDropdown();
            saveBtn.disabled = true;
            chrome.runtime.sendMessage({ action: action }, function () {
                saveLabel.textContent = '\u2713';
                setTimeout(function () {
                    updateSaveLabel();
                    saveBtn.disabled = false;
                }, 600);
                loadSessions();
            });
        });
    }

    function handleRestore(timestamp) {
        chrome.storage.local.get(['savedSessions', 'deleteAfterRestore'], function (data) {
            var sessions = data.savedSessions || [];
            var session = null;
            for (var i = 0; i < sessions.length; i++) {
                if (sessions[i].timestamp === timestamp) {
                    session = sessions[i];
                    break;
                }
            }
            if (!session || !session.tabs) return;
            var shouldDelete = data.deleteAfterRestore && !session.locked;
            chrome.runtime.sendMessage({
                action: 'reopenTabs',
                timestamp: timestamp,
                tabList: session.tabs,
                deleteAfterRestore: shouldDelete
            });
        });
    }

    /* ------------------------------------------------------------------ */
    /*  Action sheet (More menu)                                          */
    /* ------------------------------------------------------------------ */
    var _sheetSession = null;

    function showActionSheet(session) {
        _sheetSession = session;
        var sheet = document.getElementById('action-sheet');
        var backdrop = document.getElementById('action-sheet-backdrop');
        sheet.style.display = '';
        backdrop.style.display = '';
        sheet.classList.remove('sliding-out');

        // Update pin button label
        var pinBtn = document.getElementById('sheet-pin');
        pinBtn.querySelector('span').textContent = session.pinned ? t('smartGroupUnpinButton') : t('smartGroupPinButton');

        // Update lock button label
        var lockBtn = document.getElementById('sheet-lock');
        lockBtn.querySelector('span').textContent = session.locked ? t('unlock') : t('lock');

        // Disable rename for locked sessions
        var renameBtn = document.getElementById('sheet-rename');
        renameBtn.disabled = !!session.locked;
    }

    function hideActionSheet() {
        var sheet = document.getElementById('action-sheet');
        var backdrop = document.getElementById('action-sheet-backdrop');
        sheet.classList.add('sliding-out');
        backdrop.style.display = 'none';
        sheet.addEventListener('animationend', function handler() {
            sheet.removeEventListener('animationend', handler);
            sheet.style.display = 'none';
            sheet.classList.remove('sliding-out');
            _sheetSession = null;
        });
    }

    var _undoTimer = null;
    var _undoToast = null;
    var _undoBtn = null;
    var _undoTabData = null; // { sessionTimestamp, tabIndex, tab }
    var _undoSessionIndex = -1; // DOM index at time of session delete

    function showUndoToast(deleteId, message, hideUndo) {
        if (!_undoToast) {
            _undoToast = document.getElementById('undo-toast');
            _undoBtn = document.getElementById('undo-btn');
            var undoText = _undoToast.querySelector('.undo-toast-text');
            _undoBtn.addEventListener('click', function () {
                var sessionDeleteId = _undoToast.dataset.deleteId;
                if (sessionDeleteId) {
                    var targetIndex = _undoSessionIndex;
                    var undoTimestamp = String(_undoToast.dataset.timestamp);
                    chrome.runtime.sendMessage({ action: 'undoDeleteSession', deleteId: sessionDeleteId }, function () {
                        // background.js restores the session, but may put it at wrong index
                        // Fix position based on where it was in the DOM when deleted
                        if (targetIndex >= 0) {
                            withSavedSessions(function (sessions) {
                                var restoredIdx = -1;
                                for (var i = 0; i < sessions.length; i++) {
                                    if (String(sessions[i].timestamp) === undoTimestamp) {
                                        restoredIdx = i;
                                        break;
                                    }
                                }
                                if (restoredIdx >= 0 && restoredIdx !== targetIndex) {
                                    var session = sessions.splice(restoredIdx, 1)[0];
                                    sessions.splice(Math.min(targetIndex, sessions.length), 0, session);
                                } else {
                                    loadSessions();
                                    return false;
                                }
                            });
                        } else {
                            loadSessions();
                        }
                    });
                } else if (_undoTabData) {
                    // Undo tab delete — re-insert tab
                    var tabData = _undoTabData;
                    _undoTabData = null;
                    withSavedSessions(function (sessions) {
                        var found = false;
                        for (var i = 0; i < sessions.length; i++) {
                            if (sessions[i].timestamp === tabData.sessionTimestamp) {
                                var idx = Math.min(tabData.tabIndex, sessions[i].tabs.length);
                                sessions[i].tabs.splice(idx, 0, tabData.tab);
                                found = true;
                                break;
                            }
                        }
                        // Session was removed (last tab deleted) — restore at original position
                        if (!found && tabData.session) {
                            var restored = tabData.session;
                            restored.tabs = [tabData.tab];
                            var insertAt = tabData.sessionIndex >= 0 ? Math.min(tabData.sessionIndex, sessions.length) : sessions.length;
                            sessions.splice(insertAt, 0, restored);
                        }
                        _expandedTimestamp = tabData.sessionTimestamp;
                    });
                }
                hideUndoToast();
            });
        }
        var undoText = _undoToast.querySelector('.undo-toast-text');
        // Clear any existing timer
        if (_undoTimer) clearTimeout(_undoTimer);
        _undoToast.dataset.deleteId = deleteId || '';
        if (!deleteId) { /* tab delete — _undoTabData already set */ }
        undoText.textContent = message || t('sessionDeleted');
        _undoBtn.style.display = hideUndo ? 'none' : '';
        _undoToast.classList.remove('hiding');
        _undoToast.style.display = '';
        _undoTimer = setTimeout(function () { hideUndoToast(); }, 5000);
    }

    function hideUndoToast() {
        if (!_undoToast) return;
        if (_undoTimer) { clearTimeout(_undoTimer); _undoTimer = null; }
        _undoToast.classList.add('hiding');
        _undoToast.addEventListener('animationend', function handler() {
            _undoToast.removeEventListener('animationend', handler);
            _undoToast.style.display = 'none';
            _undoToast.classList.remove('hiding');
        });
    }

    function handleDelete(timestamp) {
        // Capture DOM index before deletion for accurate undo positioning
        var cards = Array.from(sessionList.querySelectorAll('.session-card'));
        var domIndex = -1;
        for (var i = 0; i < cards.length; i++) {
            if (Number(cards[i].dataset.timestamp) === timestamp) {
                domIndex = i;
                break;
            }
        }
        _undoSessionIndex = domIndex;

        chrome.runtime.sendMessage({ action: 'deleteSession', timestamp: timestamp }, function (resp) {
            loadSessions();
            if (resp && resp.deleteId) {
                showUndoToast(resp.deleteId);
                // Store timestamp on toast so undo can find the restored session
                _undoToast.dataset.timestamp = String(timestamp);
            }
        });
    }

    function handleDeleteTab(sessionTimestamp, tabIndex) {
        // Capture DOM index before async work (DOM may change)
        var cards = Array.from(sessionList.querySelectorAll('.session-card'));
        var sessionDomIndex = -1;
        for (var j = 0; j < cards.length; j++) {
            if (String(cards[j].dataset.timestamp) === String(sessionTimestamp)) {
                sessionDomIndex = j;
                break;
            }
        }
        withSavedSessions(function (sessions) {
            var deletedTab = null;
            var sessionCopy = null;
            for (var i = 0; i < sessions.length; i++) {
                if (sessions[i].timestamp === sessionTimestamp) {
                    sessionCopy = JSON.parse(JSON.stringify(sessions[i]));
                    if (sessions[i].tabs && tabIndex < sessions[i].tabs.length) {
                        deletedTab = sessions[i].tabs[tabIndex];
                        sessions[i].tabs.splice(tabIndex, 1);
                        if (sessions[i].tabs.length === 0) {
                            sessions.splice(i, 1);
                        }
                    }
                    break;
                }
            }
            _expandedTimestamp = sessionTimestamp;
            if (deletedTab) {
                _undoTabData = { sessionTimestamp: sessionTimestamp, tabIndex: tabIndex, tab: deletedTab, session: sessionCopy, sessionIndex: sessionDomIndex };
                showUndoToast(null, t('tabDeleted'));
            }
        });
    }

    function handleToggleLock(timestamp) {
        captureExpandState();
        withSavedSessions(function (sessions) {
            for (var i = 0; i < sessions.length; i++) {
                if (sessions[i].timestamp === timestamp) {
                    sessions[i].locked = !sessions[i].locked;
                    break;
                }
            }
        });
    }

    function handleTogglePin(timestamp) {
        captureExpandState();
        withSavedSessions(function (sessions) {
            for (var i = 0; i < sessions.length; i++) {
                if (sessions[i].timestamp === timestamp) {
                    sessions[i].pinned = !sessions[i].pinned;
                    sessions[i].pinnedAt = sessions[i].pinned ? new Date().toISOString() : null;
                    break;
                }
            }
        });
    }

    function handleMerge(timestamp) {
        captureExpandState();
        withSavedSessions(function (sessions) {
            /* Sort pinned first to match rendered order */
            var pinned = sessions.filter(function (s) { return s.pinned; });
            var unpinned = sessions.filter(function (s) { return !s.pinned; });
            pinned.sort(function (a, b) {
                return (new Date(b.pinnedAt || 0).getTime()) - (new Date(a.pinnedAt || 0).getTime());
            });
            var sorted = pinned.concat(unpinned);

            var sourceIdx = -1;
            for (var i = 0; i < sorted.length; i++) {
                if (sorted[i].timestamp === timestamp) { sourceIdx = i; break; }
            }
            if (sourceIdx < 0 || sourceIdx >= sorted.length - 1) return false;
            var source = sorted[sourceIdx];
            var target = sorted[sourceIdx + 1];
            if (source.locked || target.locked) return false;

            /* Prepend source tabs into target */
            target.tabs = (source.tabs || []).concat(target.tabs || []);
            /* Remove source from original array */
            var origIdx = sessions.indexOf(source);
            if (origIdx >= 0) sessions.splice(origIdx, 1);
        });
    }

    /* ------------------------------------------------------------------ */
    /*  Live updates                                                      */
    /* ------------------------------------------------------------------ */
    chrome.storage.onChanged.addListener(function (changes) {
        if (changes.savedSessions && !_suppressOnChanged) {
            loadSessions();
            var currentQuery = document.getElementById('search-input');
            var q = currentQuery ? currentQuery.value.trim() : '';
            if (q) {
                setTimeout(function() { handleSearchInput(q); }, 50);
            }
        }
        if (changes.icloudSyncLastTime && changes.icloudSyncLastTime.newValue) {
            var syncText = document.getElementById('ios-syncStatusText');
            if (syncText) {
                syncText.textContent = t('lastSynced') + ' ' + getRelativeTime(changes.icloudSyncLastTime.newValue);
            }
        }
        /* The background page can turn sync off on its own (server zone gone
           after a reset elsewhere). Reflect that while settings are open. */
        if (changes.icloudSyncEnabled && changes.icloudSyncEnabled.newValue === false) {
            var toggle = document.getElementById('ios-icloudSync');
            if (toggle && toggle.checked) {
                toggle.checked = false;
                var row = document.getElementById('ios-syncStatusRow');
                if (row) row.style.display = 'none';
                refreshSyncStatus(false);
            }
        }
    });

    /* ------------------------------------------------------------------ */
    /*  Search filtering                                                  */
    /* ------------------------------------------------------------------ */
    function handleSearchInput(query) {
        var cards = sessionList.querySelectorAll('.session-card');
        if (!query) {
            clearSearch();
            return;
        }

        var lowerQuery = query.toLowerCase();
        var anyMatch = false;

        for (var i = 0; i < cards.length; i++) {
            var card = cards[i];
            var titleEl = card.querySelector('.card-title');
            var titleText = titleEl ? titleEl.textContent.toLowerCase() : '';
            var sessionMatches = titleText.indexOf(lowerQuery) !== -1;

            var tabRows = card.querySelectorAll('.tab-row');
            var matchingTabs = 0;

            for (var j = 0; j < tabRows.length; j++) {
                var link = tabRows[j].querySelector('.tab-link');
                if (!link) { tabRows[j].style.display = ''; continue; }
                var tabTitle = (link.textContent || '').toLowerCase();
                var tabUrl = (link.href || '').toLowerCase();
                var tabMatches = tabTitle.indexOf(lowerQuery) !== -1 || tabUrl.indexOf(lowerQuery) !== -1;

                if (sessionMatches || tabMatches) {
                    tabRows[j].style.display = '';
                    matchingTabs++;
                } else {
                    tabRows[j].style.display = 'none';
                }
            }

            if (sessionMatches || matchingTabs > 0) {
                card.style.display = '';
                // Auto-expand to show matching tabs
                if (!card.classList.contains('expanded')) {
                    card.classList.add('expanded');
                    var hdr = card.querySelector('.card-header');
                    if (hdr) hdr.setAttribute('aria-expanded', 'true');
                }
                // Update visible tab count in meta
                var meta = card.querySelector('.card-meta');
                if (meta && !sessionMatches) {
                    var origCount = tabRows.length;
                    var countText = matchingTabs + ' / ' + origCount + ' ' + (getMessage('tabPlural') || 'tabs');
                    if (!card.dataset.origMeta) card.dataset.origMeta = meta.textContent;
                    meta.textContent = countText;
                }
                anyMatch = true;
            } else {
                card.style.display = 'none';
            }
        }

        // Show/hide no-results message
        var noResults = document.getElementById('search-no-results');
        if (!anyMatch) {
            if (!noResults) {
                noResults = document.createElement('div');
                noResults.id = 'search-no-results';
                noResults.className = 'search-no-results';
                sessionList.parentNode.insertBefore(noResults, sessionList.nextSibling);
            }
            noResults.textContent = t('noResultsFound') + ' \u201c' + query + '\u201d';
            noResults.style.display = '';
        } else if (noResults) {
            noResults.style.display = 'none';
        }

        // Hide empty state during search
        if (emptyState) emptyState.style.display = 'none';
    }

    function clearSearch() {
        var cards = sessionList.querySelectorAll('.session-card');
        for (var i = 0; i < cards.length; i++) {
            var card = cards[i];
            card.style.display = '';
            if (card.dataset.origMeta) {
                var meta = card.querySelector('.card-meta');
                if (meta) meta.textContent = card.dataset.origMeta;
                delete card.dataset.origMeta;
            }
            var tabRows = card.querySelectorAll('.tab-row');
            for (var j = 0; j < tabRows.length; j++) {
                tabRows[j].style.display = '';
            }
        }
        var noResults = document.getElementById('search-no-results');
        if (noResults) noResults.style.display = 'none';
        var sessions = sessionList.querySelectorAll('.session-card');
        if (emptyState && sessions.length === 0) emptyState.style.display = '';
    }

    /* ------------------------------------------------------------------ */
    /*  Settings                                                          */
    /* ------------------------------------------------------------------ */
    var mainView     = document.getElementById('main-view');
    var settingsView = document.getElementById('settings-view');
    var kebabContainer  = document.getElementById('kebab-container');
    var actionTrigger   = document.getElementById('action-trigger');
    var actionBackdrop  = document.getElementById('action-bar-backdrop');
    var actionTrash     = document.getElementById('action-trash');
    var actionExpand    = document.getElementById('action-expand');
    var actionSort      = document.getElementById('action-sort');
    var actionLock      = document.getElementById('action-lock');
    var backBtn      = document.getElementById('settings-back');

    /* setting toggle IDs → storage keys */
    var settingsMap = {
        'ios-saveAlsoCloses':     'popupBehavior',       // checkbox → 'saveOnly' vs 'saveAndClose'
        'ios-pinnedTabs':         'pinnedTabs',
        'ios-avoidDuplicates':    'avoidDuplicates',
        'ios-deleteAfterRestore': 'deleteAfterRestore',
        'ios-opentabsBackground': 'opentabsBackground',
        'ios-icloudSync':         'icloudSyncEnabled'
    };

    /* special mapping: saveAlsoCloses is inverted — popupBehavior "saveAndClose" = checked */
    function readSettingValue(storageKey, val) {
        if (storageKey === 'popupBehavior') return val === 'saveAndClose';
        if (storageKey === 'avoidDuplicates') return val !== false; // default true
        if (storageKey === 'opentabsBackground') return val !== false; // default true
        return !!val;
    }

    function writeSettingValue(storageKey, checked) {
        if (storageKey === 'popupBehavior') return checked ? 'saveAndClose' : 'saveOnly';
        return checked;
    }

    function loadSettings() {
        var keys = [];
        for (var id in settingsMap) keys.push(settingsMap[id]);
        keys.push('icloudSyncLastTime');

        chrome.storage.local.get(keys, function (result) {
            for (var id in settingsMap) {
                var el = document.getElementById(id);
                if (el) el.checked = readSettingValue(settingsMap[id], result[settingsMap[id]]);
            }
            /* sync status */
            var syncRow = document.getElementById('ios-syncStatusRow');
            var errorRow = document.getElementById('ios-syncErrorRow');
            if (result.icloudSyncEnabled) {
                syncRow.style.display = '';
                refreshSyncStatus(true);
            } else {
                syncRow.style.display = 'none';
                if (errorRow) errorRow.style.display = 'none';
                // Sync can turn itself off (server zone gone); show why
                refreshSyncStatus(false);
            }
        });
    }

    /* Same mapping as settings.js on macOS */
    function getSyncErrorMessage(code) {
        var map = {
            notAuthenticated: 'syncErrorNotAuthenticated',
            networkUnavailable: 'syncErrorNetwork',
            quotaExceeded: 'syncErrorQuota',
            rateLimited: 'syncErrorRateLimited',
            zoneBusy: 'syncErrorZoneBusy',
            zoneNotFound: 'syncErrorZoneNotFound',
            noAccount: 'syncNoAccount'
        };
        return t(map[code] || 'syncErrorGeneric');
    }

    function showSyncError(code) {
        var errorRow = document.getElementById('ios-syncErrorRow');
        var errorText = document.getElementById('ios-syncErrorText');
        if (!errorRow || !errorText) return;
        if (code) {
            errorText.textContent = getSyncErrorMessage(code);
            errorRow.style.display = '';
        } else {
            errorRow.style.display = 'none';
        }
    }

    /* Ask the background page for the native sync state: last sync time,
       iCloud account status and the last error. iOS used to show only the
       JS-side timestamp, so a tester with no iCloud account or a failing
       push saw nothing wrong. */
    function refreshSyncStatus(enabled) {
        var syncText = document.getElementById('ios-syncStatusText');
        var syncNow = document.getElementById('ios-syncNowBtn');
        chrome.runtime.sendMessage({ action: 'getSyncStatus' }, function (resp) {
            if (chrome.runtime.lastError || !resp) return;
            if (enabled === false) {
                showSyncError(resp.lastError || null);
                return;
            }
            var noAccount = resp.accountStatus === 'noAccount' || resp.accountStatus === 'restricted';
            if (noAccount) {
                if (syncText) syncText.textContent = t('syncNoAccount');
                if (syncNow) syncNow.style.display = 'none';
                showSyncError(null);
                return;
            }
            if (syncNow) syncNow.style.display = '';
            if (syncText) {
                syncText.textContent = resp.lastSyncTime
                    ? t('lastSynced') + ' ' + getRelativeTime(resp.lastSyncTime)
                    : t('neverSynced');
            }
            showSyncError(resp.lastError || null);
        });
    }

    function bindSettingToggle(id) {
        var el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('change', function () {
            var storageKey = settingsMap[id];
            // Don't write icloudSyncEnabled directly — enableSync/disableSync
            // in background.js handle it atomically with icloudSyncDeviceID.
            // The generic write here races ahead of the native message, leaving
            // icloudSyncEnabled=true without a deviceID and triggering premature
            // sync on iOS (Safari can reload the service worker at any time).
            if (storageKey !== 'icloudSyncEnabled') {
                var obj = {};
                obj[storageKey] = writeSettingValue(storageKey, el.checked);
                chrome.storage.local.set(obj);
            }

            /* show/hide sync status row */
            if (storageKey === 'icloudSyncEnabled') {
                var syncRow = document.getElementById('ios-syncStatusRow');
                var syncText = document.getElementById('ios-syncStatusText');
                syncRow.style.display = el.checked ? '' : 'none';
                if (el.checked) {
                    if (syncText) syncText.textContent = t('connecting');
                    chrome.runtime.sendMessage({ action: 'enableSync' }, function (resp) {
                        chrome.storage.local.set({ _iosDebugSync: { time: Date.now(), action: 'enableSync', response: resp, error: chrome.runtime.lastError ? chrome.runtime.lastError.message : null } });
                        if (!resp || !resp.success) {
                            // Revert toggle on failure and say why
                            el.checked = false;
                            chrome.storage.local.set({ icloudSyncEnabled: false });
                            syncRow.style.display = 'none';
                            if (syncText) syncText.textContent = '';
                            showSyncError((resp && resp.error) || 'unknown');
                        } else {
                            showSyncError(null);
                            refreshSyncStatus();
                        }
                    });
                } else {
                    showSyncError(null);
                    chrome.runtime.sendMessage({ action: 'disableSync' }, function (resp) {
                        chrome.storage.local.set({ _iosDebugSync: { time: Date.now(), action: 'disableSync', response: resp, error: chrome.runtime.lastError ? chrome.runtime.lastError.message : null } });
                    });
                }
            }
        });
    }

    function showSettings() {
        var si = document.getElementById('search-input');
        var sc = document.getElementById('search-clear');
        if (si) { si.value = ''; }
        if (sc) { sc.style.display = 'none'; }
        clearSearch();
        loadSettings();
        mainView.style.display = 'none';
        settingsView.style.display = '';
        settingsView.classList.remove('sliding-out');
    }

    function hideSettings() {
        settingsView.classList.add('sliding-out');
        settingsView.addEventListener('animationend', function handler() {
            settingsView.removeEventListener('animationend', handler);
            settingsView.style.display = 'none';
            settingsView.classList.remove('sliding-out');
            mainView.style.display = '';
        });
    }

    /* Copy Diagnostics button */
    var copyDiagBtn = document.getElementById('ios-copyDiagBtn');
    if (copyDiagBtn) {
        copyDiagBtn.addEventListener('click', function () {
            if (copyDiagBtn.disabled) return;
            copyDiagBtn.disabled = true;
            chrome.runtime.sendMessage({ action: 'getSyncDiagnostics', platform: 'iOS' }, function (resp) {
                if (!resp || !resp.success || !navigator.clipboard) {
                    copyDiagBtn.disabled = false;
                    return;
                }
                navigator.clipboard.writeText(resp.text).then(function () {
                    copyDiagBtn.textContent = t('diagnosticsCopied');
                }, function () {
                    copyDiagBtn.textContent = t('syncFailed');
                }).then(function () {
                    setTimeout(function () {
                        copyDiagBtn.textContent = t('syncCopyAction');
                        copyDiagBtn.disabled = false;
                    }, 1500);
                });
            });
        });
    }

    /* Reset iCloud Data — two taps within 5s (confirm() is blocked in iOS popups) */
    var resetSyncBtn = document.getElementById('ios-resetSyncBtn');
    if (resetSyncBtn) {
        var _resetArmed = false;
        var _resetTimer = null;
        var disarmReset = function () {
            _resetArmed = false;
            if (_resetTimer) { clearTimeout(_resetTimer); _resetTimer = null; }
            resetSyncBtn.classList.remove('armed');
            resetSyncBtn.textContent = t('syncResetAction');
        };
        resetSyncBtn.addEventListener('click', function () {
            if (resetSyncBtn.disabled) return;
            if (!_resetArmed) {
                _resetArmed = true;
                resetSyncBtn.classList.add('armed');
                resetSyncBtn.textContent = t('confirmAction') || 'Confirm?';
                _resetTimer = setTimeout(disarmReset, 5000);
                return;
            }
            disarmReset();
            resetSyncBtn.disabled = true;
            resetSyncBtn.textContent = t('syncing');
            chrome.runtime.sendMessage({ action: 'resetSync' }, function (resp) {
                resetSyncBtn.disabled = false;
                if (resp && resp.success) {
                    resetSyncBtn.textContent = t('syncResetDoneShort');
                    var toggle = document.getElementById('ios-icloudSync');
                    if (toggle) toggle.checked = false;
                    var syncRow = document.getElementById('ios-syncStatusRow');
                    if (syncRow) syncRow.style.display = 'none';
                    showSyncError(null);
                    setTimeout(function () { resetSyncBtn.textContent = t('syncResetAction'); }, 2500);
                } else {
                    resetSyncBtn.textContent = t('syncResetAction');
                    showSyncError((resp && resp.error) || 'unknown');
                }
            });
        });
    }

    /* Sync Now button */
    var syncNowBtn = document.getElementById('ios-syncNowBtn');
    if (syncNowBtn) {
        syncNowBtn.addEventListener('click', function () {
            var syncText = document.getElementById('ios-syncStatusText');
            syncText.textContent = t('syncing');
            syncNowBtn.disabled = true;
            chrome.runtime.sendMessage({ action: 'triggerSync' }, function (resp) {
                syncNowBtn.disabled = false;
                refreshSyncStatus();
            });
        });
    }

    /* ------------------------------------------------------------------ */
    /*  Trash                                                             */
    /* ------------------------------------------------------------------ */
    var trashView       = document.getElementById('trash-view');
    var trashList       = document.getElementById('trash-list');
    var trashEmptyState = document.getElementById('trash-empty-state');
    var emptyTrashBtn   = document.getElementById('empty-trash-btn');
    var trashBackBtn    = document.getElementById('trash-back');

    function loadTrash(callback) {
        chrome.runtime.sendMessage({ action: 'getTrashData' }, function (resp) {
            callback((resp && resp.trashedLinks) || []);
        });
    }

    function groupByTrashedTime(links) {
        var now = Date.now();
        var oneHourAgo = now - 3600000;
        var today = new Date();
        var startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
        var startOfYesterday = startOfToday - 86400000;
        var startOfWeek = startOfToday - (today.getDay() * 86400000);
        var groups = { justNow: [], today: [], yesterday: [], thisWeek: [], older: [] };
        links.forEach(function (link) {
            var trashedAt = link.trashedAt || (link.expiresAt - 30 * 86400000);
            if (trashedAt >= oneHourAgo) groups.justNow.push(link);
            else if (trashedAt >= startOfToday) groups.today.push(link);
            else if (trashedAt >= startOfYesterday) groups.yesterday.push(link);
            else if (trashedAt >= startOfWeek) groups.thisWeek.push(link);
            else groups.older.push(link);
        });
        return groups;
    }

    function getTimeRemaining(expiresAt) {
        var remaining = expiresAt - Date.now();
        if (remaining <= 0) return t('expired');
        var days = Math.floor(remaining / 86400000);
        var hours = Math.floor((remaining % 86400000) / 3600000);
        if (days > 0) return getMessage('expiresInDays', [String(days)]) || ('Expires in ' + days + ' days');
        if (hours > 0) return getMessage('expiresInHours', [String(hours)]) || ('Expires in ' + hours + ' hours');
        return t('expiresInLessThanHour');
    }

    function renderTrashItem(link) {
        var item = document.createElement('div');
        item.className = 'trash-item';

        /* swipe container */
        var swipeWrap = document.createElement('div');
        swipeWrap.className = 'swipe-container';

        /* left action (swipe right): Restore */
        var leftActions = document.createElement('div');
        leftActions.className = 'swipe-actions-left';
        var swipeRestore = document.createElement('button');
        swipeRestore.className = 'swipe-action swipe-restore';
        swipeRestore.innerHTML = '<svg viewBox="0 0 28.5004 38.1558" fill="currentColor"><path d="M0 20.1866C0 27.9557 6.29112 34.2518 14.0652 34.2518C21.8343 34.2518 28.1254 27.9557 28.1254 20.1866C28.1254 19.1228 27.3954 18.3872 26.3615 18.3872C25.3538 18.3872 24.6558 19.1228 24.6558 20.1759C24.6558 26.0228 19.912 30.7665 14.0652 30.7665C8.21339 30.7665 3.47457 26.0228 3.47457 20.1759C3.47457 14.3241 8.21339 9.58532 14.0652 9.58532C14.9205 9.58532 15.7062 9.6386 16.3647 9.79276L12.4935 13.6277C12.1732 13.9317 12.0099 14.3145 12.0099 14.7817C12.0099 15.7439 12.7499 16.4789 13.6908 16.4789C14.1808 16.4789 14.5713 16.3035 14.8802 16.0052L21.283 9.54145C21.6536 9.18142 21.8283 8.75961 21.8283 8.27105C21.8283 7.80806 21.638 7.35996 21.283 7.00562L14.8909 0.499216C14.577 0.164749 14.1808 0 13.6908 0C12.7499 0 12.0099 0.766214 12.0099 1.7334C12.0099 2.20064 12.1789 2.5827 12.4829 2.88736L15.9627 6.30753C15.3944 6.20097 14.7401 6.1214 14.0652 6.1214C6.29112 6.1214 0 12.4175 0 20.1866Z"/></svg><span>' + t('restore') + '</span>';
        swipeRestore.addEventListener('click', function (e) {
            e.stopPropagation();
            item.style.transition = 'opacity 0.25s ease, max-height 0.25s ease';
            item.style.opacity = '0';
            item.style.maxHeight = item.offsetHeight + 'px';
            requestAnimationFrame(function () { item.style.maxHeight = '0'; });
            chrome.runtime.sendMessage({ action: 'restoreFromTrash', linkId: link.id }, function () {
                setTimeout(function () { item.remove(); }, 260);
            });
        });
        leftActions.appendChild(swipeRestore);
        swipeWrap.appendChild(leftActions);

        /* right action (swipe left): Delete */
        var rightActions = document.createElement('div');
        rightActions.className = 'swipe-actions-right';
        var swipeDelete = document.createElement('button');
        swipeDelete.className = 'swipe-action swipe-delete';
        swipeDelete.innerHTML = '<svg viewBox="0 0 31.179 38.1519" fill="currentColor"><path d="M10.8009 29.9681C11.4594 29.9681 11.8837 29.5509 11.8681 28.9366L11.3894 12.5553C11.3709 11.9465 10.9409 11.5422 10.3109 11.5422C9.65812 11.5422 9.23655 11.9594 9.25218 12.5709L9.71812 28.945C9.73655 29.5666 10.1694 29.9681 10.8009 29.9681ZM15.4034 29.9681C16.0506 29.9681 16.5062 29.5566 16.5062 28.9478L16.5062 12.5653C16.5062 11.9565 16.0506 11.5422 15.4034 11.5422C14.7534 11.5422 14.3106 11.9565 14.3106 12.5653L14.3106 28.9478C14.3106 29.5566 14.7534 29.9681 15.4034 29.9681ZM20.0159 29.9681C20.6375 29.9681 21.0675 29.5666 21.0859 28.945L21.5519 12.5709C21.5675 11.9594 21.1459 11.5422 20.4931 11.5422C19.8631 11.5422 19.4331 11.9465 19.4147 12.5681L18.9487 28.9366C18.9331 29.5509 19.3575 29.9681 20.0159 29.9681ZM8.305 7.18844L11.1887 7.18844L11.1887 3.94312C11.1887 3.13405 11.7547 2.61499 12.6247 2.61499L18.1537 2.61499C19.0237 2.61499 19.5897 3.13405 19.5897 3.94312L19.5897 7.18844L22.4734 7.18844L22.4734 3.79812C22.4734 1.40875 20.9484 0 18.3594 0L12.4191 0C9.83 0 8.305 1.40875 8.305 3.79812ZM1.3828 8.88842L29.434 8.88842C30.204 8.88842 30.804 8.27686 30.804 7.50686C30.804 6.74249 30.204 6.14375 29.434 6.14375L1.3828 6.14375C0.625622 6.14375 0 6.74249 0 7.50686C0 8.28967 0.625622 8.88842 1.3828 8.88842ZM8.22749 35.2581L22.5894 35.2581C24.9812 35.2581 26.5347 33.7937 26.6469 31.3991L27.7209 8.58873L24.8228 8.58873L23.7956 30.9337C23.7644 31.8712 23.1459 32.4937 22.255 32.4937L8.53624 32.4937C7.67092 32.4937 7.05248 31.8556 7.00842 30.9337L5.92998 8.58873L3.08312 8.58873L4.17 31.4119C4.285 33.8065 5.81 35.2581 8.22749 35.2581Z"/></svg><span>' + t('delete') + '</span>';
        swipeDelete.addEventListener('click', function (e) {
            e.stopPropagation();
            item.style.transition = 'opacity 0.25s ease, max-height 0.25s ease';
            item.style.opacity = '0';
            item.style.maxHeight = item.offsetHeight + 'px';
            requestAnimationFrame(function () { item.style.maxHeight = '0'; });
            chrome.runtime.sendMessage({ action: 'permanentlyDeleteFromTrash', linkId: link.id }, function () {
                setTimeout(function () { item.remove(); }, 260);
            });
        });
        rightActions.appendChild(swipeDelete);
        swipeWrap.appendChild(rightActions);

        /* swipe content = the trash item row */
        var swipeContent = document.createElement('div');
        swipeContent.className = 'swipe-content trash-item-row';

        var favicon = document.createElement('img');
        favicon.className = 'trash-item-favicon';
        var faviconSrc = '';
        try {
            var domain = new URL(link.url).hostname;
            if (domain) faviconSrc = 'https://favicone.com/' + domain + '?s=32';
        } catch (_) {}
        favicon.src = faviconSrc || 'data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 16 16%22><rect width=%2216%22 height=%2216%22 rx=%223%22 fill=%22%23ddd%22/></svg>';
        favicon.alt = '';
        favicon.onerror = function () {
            this.onerror = null;
            this.src = 'data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 16 16%22><rect width=%2216%22 height=%2216%22 rx=%223%22 fill=%22%23ddd%22/></svg>';
        };
        swipeContent.appendChild(favicon);

        var content = document.createElement('div');
        content.className = 'trash-item-content';

        var title = document.createElement('div');
        title.className = 'trash-item-title';
        title.textContent = link.title || link.url;
        content.appendChild(title);

        var meta = document.createElement('div');
        meta.className = 'trash-item-meta';
        var metaParts = [];
        if (link.originalSessionName) metaParts.push(link.originalSessionName);
        metaParts.push(getTimeRemaining(link.expiresAt));
        meta.textContent = metaParts.join(' · ');
        content.appendChild(meta);

        swipeContent.appendChild(content);
        swipeWrap.appendChild(swipeContent);

        makeSwipeable(swipeWrap, swipeContent, 75, 75);

        item.appendChild(swipeWrap);
        return item;
    }

    function renderTrashView(links) {
        emptyTrashBtn.disabled = links.length === 0;

        if (links.length === 0) {
            trashList.style.display = 'none';
            trashEmptyState.style.display = '';
            return;
        }

        trashList.style.display = '';
        trashEmptyState.style.display = 'none';
        trashList.innerHTML = '';

        // Sort newest-trashed first within each group
        links.sort(function (a, b) {
            var aTime = a.trashedAt || (a.expiresAt - 30 * 86400000);
            var bTime = b.trashedAt || (b.expiresAt - 30 * 86400000);
            return bTime - aTime;
        });

        var groups = groupByTrashedTime(links);
        var groupOrder = [
            { key: 'justNow', label: t('trashGroupJustNow'), expanded: true },
            { key: 'today', label: t('trashGroupToday'), expanded: true },
            { key: 'yesterday', label: t('trashGroupYesterday'), expanded: false },
            { key: 'thisWeek', label: t('trashGroupThisWeek'), expanded: false },
            { key: 'older', label: t('trashGroupOlder'), expanded: false }
        ];

        groupOrder.forEach(function (group) {
            var items = groups[group.key];
            if (items.length === 0) return;

            var section = document.createElement('div');
            section.className = 'session-card trash-section' + (group.expanded ? ' expanded' : '');

            var header = document.createElement('button');
            header.className = 'card-header';

            var titleRow = document.createElement('div');
            titleRow.className = 'card-title-row';

            var title = document.createElement('span');
            title.className = 'card-title';
            title.textContent = group.label;

            var count = document.createElement('span');
            count.className = 'card-meta';
            count.style.display = 'inline';
            count.style.marginTop = '0';
            count.style.marginLeft = '4px';
            count.style.flex = 'none';
            count.style.width = 'auto';
            count.textContent = '(' + items.length + ')';

            var chevron = document.createElement('span');
            chevron.className = 'chevron';
            chevron.textContent = '\u2039';

            titleRow.appendChild(title);
            titleRow.appendChild(count);
            titleRow.appendChild(chevron);
            header.appendChild(titleRow);

            header.addEventListener('click', function () {
                section.classList.toggle('expanded');
            });

            section.appendChild(header);

            var body = document.createElement('div');
            body.className = 'card-body';
            items.forEach(function (link) {
                body.appendChild(renderTrashItem(link));
            });
            section.appendChild(body);

            trashList.appendChild(section);
        });
    }

    function showTrash() {
        var si = document.getElementById('search-input');
        var sc = document.getElementById('search-clear');
        if (si) { si.value = ''; }
        if (sc) { sc.style.display = 'none'; }
        clearSearch();
        loadTrash(function (links) {
            renderTrashView(links);
            mainView.style.display = 'none';
            trashView.style.display = '';
            trashView.classList.remove('sliding-out');
        });
    }

    function hideTrash() {
        trashView.classList.add('sliding-out');
        trashView.addEventListener('animationend', function handler() {
            trashView.removeEventListener('animationend', handler);
            trashView.style.display = 'none';
            trashView.classList.remove('sliding-out');
            mainView.style.display = '';
        });
    }

    /* Listen for trash updates from background */
    chrome.runtime.onMessage.addListener(function (message) {
        if (message.action === 'updateTrash') {
            if (trashView && trashView.style.display !== 'none') {
                renderTrashView(message.trashedLinks || []);
            }
        }
    });

    /* ------------------------------------------------------------------ */
    /*  Init                                                              */
    /* ------------------------------------------------------------------ */
    document.addEventListener('DOMContentLoaded', function () {
        /* trigger sync pull on open (matches macOS popup behavior) */
        try { chrome.runtime.sendMessage({ action: "syncPullIfEnabled" }); } catch (e) {}

        /* localize static text */
        emptyMessage.textContent = t('noSavedSessions');
        updateSaveLabel();

        /* wire up save button */
        saveBtn.addEventListener('click', handleSave);

        /* wire up split-button dropdown */
        saveMoreBtn.addEventListener('click', toggleDropdown);
        saveBackdrop.addEventListener('click', closeDropdown);
        saveDropdown.querySelectorAll('.save-dropdown-item').forEach(function (item) {
            item.addEventListener('click', function () {
                handleDropdownAction(this.dataset.scope);
            });
        });

        /* close-on-save toggle writes the same setting Settings exposes,
           and leaves the dropdown open so the user can then pick a scope */
        var closeAfterSaveToggle = document.getElementById('closeAfterSaveToggle');
        if (closeAfterSaveToggle) {
            closeAfterSaveToggle.addEventListener('change', function () {
                chrome.storage.local.set({
                    popupBehavior: this.checked ? 'saveAndClose' : 'saveOnly'
                });
                var settingsToggle = document.getElementById('ios-saveAlsoCloses');
                if (settingsToggle) settingsToggle.checked = this.checked;
            });
        }

        /* wire up kebab menu */
        var kebabOpen = false;
        function toggleKebab() {
            kebabOpen = !kebabOpen;
            if (kebabOpen) {
                kebabContainer.classList.add('open');
                actionBackdrop.style.display = '';
                actionTrigger.setAttribute('aria-expanded', 'true');
                /* show flyouts so they can animate in */
                actionTrash.style.display = '';
                actionSort.style.display = '';
                actionExpand.style.display = '';
                actionLock.style.display = '';
            } else {
                kebabContainer.classList.remove('open');
                actionBackdrop.style.display = 'none';
                actionTrigger.setAttribute('aria-expanded', 'false');
                /* hide flyouts after animation */
                setTimeout(function () {
                    if (!kebabOpen) {
                        actionTrash.style.display = 'none';
                        actionSort.style.display = 'none';
                        actionExpand.style.display = 'none';
                        actionLock.style.display = 'none';
                    }
                }, 250);
            }
        }
        function closeKebab() {
            if (kebabOpen) toggleKebab();
        }
        actionTrigger.addEventListener('click', toggleKebab);
        actionBackdrop.addEventListener('click', closeKebab);

        /* wire up trash flyout button */
        actionTrash.addEventListener('click', function () {
            closeKebab();
            showTrash();
        });

        /* wire up trash back button */
        trashBackBtn.addEventListener('click', hideTrash);

        /* wire up empty trash button — two-tap confirm (confirm() is blocked
           in Safari iOS extension popups and silently returns false) */
        var _emptyTrashArmed = false;
        var _emptyTrashTimer = null;
        emptyTrashBtn.addEventListener('click', function () {
            if (!_emptyTrashArmed) {
                _emptyTrashArmed = true;
                emptyTrashBtn.querySelector('span').textContent = t('confirmAction') || 'Confirm?';
                emptyTrashBtn.classList.add('armed');
                _emptyTrashTimer = setTimeout(function () {
                    _emptyTrashArmed = false;
                    emptyTrashBtn.querySelector('span').textContent = t('emptyTrash');
                    emptyTrashBtn.classList.remove('armed');
                }, 3000);
            } else {
                _emptyTrashArmed = false;
                clearTimeout(_emptyTrashTimer);
                emptyTrashBtn.classList.remove('armed');
                chrome.runtime.sendMessage({ action: 'emptyTrash' }, function () {
                    loadTrash(function (links) { renderTrashView(links); });
                });
            }
        });

        /* swipe-right to go back from trash (ignore swipes on swipeable items) */
        (function () {
            var startX = 0, startY = 0, tracking = false;
            trashView.addEventListener('touchstart', function (e) {
                /* Don't track if the swipe starts inside a swipe-container */
                if (e.target.closest('.swipe-container')) {
                    tracking = false;
                    return;
                }
                var touch = e.touches[0];
                startX = touch.clientX;
                startY = touch.clientY;
                tracking = true;
            }, { passive: true });
            trashView.addEventListener('touchend', function (e) {
                if (!tracking) return;
                var touch = e.changedTouches[0];
                var dx = touch.clientX - startX;
                var dy = Math.abs(touch.clientY - startY);
                if (dx > 30 && dx > dy) {
                    hideTrash();
                }
                tracking = false;
            }, { passive: true });
        })();

        /* wire up search input clear button */
        var searchInput = document.getElementById('search-input');
        var searchClear = document.getElementById('search-clear');
        searchInput.addEventListener('input', function () {
            searchClear.style.display = this.value ? '' : 'none';
            handleSearchInput(this.value.trim());
        });
        searchClear.addEventListener('click', function () {
            searchInput.value = '';
            searchClear.style.display = 'none';
            clearSearch();
        });

        document.getElementById('settings-btn').addEventListener('click', function () {
            showSettings();
        });

        actionExpand.addEventListener('click', function () {
            /* Toggle expand/collapse all session cards */
            var cards = sessionList.querySelectorAll('.session-card');
            var allExpanded = true;
            for (var i = 0; i < cards.length; i++) {
                if (!cards[i].classList.contains('expanded')) {
                    allExpanded = false;
                    break;
                }
            }
            for (var j = 0; j < cards.length; j++) {
                if (allExpanded) {
                    cards[j].classList.remove('expanded');
                    var hdr = cards[j].querySelector('.card-header');
                    if (hdr) hdr.setAttribute('aria-expanded', 'false');
                } else {
                    cards[j].classList.add('expanded');
                    var hdr2 = cards[j].querySelector('.card-header');
                    if (hdr2) hdr2.setAttribute('aria-expanded', 'true');
                }
            }
        });

        actionSort.addEventListener('click', function () {
            captureExpandState();
            chrome.storage.local.get('lastSortDirection', function (sortData) {
                var dir = sortData.lastSortDirection === 'oldest' ? 'newest' : 'oldest';
                withSavedSessions(function (sessions) {
                    if (sessions.length === 0) { _preserveExpandState = null; return false; }
                    sessions.sort(function (a, b) {
                        var ta = new Date(a.timestamp).getTime();
                        var tb = new Date(b.timestamp).getTime();
                        return dir === 'newest' ? tb - ta : ta - tb;
                    });
                }).then(function () {
                    chrome.storage.local.set({ lastSortDirection: dir });
                });
            });
        });

        actionLock.addEventListener('click', function () {
            captureExpandState();
            withSavedSessions(function (sessions) {
                if (sessions.length === 0) { _preserveExpandState = null; return false; }
                var allLocked = sessions.every(function (s) { return s.locked; });
                for (var i = 0; i < sessions.length; i++) {
                    sessions[i].locked = !allLocked;
                }
            });
        });

        /* wire up settings */
        backBtn.addEventListener('click', hideSettings);

        /* swipe-right to go back from settings */
        (function () {
            var startX = 0, startY = 0, tracking = false;
            settingsView.addEventListener('touchstart', function (e) {
                var touch = e.touches[0];
                startX = touch.clientX;
                startY = touch.clientY;
                tracking = true;
            }, { passive: true });
            settingsView.addEventListener('touchend', function (e) {
                if (!tracking) return;
                var touch = e.changedTouches[0];
                var dx = touch.clientX - startX;
                var dy = Math.abs(touch.clientY - startY);
                if (dx > 30 && dx > dy) {
                    hideSettings();
                }
                tracking = false;
            }, { passive: true });
        })();
        for (var id in settingsMap) bindSettingToggle(id);

        /* wire up action sheet */
        document.getElementById('sheet-cancel').addEventListener('click', hideActionSheet);
        document.getElementById('action-sheet-backdrop').addEventListener('click', hideActionSheet);

        document.getElementById('sheet-pin').addEventListener('click', function () {
            if (!_sheetSession) return;
            var ts = _sheetSession.timestamp;
            hideActionSheet();
            handleTogglePin(ts);
        });

        document.getElementById('sheet-lock').addEventListener('click', function () {
            if (!_sheetSession) return;
            var ts = _sheetSession.timestamp;
            hideActionSheet();
            handleToggleLock(ts);
        });

        document.getElementById('sheet-copy').addEventListener('click', function () {
            if (!_sheetSession || !_sheetSession.tabs) return;
            hideActionSheet();

            /* Build rich HTML: bulleted list with clickable links */
            var htmlItems = _sheetSession.tabs.map(function (tab) {
                var name = (tab.title || tab.url).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                var href = tab.url.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
                return '<li><a href="' + href + '">' + name + '</a></li>';
            });
            var html = '<ul>' + htmlItems.join('') + '</ul>';

            /* Copy rich text via temporary element (puts both text/html and text/plain on clipboard) */
            var temp = document.createElement('div');
            temp.innerHTML = html;
            temp.style.position = 'fixed';
            temp.style.left = '-9999px';
            document.body.appendChild(temp);
            var range = document.createRange();
            range.selectNodeContents(temp);
            var sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
            document.execCommand('copy');
            sel.removeAllRanges();
            document.body.removeChild(temp);
            showUndoToast(null, t('linksCopied'), true);
        });

        document.getElementById('sheet-rename').addEventListener('click', function () {
            if (!_sheetSession) return;
            var ts = _sheetSession.timestamp;
            hideActionSheet();

            /* Find the card's title span by timestamp */
            var cards = sessionList.querySelectorAll('.session-card');
            for (var i = 0; i < cards.length; i++) {
                if (cards[i].dataset.timestamp === String(ts)) {
                    var titleSpan = cards[i].querySelector('.card-title');
                    if (!titleSpan) break;

                    var input = document.createElement('input');
                    input.type = 'text';
                    input.className = 'card-title-input';
                    input.value = _sheetSession.customName || _sheetSession.defaultTitle || '';
                    titleSpan.replaceWith(input);
                    input.focus();
                    input.select();

                    var committed = false;
                    var session = _sheetSession;
                    function commitRename() {
                        if (committed) return;
                        committed = true;
                        var newName = input.value.trim();
                        if (!newName) newName = session.defaultTitle || t('untitled');
                        titleSpan.textContent = newName;
                        input.replaceWith(titleSpan);

                        if (newName !== session.customName) {
                            session.customName = newName;
                            withSavedSessions(function (sessions) {
                                for (var j = 0; j < sessions.length; j++) {
                                    if (sessions[j].timestamp === ts) {
                                        sessions[j].customName = newName;
                                        break;
                                    }
                                }
                            });
                        }
                    }

                    input.addEventListener('blur', commitRename);
                    input.addEventListener('keydown', function (ev) {
                        if (ev.key === 'Enter') {
                            ev.preventDefault();
                            input.blur();
                        }
                    });
                    break;
                }
            }
        });

        document.getElementById('sheet-share').addEventListener('click', function () {
            if (!_sheetSession || !_sheetSession.tabs) return;
            hideActionSheet();
            var title = _sheetSession.customName || _sheetSession.defaultTitle || 'Tabs';
            var text = _sheetSession.tabs.map(function (tab) {
                return (tab.title || tab.url) + '\n' + tab.url;
            }).join('\n\n');
            navigator.share({ title: title, text: text }).catch(function () {});
        });

        /* initial load */
        loadSessions();

        /* Show tab-mode header if opened as a tab after save-and-close */
        if (window.location.hash === '#tabs-saved') {
            history.replaceState(null, '', window.location.pathname);
            document.getElementById('split-save').style.display = 'none';
            document.getElementById('tab-header').style.display = '';
            showSavedToast();
        }
    });

    function showSavedToast() {
        var toast = document.getElementById('undo-toast');
        var toastText = toast.querySelector('.undo-toast-text');
        var undoBtn = document.getElementById('undo-btn');
        toastText.textContent = t('tabsSaved');
        undoBtn.style.display = 'none';
        toast.style.display = '';
        toast.classList.remove('hiding');
        setTimeout(function () {
            toast.classList.add('hiding');
            setTimeout(function () {
                toast.style.display = 'none';
                toast.classList.remove('hiding');
                undoBtn.style.display = '';
            }, 200);
        }, 2500);
    }

    // Flush pending sync dirty records when popup is closing.
    // On iOS the service worker is aggressively suspended after the
    // popup closes; this ensures the push is persisted and scheduled.
    document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'hidden') {
            try { chrome.runtime.sendMessage({ action: "syncFlushAndPush" }); } catch (e) {}
        }
    });
    window.addEventListener('pagehide', function () {
        try { chrome.runtime.sendMessage({ action: "syncFlushAndPush" }); } catch (e) {}
    });
})();
