import { getContext, extension_settings } from '../../../extensions.js';
import { generateQuietPrompt, eventSource, event_types, substituteParams, saveSettingsDebounced } from '../../../../script.js';
import {
    buildCreativeChatHistoryKey,
    buildCreativeChatSystemPrompt,
    buildOutlineCacheKey as buildOutlineScopedCacheKey,
    buildScheduleCacheKey,
    buildStorylinesCacheKey as buildLinesScopedCacheKey,
    buildSpaceChatHistoryKey,
    buildSpaceChatSystemPrompt,
    getCreativeChatPlaceholder,
    getSpaceChatPlaceholder,
} from './state.js';
import * as memory from './memory.js';

const PLUGIN_ID  = 'schedule-planner';
const MODAL_ID   = 'sp-modal-root';
const FAB_ID     = 'sp-fab';
const POS_KEY    = 'sp-pos';
const SIZE_KEY    = 'sp-size';

// Default plugin settings (stored in ST's settings.json via extension_settings)
const DEFAULT_SETTINGS = {
    apiUrl  : '',
    apiKey  : '',
    apiModel: '',
    fabShow : true,
    themeMode: 'auto',   // 'auto' | 'day' | 'night' — 'auto' follows ST theme; day/night force
    linesInterval: 2,
    linesMode: 'turns',  // 'turns' | 'days'
    // Memory system
    memoryEnabled  : true,
    memoryL0Group  : 5,    // AI floors per L0 entry
    memoryL1Group  : 10,   // L0 entries per L1 chapter
    memorySkipShort: 50,   // skip AI floors shorter than N chars
    useBaiBaiBook  : false, // if true, pull history from BaiBaiBook getInjectedHistory() and skip built-in memory entirely
};

let lastDebugPayload = null;

// view: 'user' | 'char'   charName: confirmed char name
function getCacheKey(view, charName) {
    const chatId = getContext().chatId;
    const v = view ?? currentView;
    const c = charName ?? charViewName;
    return buildScheduleCacheKey(chatId, v, c);
}

function loadCachedForCurrentChat(view, charName) {
    const key = getCacheKey(view, charName);
    if (!key) return null;
    try {
        const saved = JSON.parse(localStorage.getItem(key) || 'null');
        if (saved?.raw) return renderSchedule(saved.raw, saved.userName || 'Người dùng', view ?? currentView);
    } catch { /* ignore corrupt cache */ }
    return null;
}

// ─── ST theme detection ───────────────────────────────────────────────────────
// Read ST's --SmartThemeBodyColor (text color on documentElement) to decide
// dark vs light. If it's bright → panel uses dark (night); if dim → light (day).
function detectSTTheme() {
    try {
        const raw = getComputedStyle(document.documentElement)
            .getPropertyValue('--SmartThemeBodyColor').trim();
        if (raw) {
            // Parse rgb/rgba/hex, get perceived luminance
            const canvas = document.createElement('canvas');
            canvas.width = canvas.height = 1;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = raw;
            ctx.fillRect(0, 0, 1, 1);
            const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
            // Relative luminance (sRGB)
            const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
            return lum > 127 ? 'night' : 'day';  // bright text → dark bg (night)
        }
    } catch { /* ignore */ }
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'day' : 'night';
}

// Resolve the effective theme by combining the user's themeMode setting
// with the detected ST theme. 'auto' follows ST (transparent-theme users get
// the day/night fallback via explicit modes instead).
function getEffectiveTheme() {
    const mode = getSettings().themeMode || 'auto';
    if (mode === 'day' || mode === 'night') return mode;
    return detectSTTheme();
}

let currentTheme   = detectSTTheme();
let cachedSchedule = null;
let isGenerating   = false;
let settingsOpen   = false;
let dragState      = null;
let resizeState    = null;
let resizeRAF      = null;
let fabDragged     = false;
let fabDragState   = null;
let currentView        = 'user';  // 'user' | 'char'
let charViewName       = null;    // confirmed char name; preserved when switching to user view
let outlineMode         = false;
let isGeneratingOutline = false;
let cachedOutline       = null;
let outlineChatHistory  = [];
let isOutlineChatting   = false;
let linesMode           = false;
let isGeneratingLines   = false;
let cachedLines         = null;
let linesAbortController = null;
let spaceMode           = false;
let spaceChatHistory    = [];
let isSpaceChatting     = false;
let spaceChatAbortController = null;
let linesAiMsgCounter   = 0;   // counts AI messages since last lines advancement
let scheduleAbortController = null;
let outlineAbortController  = null;
const _injectTexts      = {};
let   _injectIdSeq      = 0;
let viewportSyncBound   = false;

const isMobile = () => window.innerWidth <= 640;

// ─── Init ─────────────────────────────────────────────────────────────────────

// Module-level handles so hot-reload / re-init doesn't double-register.
// If the module loads again in the same page (rare but possible with ST's
// dev workflows), we need to be able to unregister and rewire cleanly.
let _themeObserver = null;
const _stListeners = { chat: null, char: null };

jQuery(async () => {
    injectExtButton();
    injectModal();
    injectFab();
    injectToastContainer();
    // Apply saved theme mode (day/night/auto) now that settings are guaranteed loaded
    applyTheme(getEffectiveTheme());
    // Initialize memory system — wires event listeners internally
    memory.initMemory({
        getSettings: () => {
            const s = getSettings();
            return {
                useBaiBaiBook  : !!s.useBaiBaiBook,
                memoryEnabled  : s.memoryEnabled !== false,
                memoryL0Group  : Number.isFinite(+s.memoryL0Group) ? +s.memoryL0Group : 5,
                memoryL1Group  : Number.isFinite(+s.memoryL1Group) ? +s.memoryL1Group : 10,
                memorySkipShort: Number.isFinite(+s.memorySkipShort) ? +s.memorySkipShort : 50,
            };
        },
        callApi: callMemoryApi,
    });
    // Back-fill inline blocks for any messages already rendered at startup
    setTimeout(backfillLinesInlineBlocks, 800);
    // Reset view state and reload cache on chat switch
    if (_stListeners.chat) eventSource.removeListener?.(event_types.CHAT_CHANGED, _stListeners.chat);
    _stListeners.chat = () => {
        currentView  = 'user';
        charViewName = null;
        outlineMode  = false;
        cachedOutline = null;
        outlineChatHistory = [];
        outlineChatAbortController?.abort();
        outlineChatAbortController = null;
        linesMode    = false;
        cachedLines  = null;
        linesAiMsgCounter = 0;
        _lastDetectedDay  = null;   // days-mode: reset day tracker on chat switch
        spaceMode = false;
        spaceChatHistory = [];
        spaceChatAbortController?.abort();
        spaceChatAbortController = null;
        $('.sp-side-tab.sp-view-btn').removeClass('sp-view-active');
        $(`.sp-side-tab.sp-view-btn[data-view="schedule"]`).addClass('sp-view-active');
        $('.sp-sub-btn').removeClass('sp-view-active');
        $(`.sp-sub-btn[data-view="user"]`).addClass('sp-view-active');
        $('#sp-sub-toggle').show();
        $('#sp-content-title').text('Điểm');
        cachedSchedule = loadCachedForCurrentChat();
        if ($(`#${MODAL_ID}`).is(':visible') && !isGenerating) {
            $('#sp-outline-wrap').hide();
            $('#sp-lines-wrap').hide();
            $('#sp-space-wrap').hide();
            $('#sp-body').show();
            $(`#${MODAL_ID} .sp-outline-btn`).removeClass('sp-btn-active');
            updateCreativeChatModeUI();
            $('#sp-chat-msgs').empty();
            $('#sp-space-msgs').empty();
            if (cachedSchedule) setBody(cachedSchedule);
            else setBody(`<div class="sp-empty"><i class="fa-regular fa-calendar"></i><p>Chưa có Điểm nào</p><button class="sp-gen-btn" id="sp-gen-schedule-now">Tạo Điểm</button></div>`);
        }
        // Back-fill inline blocks for newly loaded chat
        setTimeout(backfillLinesInlineBlocks, 300);
        // Surface memory schema-migration notice, if any (once per upgraded chat)
        setTimeout(checkMemoryMigrationNotice, 500);
    };
    eventSource.on(event_types.CHAT_CHANGED, _stListeners.chat);
    // Auto-advance storylines, then append inline block to every AI message.
    // NOTE: shouldAdvance triggers generation BEFORE appending the current block,
    // so the current (newest, still-unstable) message is NOT included in the LLM
    // context. The advance fires when the PREVIOUS message tips the counter over,
    // and this message just gets the freshly-generated result injected.
    if (_stListeners.char) eventSource.removeListener?.(event_types.CHARACTER_MESSAGE_RENDERED, _stListeners.char);
    _stListeners.char = async (messageId) => {
        let shouldAdvance = false;
        if (getLinesMode() === 'days') {
            shouldAdvance = detectInGameDayChange(messageId, /* excludeCurrent */ true);
        } else {
            const interval = getLinesInterval();
            if (linesAiMsgCounter >= interval) { linesAiMsgCounter = 0; shouldAdvance = true; }
            linesAiMsgCounter++;
        }
        appendLinesInlineBlock(messageId, shouldAdvance);
    };
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, _stListeners.char);
    // Track ST theme changes via MutationObserver on documentElement style
    _themeObserver?.disconnect();
    _themeObserver = new MutationObserver(() => {
        // Only auto mode follows ST; forced day/night ignores ST changes.
        if ((getSettings().themeMode || 'auto') !== 'auto') return;
        const t = detectSTTheme();
        if (t !== currentTheme) applyTheme(t);
    });
    _themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
});

// ─── Config helpers ───────────────────────────────────────────────────────────

// ─── Plugin settings (persisted in ST's settings.json) ────────────────────────

function getSettings() {
    if (!extension_settings[PLUGIN_ID]) extension_settings[PLUGIN_ID] = { ...DEFAULT_SETTINGS };
    return extension_settings[PLUGIN_ID];
}

function loadCfg() {
    const s = getSettings();
    return { url: s.apiUrl || '', key: s.apiKey || '', model: s.apiModel || '' };
}

function saveCfg(c) {
    const s = getSettings();
    s.apiUrl   = c.url   || '';
    s.apiKey   = c.key   || '';
    s.apiModel = c.model || '';
    saveSettingsDebounced();
}

function fabEnabled() { return getSettings().fabShow !== false; }

function getLinesInterval() {
    const v = parseInt(getSettings().linesInterval, 10);
    return Number.isFinite(v) && v >= 1 ? v : 2;
}

function saveLinesInterval(n) {
    getSettings().linesInterval = Math.max(1, parseInt(n, 10) || 2);
    saveSettingsDebounced();
}

function getLinesMode() {
    return getSettings().linesMode === 'days' ? 'days' : 'turns';
}

function saveLinesMode(mode) {
    getSettings().linesMode = (mode === 'days') ? 'days' : 'turns';
    saveSettingsDebounced();
}

function maskKey(k) { return k.length <= 8 ? '•'.repeat(k.length) : '•'.repeat(k.length - 4) + k.slice(-4); }

// ─── In-game day-change detection (via BaiBaiBook API) ─────────────────────────
// Reads authoritative in-game time from BaiBaiBook (ST-BaiBai-Book) instead of
// grepping message text — the old regex heuristic false-positived on every
// mention of "today"/"tomorrow"/"weekday X". Extracts a canonical day key from
// state.time and signals advance only when it actually changes.
let _lastDetectedDay = null;
let _bbbWarned       = false;

// Số Trung văn → số Ả Rập (bao phủ 0–99, đủ để xử lý năm tháng ngày kiểu cổ).
const _CN_NUM_MAP = { 零:0, 〇:0, 一:1, 二:2, 两:2, 三:3, 四:4, 五:5, 六:6, 七:7, 八:8, 九:9, 十:10 };
const _CN_MONTH_ALIAS = { 正:1, 冬:11, 腊:12 };

function _cnToNumber(s) {
    if (!s) return null;
    if (s === '元') return 1;
    if (/^\d+$/.test(s)) return parseInt(s, 10);
    if (s.length === 1) return _CN_NUM_MAP[s] ?? null;
    if (s.includes('十')) {
        const [a, b] = s.split('十');
        const tens = a === '' ? 1 : _CN_NUM_MAP[a];
        const ones = b === '' ? 0 : _CN_NUM_MAP[b];
        if (tens != null && ones != null) return tens * 10 + ones;
    }
    return null;
}

// Trích ra key chuẩn hóa của "ngày này". Bỏ tiền tố kỷ nguyên (era), phần
// giờ/phút/giây và số 0 đứng đầu, để cùng một ngày dù viết khác cách
// ("1287/04/01" ≡ "1287/4/1" ≡ "1287年4月1日") vẫn rơi vào cùng một key.
// Trả về null nghĩa là không nhận diện được → không đẩy tiến.
function extractDayFromTime(timeStr) {
    if (!timeStr || typeof timeStr !== 'string') return null;
    let m;
    // Ả Rập: YYYY年M月D日
    if ((m = timeStr.match(/(\d{2,4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})/))) return `${+m[1]}-${+m[2]}-${+m[3]}`;
    // Ả Rập: YYYY/M/D、YYYY-M-D、YYYY.M.D
    if ((m = timeStr.match(/(\d{2,4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/))) return `${+m[1]}-${+m[2]}-${+m[3]}`;
    // Số ngày tương đối: 第N天/日
    if ((m = timeStr.match(/第\s*(\d+)\s*[天日]/))) return `day-${+m[1]}`;
    // day N
    if ((m = timeStr.match(/day\s*(\d+)/i))) return `day-${+m[1]}`;
    // Trung văn cổ: <cn年>年<cn月/正/冬/腊>月<初X/cn日>[日]?
    m = timeStr.match(/(元|[零〇一二两三四五六七八九十]+)\s*年\s*(正|冬|腊|[零〇一二两三四五六七八九十]+)\s*月\s*(初[零〇一二两三四五六七八九十]|[零〇一二两三四五六七八九十]+)/);
    if (m) {
        const year  = _cnToNumber(m[1]);
        const month = (m[2] in _CN_MONTH_ALIAS) ? _CN_MONTH_ALIAS[m[2]] : _cnToNumber(m[2]);
        const day   = m[3].startsWith('初') ? _cnToNumber(m[3].slice(1)) : _cnToNumber(m[3]);
        if (year != null && month != null && day != null) return `cn-${year}-${month}-${day}`;
    }
    return null;
}

function detectInGameDayChange(messageId, excludeCurrent = false) {
    const api = globalThis.STBaiBaiBook;
    if (!api || typeof api.getSnapshot !== 'function') {
        if (!_bbbWarned) {
            _bbbWarned = true;
            console.info('[7dayscal] STBaiBaiBook chưa sẵn sàng, chế độ days sẽ không tự động đẩy tiến');
        }
        return false;
    }

    const msgs = getContext().chat || [];
    const aiFloors = [];
    for (let i = 0; i < msgs.length; i++) if (!msgs[i].is_user) aiFloors.push(i);
    if (aiFloors.length < (excludeCurrent ? 2 : 1)) return false;

    // Nhất quán với cách làm cũ: khi excludeCurrent=true thì đọc trạng thái của
    // tin nhắn AI trước đó, tránh tin nhắn vừa render xong ("advance BEFORE
    // current message enters context").
    const targetFloor = excludeCurrent
        ? aiFloors[aiFloors.length - 2]
        : aiFloors[aiFloors.length - 1];

    let snapshot;
    try {
        snapshot = api.getSnapshot({ floor: targetFloor, at: 'after' });
    } catch {
        return false;
    }

    const day = extractDayFromTime(snapshot?.state?.time);
    if (!day) return false;

    if (day !== _lastDetectedDay) {
        _lastDetectedDay = day;
        return true;
    }
    return false;
}

// ─── Storylines inline block (appended to AI messages) ────────────────────────

function _buildLinesBlockHtml() {
    const raw = (() => {
        try {
            const key = getLinesCacheKey();
            const saved = key && JSON.parse(localStorage.getItem(key) || 'null');
            return saved?.raw || '';
        } catch { return ''; }
    })();
    const lines = raw ? parseLines(raw) : [];
    if (lines.length) {
        const linesHtml = lines.map(l => {
            const levelNum = parseInt(l.level, 10);
            const level    = Number.isFinite(levelNum) ? Math.max(1, Math.min(4, levelNum)) : 1;
            const stageColor = STAGE_COLORS[l.stage] || '#9aa6b2';
            const beadsHtml = Array.from({length: 4}, (_, i) =>
                `<span class="sp-bead${i < level ? ' sp-bead-on' : ''}" style="${i < level ? `background:${stageColor}` : ''}"></span>`
            ).join('');
            return `<div class="sp-inline-line${l.stall ? ' sp-line-stall' : ''}" style="border-left:3px solid ${stageColor}20">
                <div class="sp-inline-head">
                    <span class="sp-inline-stage" style="color:${stageColor}">${escapeHtml(l.stage)}</span>
                    ${l.type ? `<span class="sp-inline-type">${escapeHtml(l.type)}</span>` : ''}
                    <span class="sp-inline-dots">${beadsHtml}</span>
                    ${l.when ? `<span class="sp-inline-when">${escapeHtml(l.when)}</span>` : ''}
                    ${l.stall ? `<span class="sp-line-stall-tag sp-inline-stall">Đình trệ</span>` : ''}
                    ${agencyBadge(l.agency)}
                </div>
                <div class="sp-inline-name">${escapeHtml(l.name)}</div>
                ${l.desc ? `<div class="sp-inline-desc">${escapeHtml(cleanText(l.desc))}</div>` : ''}
                ${l.next ? `<div class="sp-line-next sp-inline-next ${l.stall ? 'sp-line-next-stall' : 'sp-line-next-go'}">
                    <span class="sp-line-next-tag">${l.stall ? '⏸ Điều kiện phục hồi' : '→ Bước tiếp theo'}</span>
                    <span class="sp-line-next-text">${escapeHtml(cleanText(l.next))}</span>
                </div>` : ''}
            </div>`;
        }).join('');
        return `<summary class="sp-inline-summary"><span class="sp-inline-title">Tuyến</span><span class="sp-inline-count">${lines.length} đang hoạt động</span></summary><div class="sp-inline-body">${linesHtml}</div>`;
    }
    return `<summary class="sp-inline-summary"><span class="sp-inline-title">Tuyến</span><span class="sp-inline-count sp-inline-empty">Chưa có</span></summary>`;
}

// Remove inline lines block from ALL AI messages — enforces "only the latest floor holds it".
function _removeAllInlineBlocks() {
    document.querySelectorAll('#chat .sp-lines-inline').forEach(el => el.remove());
}

async function appendLinesInlineBlock(messageId, shouldAdvance) {
    const msgEl = document.querySelector(`#chat .mes[mesid="${messageId}"] .mes_text`);
    if (!msgEl) return;

    // Enforce single-copy: nuke any prior inline block on any floor (including this one)
    _removeAllInlineBlocks();

    // Immediately render current cached state so the block always appears
    const block = document.createElement('details');
    block.className = 'sp-lines-inline';
    block.innerHTML = _buildLinesBlockHtml();
    msgEl.appendChild(block);

    // If we need to advance, run generation and then update the same block in-place
    const cfg = loadCfg();
    if (shouldAdvance && !isGeneratingLines && cfg.url && cfg.key) {
        await runGenerateLines(true /* silent */);
        // Re-render into the same block element (it may still be in the DOM)
        if (block.isConnected) {
            block.innerHTML = _buildLinesBlockHtml();
        }
    }
}

// Back-fill: only pin the latest AI message — history doesn't need stale snapshots.
async function backfillLinesInlineBlocks() {
    _removeAllInlineBlocks();  // clean up any accumulated blocks from previous state
    const lastMesEl = [...document.querySelectorAll('#chat .mes:not([is_user="true"])')].at(-1);
    if (!lastMesEl) return;
    const mesId = lastMesEl.getAttribute('mesid');
    if (mesId == null) return;
    const msgEl = lastMesEl.querySelector('.mes_text');
    if (!msgEl) return;
    await appendLinesInlineBlock(mesId, false);
}

// Refresh the inline block on the latest AI message using current cache.
// Called after the panel regenerates lines so the message-level block doesn't
// stay stale until page reload.
function syncLatestInlineBlock(expectedChatId = null) {
    // If caller passed a chatId snapshot, skip when chat changed mid-flight
    if (expectedChatId != null && getContext().chatId !== expectedChatId) return;
    _removeAllInlineBlocks();
    const lastMesEl = [...document.querySelectorAll('#chat .mes:not([is_user="true"])')].at(-1);
    if (!lastMesEl) return;
    const msgEl = lastMesEl.querySelector('.mes_text');
    if (!msgEl) return;
    const block = document.createElement('details');
    block.className = 'sp-lines-inline';
    block.innerHTML = _buildLinesBlockHtml();
    msgEl.appendChild(block);
}

// ─── Extensions panel ─────────────────────────────────────────────────────────

function injectExtButton() {
    // No drawer content — panel opened via magic wand or FAB
    const wandHtml = `
        <div id="sp_open_wand" class="list-group-item flex-container flexGap5">
            <div class="fa-solid fa-calendar-days extensionsMenuExtensionButton" title="Mở Lịch Trình"></div>
            <span>Lịch Trình</span>
        </div>`;

    function mountWandBtn() {
        const c = document.getElementById('sp_wand_container') || document.getElementById('extensionsMenu');
        if (!c || document.getElementById('sp_open_wand')) return false;
        c.insertAdjacentHTML('beforeend', wandHtml);
        document.getElementById('sp_open_wand')?.addEventListener('click', openSchedule);
        return true;
    }
    if (!mountWandBtn()) {
        const obs = new MutationObserver(() => { if (mountWandBtn()) obs.disconnect(); });
        obs.observe(document.body, { childList: true, subtree: true });
    }
}

function setExtBtnState(state) {
    const $wandBtn = $('#sp_open_wand');
    $wandBtn.removeClass('sp-btn-generating sp-btn-done');
    if (state) $wandBtn.addClass(`sp-btn-${state}`);

    const $fab = $(`#${FAB_ID} .sp-fab-btn`);
    $fab.removeClass('sp-btn-generating sp-btn-done');
    if (state) $fab.addClass(`sp-btn-${state}`);
    $('.sp-sub-toggle, .sp-sidebar-tabs').toggleClass('sp-locked', state === 'generating');
}

// ─── FAB ─────────────────────────────────────────────────────────────────────

function injectFab() {
    const savedPos = JSON.parse(localStorage.getItem('sp-fab-pos') || 'null');
    const mobile = isMobile();
    const posStyle = (!mobile && savedPos)
        ? `left:${savedPos.left}px;top:${savedPos.top}px;right:auto;bottom:auto;`
        : '';
    const html = `<div id="${FAB_ID}" style="position:fixed;z-index:2000000;${posStyle}${fabEnabled() ? '' : 'display:none'}">
        <button class="sp-fab-btn sp-${currentTheme}" title="Lịch Trình"
            style="width:44px;height:44px;border-radius:50%;background:#3a3648;color:#d0bcff;border:1.5px solid rgba(208,188,255,0.35);display:flex;align-items:center;justify-content:center;font-size:1rem;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,0.5);transform:translateZ(0);clip:auto;">
            <i class="fa-solid fa-calendar-days"></i>
        </button>
    </div>`;
    document.documentElement.insertAdjacentHTML('beforeend', html);

    let wasMobile = isMobile();
    window.addEventListener('resize', () => {
        const nowMobile = isMobile();
        if (nowMobile && !wasMobile) {
            const fab = document.getElementById(FAB_ID);
            if (fab) { fab.style.left = ''; fab.style.top = ''; fab.style.right = ''; fab.style.bottom = ''; }
            const sheet = document.querySelector(`#${MODAL_ID} .sp-sheet`);
            if (sheet) { sheet.style.left = ''; sheet.style.top = ''; sheet.style.right = '';
                         sheet.style.transform = ''; sheet.style.width = ''; sheet.style.height = '';
                         sheet.style.maxHeight = ''; sheet.style.maxWidth = ''; }
        } else if (!nowMobile && wasMobile) {
            const fab = document.getElementById(FAB_ID);
            if (fab) {
                const sp = JSON.parse(localStorage.getItem('sp-fab-pos') || 'null');
                if (sp) {
                    fab.style.left   = Math.min(sp.left, window.innerWidth  - 60) + 'px';
                    fab.style.top    = Math.min(sp.top,  window.innerHeight - 60) + 'px';
                    fab.style.right  = 'auto';
                    fab.style.bottom = 'auto';
                }
            }
        }
        wasMobile = nowMobile;
    });

    $(`#${FAB_ID}`).on('mousedown', function (e) {
        fabDragged = false;
        const el   = document.getElementById(FAB_ID);
        const rect = el.getBoundingClientRect();
        fabDragState = { startX: e.clientX, startY: e.clientY, origLeft: rect.left, origTop: rect.top };
        $(document)
            .on('mousemove.fabdrag', function (ev) {
                if (!fabDragState) return;
                if (Math.abs(ev.clientX - fabDragState.startX) > 5 || Math.abs(ev.clientY - fabDragState.startY) > 5) fabDragged = true;
                if (!fabDragged) return;
                const f = document.getElementById(FAB_ID);
                f.style.left   = Math.max(0, Math.min(fabDragState.origLeft + ev.clientX - fabDragState.startX, window.innerWidth  - f.offsetWidth))  + 'px';
                f.style.top    = Math.max(0, Math.min(fabDragState.origTop  + ev.clientY - fabDragState.startY, window.innerHeight - f.offsetHeight)) + 'px';
                f.style.right  = 'auto';
                f.style.bottom = 'auto';
            })
            .on('mouseup.fabdrag', onFabDragEnd);
    });
    document.getElementById(FAB_ID).addEventListener('touchstart', function (e) {
        fabDragged = false;
        const el   = document.getElementById(FAB_ID);
        const rect = el.getBoundingClientRect();
        fabDragState = { startX: e.touches[0].clientX, startY: e.touches[0].clientY, origLeft: rect.left, origTop: rect.top };
        document.addEventListener('touchmove', onFabTouchMove, { passive: false });
        document.addEventListener('touchend', onFabDragEnd);
    }, { passive: true });

    $(`#${FAB_ID} .sp-fab-btn`).on('click', function () {
        if (!fabDragged) {
            $(`#${MODAL_ID}`).is(':visible') ? closePanel() : openSchedule();
        }
    });
}

function onFabTouchMove(ev) {
    if (!fabDragState) return;
    const ex = ev.touches[0].clientX;
    const ey = ev.touches[0].clientY;
    if (Math.abs(ex - fabDragState.startX) > 5 || Math.abs(ey - fabDragState.startY) > 5) fabDragged = true;
    if (!fabDragged) return;
    ev.preventDefault();
    const f = document.getElementById(FAB_ID);
    f.style.left   = Math.max(0, Math.min(fabDragState.origLeft + ex - fabDragState.startX, window.innerWidth  - f.offsetWidth))  + 'px';
    f.style.top    = Math.max(0, Math.min(fabDragState.origTop  + ey - fabDragState.startY, window.innerHeight - f.offsetHeight)) + 'px';
    f.style.right  = 'auto';
    f.style.bottom = 'auto';
}
function onFabDragEnd() {
    if (fabDragged) {
        const f = document.getElementById(FAB_ID);
        const r = f.getBoundingClientRect();
        localStorage.setItem('sp-fab-pos', JSON.stringify({ left: r.left, top: r.top }));
    }
    fabDragState = null;
    $(document).off('mousemove.fabdrag mouseup.fabdrag');
    document.removeEventListener('touchmove', onFabTouchMove);
    document.removeEventListener('touchend', onFabDragEnd);
}

function injectModal() {
    const cfg = loadCfg();
    const hasCustomApi = !!(cfg.url && cfg.key);
    const html = `
        <div id="${MODAL_ID}" class="sp-root sp-${currentTheme}" style="display:none;position:fixed;z-index:2000001">
            <div class="sp-backdrop"></div>
            <div class="sp-sheet">
                <aside class="sp-sidebar">
                    <nav class="sp-sidebar-tabs" aria-label="Chế độ xem chính">
                        <button class="sp-side-tab sp-view-btn sp-view-active" data-view="schedule">
                            <span class="sp-tab-glyph" aria-hidden="true">▤</span>
                            <span class="sp-tab-label">Điểm</span>
                        </button>
                        <button class="sp-side-tab sp-view-btn" data-view="lines">
                            <span class="sp-tab-glyph" aria-hidden="true">⁝</span>
                            <span class="sp-tab-label">Tuyến</span>
                        </button>
                        <button class="sp-side-tab sp-view-btn" data-view="outline">
                            <span class="sp-tab-glyph" aria-hidden="true">¶</span>
                            <span class="sp-tab-label">Diện</span>
                        </button>
                        <button class="sp-side-tab sp-view-btn" data-view="space">
                            <span class="sp-tab-glyph" aria-hidden="true">‖</span>
                            <span class="sp-tab-label">Gian</span>
                        </button>
                    </nav>
                    <div class="sp-sidebar-spacer"></div>
                    <nav class="sp-sidebar-tabs sp-sidebar-util" aria-label="Công cụ">
                        <button class="sp-side-tab sp-settings-btn" aria-label="Cài đặt">
                            <span class="sp-tab-glyph" aria-hidden="true">⚙</span>
                        </button>
                    </nav>
                </aside>

                <div class="sp-content-col">
                    <header class="sp-content-head">
                        <h1 class="sp-content-title" id="sp-content-title">Điểm</h1>
                        <div class="sp-sub-toggle" id="sp-sub-toggle">
                            <button class="sp-view-btn sp-sub-btn sp-view-active" data-view="user">Tôi</button>
                            <button class="sp-view-btn sp-sub-btn" data-view="char">Họ</button>
                        </div>
                        <div class="sp-head-tools">
                            <button class="sp-icon-btn sp-theme-toggle-btn" title="${themeToggleTitle()}"><i class="fa-solid ${themeToggleIcon()}"></i></button>
                            <button class="sp-icon-btn sp-fab-toggle-btn${fabEnabled() ? ' sp-btn-active' : ''}" title="Nút nổi"><i class="fa-regular fa-circle-dot"></i></button>
                            <button class="sp-icon-btn sp-close-btn"    title="Đóng"><i class="fa-solid fa-xmark" style="font-size:1rem"></i></button>
                        </div>
                    </header>

                    <!-- Settings overlay: covers content-col only, sidebar stays visible -->
                    <div id="sp-settings-overlay" class="sp-settings-overlay" style="display:none">
                        <div class="sp-settings-header">
                            <span class="sp-settings-title"><i class="fa-solid fa-gear"></i> Cài đặt</span>
                            <button class="sp-icon-btn sp-settings-close-btn" title="Đóng cài đặt"><i class="fa-solid fa-xmark"></i></button>
                        </div>
                        <div class="sp-settings-body">

                            <!-- Section 1: API -->
                            <details class="sp-settings-section" open>
                                <summary class="sp-settings-section-title">Cấu hình API</summary>
                                <div class="sp-settings-section-body">
                                    <div class="sp-api-notice ${hasCustomApi ? 'sp-notice-ok' : 'sp-notice-warn'}">
                                        <i class="fa-solid ${hasCustomApi ? 'fa-circle-check' : 'fa-triangle-exclamation'}"></i>
                                        ${hasCustomApi
                                            ? 'Đã cấu hình API riêng, việc tạo ở nền không ảnh hưởng đến trò chuyện'
                                            : 'Chưa cấu hình API riêng: trong lúc tạo sẽ <b>chiếm dụng luồng chat</b>, không thể trò chuyện cùng lúc'}
                                    </div>
                                    <p class="sp-cfg-hint">Để trống sẽ dùng model hiện tại của SillyTavern</p>
                                    <input id="sp-cfg-url" class="sp-input" type="url"
                                           placeholder="Base URL, ví dụ https://api.openai.com/v1"
                                           value="${escapeAttr(cfg.url || '')}">
                                    <div class="sp-key-row">
                                        <input id="sp-cfg-key" class="sp-input sp-key-input" type="password"
                                               placeholder="API Key" value="${escapeAttr(cfg.key || '')}">
                                        <button id="sp-key-toggle" class="sp-eye-btn"><i class="fa-solid fa-eye"></i></button>
                                    </div>
                                    <div class="sp-model-row">
                                        <input id="sp-cfg-model" class="sp-input sp-model-input" type="text"
                                               placeholder="Tên model, ví dụ gpt-4o-mini"
                                               value="${escapeAttr(cfg.model || '')}">
                                        <button id="sp-fetch-models" class="sp-fetch-btn" title="Lấy danh sách model">
                                            <i class="fa-solid fa-list"></i>
                                        </button>
                                    </div>
                                </div>
                            </details>

                            <!-- Section 2: Cài đặt chức năng -->
                            <details class="sp-settings-section">
                                <summary class="sp-settings-section-title">Cài đặt chức năng</summary>
                                <div class="sp-settings-section-body">
                                    <p class="sp-cfg-hint">Chiến lược đẩy tiến sự kiện song song</p>
                                    <div class="sp-mode-row">
                                        <label class="sp-mode-opt">
                                            <input type="radio" name="sp-lines-mode" value="turns" ${getLinesMode() === 'turns' ? 'checked' : ''}>
                                            <span>Theo lượt, mỗi</span>
                                            <input id="sp-lines-interval" class="sp-input sp-interval-input" type="number" min="1" value="${escapeAttr(String(getLinesInterval()))}">
                                            <span>phản hồi AI thì đẩy tiến một lần</span>
                                        </label>
                                        <label class="sp-mode-opt">
                                            <input type="radio" name="sp-lines-mode" value="days" ${getLinesMode() === 'days' ? 'checked' : ''}>
                                            <span>Theo thời gian, đẩy tiến theo thay đổi ngày trong game</span>
                                        </label>
                                    </div>

                                    <p class="sp-cfg-hint" id="sp-scale-hint" style="margin-top:14px">Quy mô tường thuật (lưu theo nhân vật)</p>
                                    <div class="sp-mode-row" id="sp-scale-row">
                                        <!-- populated by refreshScaleRadio() when settings opens -->
                                    </div>
                                </div>
                            </details>

                            <!-- Section 3: Lọc World Info -->
                            <details class="sp-settings-section" id="sp-wi-section">
                                <summary class="sp-settings-section-title">Lọc World Info</summary>
                                <div class="sp-settings-section-body" id="sp-wi-body">
                                    <p class="sp-cfg-hint">Chỉ xử lý World Info tích hợp sẵn trong thẻ nhân vật. Các mục được chọn sẽ gửi cho AI, bỏ chọn thì bỏ qua. Lưu theo nhân vật.</p>
                                    <div id="sp-wi-list" class="sp-wi-list">
                                        <span class="sp-cfg-hint">(Tự động tải khi mở cài đặt)</span>
                                    </div>
                                </div>
                            </details>

                            <!-- Section 4: Kho ký ức câu chuyện -->
                            <details class="sp-settings-section" id="sp-mem-section">
                                <summary class="sp-settings-section-title">Kho ký ức câu chuyện</summary>
                                <div class="sp-settings-section-body" id="sp-mem-body">
                                    <label class="sp-mode-opt sp-mem-source-toggle">
                                        <input type="checkbox" id="sp-mem-source-bbb">
                                        <span>Dùng BaiBaiBook làm nguồn ký ức</span>
                                    </label>
                                    <div id="sp-mem-bbb-status" class="sp-cfg-hint" style="display:none"></div>

                                    <div id="sp-mem-internal">
                                    <p class="sp-cfg-hint">
                                        Khi trò chuyện sẽ tự động tạo tóm tắt khách quan cho từng tin nhắn, làm tư liệu tham khảo khi tạo Điểm / Tuyến / Diện / Gian.
                                        Lưu cùng cuộc trò chuyện (không chiếm bộ nhớ đệm trình duyệt). Tin nhắn mới nhất sẽ không bao giờ bị tóm tắt, để tránh trùng khi reroll.
                                    </p>

                                    <label class="sp-mode-opt">
                                        <input type="checkbox" id="sp-mem-enabled">
                                        <span>Bật ký ức tự động</span>
                                    </label>

                                    <div class="sp-mode-opt">
                                        <span>Mỗi</span>
                                        <input id="sp-mem-l0" class="sp-input sp-interval-input" type="number" min="1" max="30" value="5">
                                        <span>tin nhắn gộp thành một đoạn tóm tắt L0</span>
                                    </div>

                                    <div class="sp-mode-opt">
                                        <span>Mỗi</span>
                                        <input id="sp-mem-l1" class="sp-input sp-interval-input" type="number" min="2" max="30" value="10">
                                        <span>đoạn L0 gộp thành một chương L1</span>
                                    </div>

                                    <div class="sp-mode-opt">
                                        <span>Bỏ qua tin nhắn ngắn (phản hồi AI dưới</span>
                                        <input id="sp-mem-skipshort" class="sp-input sp-interval-input" type="number" min="0" max="500" value="50">
                                        <span>chữ)</span>
                                    </div>

                                    <div id="sp-mem-status" class="sp-mem-status">
                                        <span class="sp-cfg-hint">(Tự động làm mới khi mở cài đặt)</span>
                                    </div>

                                    <div id="sp-mem-progress" class="sp-mem-progress" style="display:none">
                                        <div class="sp-mem-progress-label">Đang xử lý: <span id="sp-mem-progress-count">0/0</span></div>
                                        <div class="sp-mem-progress-bar"><div id="sp-mem-progress-fill" class="sp-mem-progress-fill"></div></div>
                                        <button id="sp-mem-progress-abort" class="sp-abort-btn"><i class="fa-solid fa-circle-stop"></i>Dừng</button>
                                    </div>

                                    <div class="sp-mem-actions">
                                        <button id="sp-mem-check" class="sp-mem-btn">Kiểm tra tính toàn vẹn</button>
                                        <button id="sp-mem-fill" class="sp-mem-btn">Bổ sung phần thiếu</button>
                                        <button id="sp-mem-rebuild" class="sp-mem-btn sp-mem-btn-danger">Xây lại từ đầu</button>
                                    </div>
                                    </div>
                                </div>
                            </details>

                        </div><!-- /sp-settings-body -->
                        <div class="sp-settings-footer">
                            <button id="sp-cfg-save" class="sp-save-btn"><i class="fa-solid fa-floppy-disk"></i> Lưu</button>
                            <span id="sp-cfg-msg" class="sp-cfg-msg"></span>
                        </div>
                    </div><!-- /sp-settings-overlay -->

                    <div class="sp-main">
                        <div class="sp-body" id="sp-body">
                            <div class="sp-empty"><i class="fa-regular fa-calendar"></i><p>Chưa có Điểm nào</p><button class="sp-gen-btn" id="sp-gen-schedule-now">Tạo Điểm</button></div>
                        </div>

                        <div class="sp-outline-wrap" id="sp-outline-wrap" style="display:none">
                            <div class="sp-outline-beats" id="sp-outline-beats">
                                <div class="sp-empty"><i class="fa-solid fa-scroll"></i><p>Hiện chưa có Diện nào, bạn có thể trò chuyện trực tiếp trước, hoặc tạo một bản Diện làm điểm khởi đầu</p><button class="sp-gen-btn sp-outline-gen-btn" id="sp-gen-outline-now">Tạo Diện</button></div>
                            </div>
                            <div class="sp-outline-divider" id="sp-outline-divider">
                                <i class="fa-solid fa-grip-lines"></i>
                            </div>
                            <div class="sp-outline-chat" id="sp-outline-chat">
                                <div class="sp-chat-msgs" id="sp-chat-msgs"></div>
                                <div class="sp-chat-input-row">
                                    <button id="sp-chat-clear" class="sp-icon-btn" title="Xóa cuộc trò chuyện"><i class="fa-solid fa-broom"></i></button>
                                    <input type="text" id="sp-chat-input" class="sp-input" placeholder="Cùng AI bàn về Diện…">
                                    <button id="sp-chat-send" class="sp-icon-btn" title="Gửi"><i class="fa-solid fa-paper-plane"></i></button>
                                </div>
                            </div>
                        </div>

                        <div class="sp-lines-wrap" id="sp-lines-wrap" style="display:none">
                            <div class="sp-lines-list" id="sp-lines-list">
                                <div class="sp-empty"><i class="fa-solid fa-diagram-project"></i><p>Chưa có Tuyến nào đang theo dõi, có thể tạo một bản</p><button class="sp-gen-btn" id="sp-gen-lines-now">Tạo Tuyến</button></div>
                            </div>
                        </div>

                        <div class="sp-space-wrap sp-outline-chat" id="sp-space-wrap" style="display:none;flex-direction:column;flex:1;min-height:0">
                            <div class="sp-chat-msgs" id="sp-space-msgs"></div>
                            <div class="sp-chat-input-row">
                                <button id="sp-space-clear" class="sp-icon-btn" title="Xóa cuộc trò chuyện"><i class="fa-solid fa-broom"></i></button>
                                <input type="text" id="sp-space-input" class="sp-input" placeholder="Trò chuyện ngoài lề: cốt truyện, thiết định, mối quan hệ, kiến thức…">
                                <button id="sp-space-send" class="sp-icon-btn" title="Gửi"><i class="fa-solid fa-paper-plane"></i></button>
                            </div>
                        </div>
                    </div><!-- /sp-main -->

                    <details class="sp-debug-drawer" id="sp-debug-drawer">
                        <summary class="sp-debug-summary">🐛 Đầu vào AI</summary>
                        <pre class="sp-debug-pre" id="sp-debug-pre">(Chưa gửi yêu cầu)</pre>
                        <div class="sp-debug-actions">
                            <button class="sp-debug-copy-btn">Sao chép</button>
                        </div>
                    </details>
                </div><!-- /sp-content-col -->

                <div class="sp-resize-handle" id="sp-resize-handle">
                    <i class="fa-solid fa-up-right-and-down-left-from-center"></i>
                </div>
            </div>
        </div>`;
    document.documentElement.insertAdjacentHTML('beforeend', html);

    if (cfg.key) $('#sp-cfg-key').val(maskKey(cfg.key)).data('real', cfg.key);

    $(`#${MODAL_ID} .sp-close-btn`).on('click',    closePanel);
    $(`#${MODAL_ID} .sp-settings-btn`).on('click', toggleSettings);
    $(`#${MODAL_ID} .sp-settings-close-btn`).on('click', toggleSettings);
    $(`#${MODAL_ID} .sp-fab-toggle-btn`).on('click', function () {
        const nowEnabled = !fabEnabled();
        getSettings().fabShow = nowEnabled;
        saveSettingsDebounced();
        $(`#${FAB_ID}`).toggle(nowEnabled);
        $(this).toggleClass('sp-btn-active', nowEnabled);
    });
    $(`#${MODAL_ID} .sp-theme-toggle-btn`).on('click', cycleThemeMode);
    $(`#${MODAL_ID} .sp-backdrop`).on('click',     closePanel);
    document.getElementById('sp-debug-drawer').addEventListener('toggle', function () {
        if (this.open) {
            document.getElementById('sp-debug-pre').textContent =
                lastDebugPayload ? JSON.stringify(lastDebugPayload, null, 2) : '(Chưa gửi yêu cầu)';
        }
    });
    $(`#${MODAL_ID} .sp-debug-copy-btn`).on('click', function () {
        if (!lastDebugPayload) return;
        navigator.clipboard.writeText(JSON.stringify(lastDebugPayload, null, 2))
            .then(() => { $(this).text('Đã sao chép ✓'); setTimeout(() => $(this).text('Sao chép'), 2000); })
            .catch(() => {});
    });

    // Outline chat
    function doSendChat() {
        const msg = $('#sp-chat-input').val().trim();
        if (msg && !isOutlineChatting) { $('#sp-chat-input').val(''); sendOutlineChat(msg); }
    }
    $('#sp-chat-send').on('click', doSendChat);
    $('#sp-chat-input').on('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSendChat(); } });

    // Delete a single message (leaves the rest alone — user chose "just this one")
    $('#sp-chat-msgs').on('click', '.sp-chat-msg-delete', function () {
        if (isOutlineChatting) return;
        const idx = Number($(this).closest('.sp-chat-msg').attr('data-idx'));
        if (!Number.isInteger(idx) || idx < 0 || idx >= outlineChatHistory.length) return;
        outlineChatHistory.splice(idx, 1);
        saveCreativeChatHistory();
        renderCreativeChatHistory();
    });

    // Edit user message → inline editor
    $('#sp-chat-msgs').on('click', '.sp-chat-msg-edit', function () {
        if (isOutlineChatting) return;
        const $msg = $(this).closest('.sp-chat-msg');
        const idx  = Number($msg.attr('data-idx'));
        if (!Number.isInteger(idx) || idx < 0 || idx >= outlineChatHistory.length) return;
        startInlineEdit($msg, idx);
    });

    $('#sp-chat-clear').on('click', async () => {
        if (isOutlineChatting) return;
        if (!outlineChatHistory.length) return;
        const ok = await spConfirm({
            title: 'Xóa cuộc trò chuyện',
            body : 'Sẽ xóa lịch sử thảo luận của Diện này, không ảnh hưởng đến bản Diện đã tạo.',
            confirmText: 'Xóa',
            cancelText : 'Hủy',
        });
        if (!ok) return;
        outlineChatHistory = [];
        saveCreativeChatHistory();
        $('#sp-chat-msgs').empty();
    });

    // Space chat (Gian)
    function doSendSpaceChat() {
        const msg = $('#sp-space-input').val().trim();
        if (msg && !isSpaceChatting) { $('#sp-space-input').val(''); sendSpaceChat(msg); }
    }
    $('#sp-space-send').on('click', doSendSpaceChat);
    $('#sp-space-input').on('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSendSpaceChat(); } });

    $('#sp-space-msgs').on('click', '.sp-chat-msg-delete', function () {
        if (isSpaceChatting) return;
        const idx = Number($(this).closest('.sp-chat-msg').attr('data-idx'));
        if (!Number.isInteger(idx) || idx < 0 || idx >= spaceChatHistory.length) return;
        spaceChatHistory.splice(idx, 1);
        saveSpaceChatHistory();
        renderSpaceChatHistory();
    });

    $('#sp-space-msgs').on('click', '.sp-chat-msg-edit', function () {
        if (isSpaceChatting) return;
        const $msg = $(this).closest('.sp-chat-msg');
        const idx  = Number($msg.attr('data-idx'));
        if (!Number.isInteger(idx) || idx < 0 || idx >= spaceChatHistory.length) return;
        startSpaceInlineEdit($msg, idx);
    });

    $('#sp-space-clear').on('click', async () => {
        if (isSpaceChatting) return;
        if (!spaceChatHistory.length) return;
        const ok = await spConfirm({
            title: 'Xóa cuộc trò chuyện',
            body : 'Sẽ xóa lịch sử trò chuyện ngoài lề trong Gian.',
            confirmText: 'Xóa',
            cancelText : 'Hủy',
        });
        if (!ok) return;
        spaceChatHistory = [];
        saveSpaceChatHistory();
        $('#sp-space-msgs').empty();
    });
    $('#sp-outline-beats').on('click', '#sp-gen-outline-now', triggerGenerateOutline);
    $('#sp-lines-list').on('click', '#sp-gen-lines-now', triggerGenerateLines);
    $('#sp-body').on('click', '#sp-gen-schedule-now, .sp-refresh-schedule', onRegenClick);
    $('#sp-outline-beats').on('click', '.sp-refresh-outline', triggerGenerateOutline);
    $('#sp-lines-list').on('click', '.sp-refresh-lines', triggerGenerateLines);

    // Inject buttons (event delegation)
    $(`#sp-body, #sp-outline-wrap, #sp-lines-wrap`).on('click', '.sp-inject-btn', function () {
        const text = _injectTexts[$(this).data('iid')];
        if (text) injectToST(text);
    });

    // Abort buttons (event delegation)
    $('#sp-body').on('click', '#sp-abort-generate', () => scheduleAbortController?.abort());
    $('#sp-outline-beats').on('click', '#sp-abort-outline', () => outlineAbortController?.abort());
    $('#sp-lines-list').on('click', '#sp-abort-lines', () => linesAbortController?.abort());

    // Tab switching: sidebar (schedule/outline/lines) + sub-toggle (user/char)
    $(`#${MODAL_ID}`).on('click', '.sp-view-btn', function () {
        if (isGenerating) return;
        const view = $(this).data('view');
        if (!view) return;

        const $btn      = $(this);
        const isSideTab = $btn.hasClass('sp-side-tab');
        const isSubBtn  = $btn.hasClass('sp-sub-btn');

        // Update active state within the button's group
        if (isSideTab) {
            $('.sp-side-tab.sp-view-btn').removeClass('sp-view-active');
            $btn.addClass('sp-view-active');
        } else if (isSubBtn) {
            $('.sp-sub-btn').removeClass('sp-view-active');
            $btn.addClass('sp-view-active');
        }

        // Sidebar clicks
        if (isSideTab) {
            if (view === 'outline') {
                if (outlineMode) return;
                outlineMode = true;
                linesMode = false;
                spaceMode = false;
                $('#sp-body').hide();
                $('#sp-lines-wrap').hide();
                $('#sp-space-wrap').hide();
                $('#sp-outline-wrap').css('display', 'flex');
                $('#sp-sub-toggle').hide();
                $('#sp-content-title').text('Diện');
                loadCreativeChatHistory();
                updateCreativeChatModeUI();
                renderCreativeChatHistory();
                cachedOutline = loadCachedOutlineForCurrentChat();
                if (cachedOutline) setOutlineBody(cachedOutline);
                else setOutlineBody(renderEmptyOutlineState());
                return;
            }
            if (view === 'lines') {
                if (linesMode) return;
                linesMode = true;
                outlineMode = false;
                spaceMode = false;
                $('#sp-body').hide();
                $('#sp-outline-wrap').hide();
                $('#sp-space-wrap').hide();
                $('#sp-lines-wrap').css('display', 'flex');
                $('#sp-sub-toggle').hide();
                $('#sp-content-title').text('Tuyến');
                cachedLines = loadCachedLinesForCurrentChat();
                if (cachedLines) setLinesBody(cachedLines);
                else setLinesBody(renderEmptyLinesState());
                return;
            }
            if (view === 'space') {
                if (spaceMode) return;
                spaceMode = true;
                outlineMode = false;
                linesMode = false;
                $('#sp-body').hide();
                $('#sp-outline-wrap').hide();
                $('#sp-lines-wrap').hide();
                $('#sp-space-wrap').css('display', 'flex');
                $('#sp-sub-toggle').hide();
                $('#sp-content-title').text('Gian');
                $('#sp-space-input').attr('placeholder', getSpaceChatPlaceholder());
                loadSpaceChatHistory();
                renderSpaceChatHistory();
                return;
            }
            // view === 'schedule' — leaving outline/lines/space, restore body
            if (outlineMode) { outlineMode = false; $('#sp-outline-wrap').hide(); }
            if (linesMode)   { linesMode   = false; $('#sp-lines-wrap').hide(); }
            if (spaceMode)   { spaceMode   = false; $('#sp-space-wrap').hide(); }
            $('#sp-body').show();
            $('#sp-sub-toggle').show();
            $('#sp-content-title').text('Điểm');
            $('.sp-sub-btn').removeClass('sp-view-active');
            $(`.sp-sub-btn[data-view="${currentView}"]`).addClass('sp-view-active');
            return;
        }

        // Sub-toggle clicks: user / char (only meaningful when schedule mode)
        if (isSubBtn) {
            if (view === currentView) return;
            if (view === 'char') {
                if (charViewName) {
                    setView('char', charViewName);
                    if (cachedSchedule) setBody(cachedSchedule);
                    else showEmptyGenerate();
                } else {
                    switchToCharView();
                }
            } else {
                setView('user');
                if (cachedSchedule) setBody(cachedSchedule);
                else showEmptyGenerate();
            }
            return;
        }
    });

    $('#sp-cfg-save').on('click',      saveSettings);
    $('#sp-key-toggle').on('click',    toggleKeyVisibility);
    $('#sp-fetch-models').on('click',  fetchModels);
    $('#sp-cfg-key')
        .on('focus', () => { const r = $('#sp-cfg-key').data('real'); if (r) $('#sp-cfg-key').val(r); })
        .on('blur',  () => { const r = $('#sp-cfg-key').val().trim() || $('#sp-cfg-key').data('real') || ''; if (r) $('#sp-cfg-key').data('real', r).val(maskKey(r)); });

    $('#sp-body').on('click', '.sp-tab', function () {
        const idx   = parseInt($(this).data('day'));
        const total = parseInt($('.sp-days-track').data('total')) || 4;
        $('.sp-tab').removeClass('sp-tab-active');
        $(this).addClass('sp-tab-active');
        $('.sp-days-track').css('transform', `translateX(-${idx * 100 / total}%)`);
    });

    // Desktop drag: content header acts as the handle (like a title bar).
    // Skipped on mobile — near-fullscreen sheet doesn't move.
    const dragHandle = document.querySelector(`#${MODAL_ID} .sp-content-head`);
    if (dragHandle) {
        dragHandle.addEventListener('mousedown',  onDragStart);
        dragHandle.addEventListener('touchstart', onDragStart, { passive: false });
    }
    $('#sp-resize-handle').on('mousedown', onResizeStart);
    document.getElementById('sp-resize-handle').addEventListener('touchstart', onResizeStart, { passive: false });

    // Outline divider drag
    let divState = null;
    const divEl  = document.getElementById('sp-outline-divider');
    const chatEl = document.getElementById('sp-outline-chat');
    function onDivStart(e) {
        e.preventDefault();
        const savedH = parseInt(localStorage.getItem('sp-outline-chat-h')) || 210;
        chatEl.style.height = savedH + 'px';
        divState = { startY: e.touches ? e.touches[0].clientY : e.clientY, startH: chatEl.offsetHeight };
        document.addEventListener('mousemove', onDivMove);
        document.addEventListener('mouseup',   onDivEnd);
        document.addEventListener('touchmove', onDivMove, { passive: false });
        document.addEventListener('touchend',  onDivEnd);
    }
    function onDivMove(e) {
        if (!divState) return;
        e.preventDefault();
        const cy   = e.touches ? e.touches[0].clientY : e.clientY;
        const newH = Math.max(80, Math.min(420, divState.startH + divState.startY - cy));
        chatEl.style.height = newH + 'px';
    }
    function onDivEnd() {
        if (!divState) return;
        localStorage.setItem('sp-outline-chat-h', chatEl.offsetHeight);
        divState = null;
        document.removeEventListener('mousemove', onDivMove);
        document.removeEventListener('mouseup',   onDivEnd);
        document.removeEventListener('touchmove', onDivMove);
        document.removeEventListener('touchend',  onDivEnd);
    }
    divEl.addEventListener('mousedown',  onDivStart);
    divEl.addEventListener('touchstart', onDivStart, { passive: false });
    restoreOutlineChatHeight();
    bindMemoryHandlers();
}

// ─── View (Tôi / Họ) ─────────────────────────────────────────────────────────

function onRegenClick() {
    if (outlineMode) {
        triggerGenerateOutline();
        return;
    }
    if (isGenerating) return;
    if (currentView === 'char') {
        // Clear char cache and re-show picker so user can pick a different char.
        // Stash the name first — switchToCharView reads charViewName for pre-fill.
        const key = getCacheKey();
        if (key) localStorage.removeItem(key);
        cachedSchedule = null;
        switchToCharView();   // pre-fills with current charViewName (or guesses)
        charViewName   = null; // clear after picker is rendered
    } else {
        triggerGenerate();
    }
}

function guessCharName(ctx) {
    // Priority 1: char card name
    if (ctx.name2) return ctx.name2;
    // Priority 2: most frequent "Name:" pattern in recent AI messages
    const NOISE = new Set(['series','chapter','note','summary','part','vol','act','scene',
                           'title','author','narrator','system','user','assistant','ai']);
    const msgs = (ctx.chat || []).filter(m => !m.is_user).slice(-20);
    const counts = {};
    for (const m of msgs) {
        const matches = [...(m.mes || '').matchAll(/^([^\s：:「」【\[\n*#]{1,12})[：:]/gm)];
        for (const match of matches) {
            const name = match[1].trim();
            if (name && !/[*#<>{}\[\]|\\]/.test(name) && !NOISE.has(name.toLowerCase()))
                counts[name] = (counts[name] || 0) + 1;
        }
    }
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    return sorted[0]?.[0] || '';
}

function setView(view, charName) {
    currentView = view;
    if (view === 'char') charViewName = charName || null;
    else charViewName = null;   // switching away from char: clear stale name so cache keys can't leak
    $('.sp-view-btn').removeClass('sp-view-active');
    $(`.sp-view-btn[data-view="${view}"]`).addClass('sp-view-active');
    cachedSchedule = loadCachedForCurrentChat();
    cachedOutline  = loadCachedOutlineForCurrentChat();
    outlineChatHistory = [];
    if (outlineMode) {
        loadCreativeChatHistory();
        updateCreativeChatModeUI();
        renderCreativeChatHistory();
    } else {
        $('#sp-chat-msgs').empty();
    }
    if (outlineMode && cachedOutline) setOutlineBody(cachedOutline);
}

function switchToCharView() {
    currentView = 'char';
    const ctx     = getContext();
    // Prefer previously confirmed name; fall back to guessing from chat messages
    const guessed = charViewName || guessCharName(ctx);
    setBody(`<div class="sp-char-picker">
        <p class="sp-char-picker-hint"><i class="fa-solid fa-user-pen"></i> Nhập tên nhân vật muốn xem Điểm</p>
        <div class="sp-char-picker-row">
            <input id="sp-char-name-input" class="sp-input" type="text"
                   placeholder="Tên nhân vật" value="${escapeAttr(guessed)}">
            <button id="sp-char-name-confirm" class="sp-save-btn">Xác nhận</button>
        </div>
        ${guessed ? `<p class="sp-char-picker-sub">Điền sẵn theo cuộc trò chuyện gần đây, có thể sửa trực tiếp</p>` : ''}
    </div>`);
    $('.sp-view-btn').removeClass('sp-view-active');
    $(`.sp-view-btn[data-view="char"]`).addClass('sp-view-active');
    // .off().on() prevents duplicate bindings on repeated calls
    $('#sp-char-name-input').off('keydown.charview').on('keydown.charview', e => { if (e.key === 'Enter') confirmCharView(); });
    $('#sp-char-name-confirm').off('click.charview').on('click.charview', confirmCharView);
    setTimeout(() => { $('#sp-char-name-input').focus().select(); }, 50);
}

function confirmCharView() {
    const name = $('#sp-char-name-input').val().trim();
    if (!name) { $('#sp-char-name-input').focus(); return; }
    setView('char', name);
    if (cachedSchedule) {
        setBody(cachedSchedule);
    } else {
        setBody(`<div class="sp-loading"><div class="sp-spinner"></div><p class="sp-loading-text">Đang lên kế hoạch…</p><button class="sp-abort-btn" id="sp-abort-generate"><i class="fa-solid fa-circle-stop"></i>Dừng tạo</button></div>`);
        if (!isGenerating) {
            isGenerating = true;
            setExtBtnState('generating');
            runGenerate();
        }
    }
}

// ─── Open / close ─────────────────────────────────────────────────────────────

function openSchedule() {
    showPanel();
    if (isGenerating) {
        setBody(`<div class="sp-loading"><div class="sp-spinner"></div><p class="sp-loading-text">Đang lên kế hoạch…</p><button class="sp-abort-btn" id="sp-abort-generate"><i class="fa-solid fa-circle-stop"></i>Dừng tạo</button></div>`);
    } else if (cachedSchedule) {
        setBody(cachedSchedule);
    } else {
        showEmptyGenerate();
    }
    // Surface schema-migration notice for users who upgrade + open the panel
    // without ever switching chat first (rare but possible after fresh install/update)
    checkMemoryMigrationNotice();
}

function showEmptyGenerate() {
    setBody(`<div class="sp-empty">
        <i class="fa-regular fa-calendar"></i>
        <button class="sp-gen-btn" id="sp-gen-now">Tạo Điểm</button>
    </div>`);
    $('#sp-gen-now').on('click', triggerGenerate);
}

function showPanel() {
    const $root  = $(`#${MODAL_ID}`);
    const sheet  = document.querySelector(`#${MODAL_ID} .sp-sheet`);
    // Clear inline animation so the CSS open-animation replays on every show
    if (sheet) sheet.style.animation = '';
    $root.stop(true).css({ display: 'block', opacity: 0 })
         .animate({ opacity: 1 }, 180);
    setTimeout(() => {
        positionPanel();
        syncMobileViewport();
    }, 0);
}

function closePanel() {
    // Dismiss any pending confirm — spConfirm's own handler will resolve(false)
    // via the click handler on the button we simulate here, but since panel close
    // is out-of-band, we just remove the overlay directly; the awaiting Promise
    // will get its CHAT_CHANGED escape hatch on next chat switch. If user reopens
    // without switching, they'll see the confirm was gone and click again.
    $('#sp-confirm .sp-confirm-cancel').trigger('click');
    $(`#${MODAL_ID}`).stop(true).animate({ opacity: 0 }, 150, function () {
        $(this).css('display', 'none');
    });
}

function setBody(html) { $('#sp-body').html(html); }

// ─── Memory pre-check helpers ─────────────────────────────────────────────────
// Show a one-time toast when memory schema migration wiped this chat's summaries.
// Called from CHAT_CHANGED and openSchedule so users see it on the next chat
// switch OR the first time they open the panel post-upgrade.
function checkMemoryMigrationNotice() {
    if (getSettings().useBaiBaiBook) return;      // Người dùng BaiBaiBook không bị ảnh hưởng
    const notice = memory.consumeMigrationNotice?.();
    if (!notice) return;
    const { l0Count, l1Count } = notice;
    const msg = `Kho ký ức câu chuyện đã được nâng cấp: ${l0Count} đoạn L0 + ${l1Count} chương L1 cần tính lại (bấm vào đây để mở cài đặt và bổ sung)`;
    showToast(msg, () => {
        showPanel();
        if (!settingsOpen) toggleSettings();
        // Expand the memory section so the "Bổ sung phần thiếu" button is visible
        $('#sp-mem-section').attr('open', 'open');
    });
}

// Called by the three generation triggers (schedule/outline/lines).
// Returns a Promise<boolean>: true if user wants to continue, false if canceled.
async function memoryPreCheckConfirm() {
    // BaiBaiBook mode: skip built-in report (its "pending" is meaningless here).
    // Instead, warn only if BaiBaiBook itself says coverage is incomplete.
    if (getSettings().useBaiBaiBook) {
        const api = globalThis.STBaiBaiBook;
        if (!api || typeof api.getInjectedHistory !== 'function') {
            return spConfirm({
                title  : 'BaiBaiBook chưa sẵn sàng',
                body   : 'Nguồn ký ức hiện đang chọn là BaiBaiBook, nhưng không phát hiện được API của BaiBaiBook.\nNếu tiếp tục tạo sẽ không có ký ức lịch sử được đưa vào.',
                note   : 'Bạn có thể vào bảng plugin để bật BaiBaiBook trước, hoặc tạm tắt tùy chọn "Dùng BaiBaiBook làm nguồn ký ức" của plugin này.',
                confirmText: 'Vẫn tiếp tục',
                cancelText : 'Hủy',
            });
        }
        try {
            const cov = api.getInjectedHistory()?.coverage;
            if (cov?.complete === false) {
                const miss = cov.missingAiFloors?.length ?? '?';
                return spConfirm({
                    title  : 'Ký ức BaiBaiBook chưa bao phủ đầy đủ',
                    body   : `BaiBaiBook báo thiếu tóm tắt của ${miss} tin nhắn (missingAiFloors).`,
                    note   : 'Nếu tiếp tục tạo sẽ dùng lịch sử hiện tại của BaiBaiBook (có thể chưa đầy đủ). Bạn cũng có thể vào BaiBaiBook để bổ sung trước.',
                    confirmText: 'Tiếp tục tạo',
                    cancelText : 'Hủy',
                });
            }
        } catch {}
        return true;
    }
    const report = memory.getHealthReport();
    // No memory data yet is OK (fresh chat) — only warn when there ARE issues
    const hasPending = report.pending > 0 || report.permaFailed > 0 || report.paused;
    if (!hasPending) return true;
    const lines = [];
    if (report.paused) lines.push('• Hệ thống ký ức đã tạm dừng (thất bại liên tiếp hoặc một tin nhắn lỗi quá 3 lần)');
    if (report.pending > 0)    lines.push(`• Có ${report.pending} tin nhắn đang chờ tóm tắt`);
    if (report.permaFailed > 0) lines.push(`• Có ${report.permaFailed} tin nhắn tóm tắt thất bại vĩnh viễn (cần bổ sung thủ công)`);
    if (report.busy)           lines.push('• Hệ thống ký ức đang tạo ở nền');
    return spConfirm({
        title  : 'Kho ký ức chưa đầy đủ',
        body   : lines.join('\n'),
        note   : 'Nếu tiếp tục tạo sẽ dùng kho ký ức hiện tại (có thể chưa đầy đủ). Bạn cũng có thể sửa trước.',
        confirmText: 'Tiếp tục tạo',
        cancelText : 'Hủy',
    });
}

// Simple modal confirm — returns Promise<boolean>.
// Auto-resolves(false) on CHAT_CHANGED or when the panel closes, so callers
// awaiting the promise won't hang.
function spConfirm({ title, body, note, confirmText = 'Đồng ý', cancelText = 'Hủy' }) {
    return new Promise(resolve => {
        $('#sp-confirm').remove();
        let done = false;
        const finish = (v) => {
            if (done) return;
            done = true;
            $ov.remove();
            eventSource.removeListener?.(event_types.CHAT_CHANGED, onExternalClose);
            resolve(v);
        };
        const onExternalClose = () => finish(false);
        const $ov = $(`<div id="sp-confirm" class="sp-confirm-overlay">
            <div class="sp-confirm-sheet">
                <div class="sp-confirm-head">${escapeHtml(title)}</div>
                <div class="sp-confirm-body">${escapeHtml(body).replace(/\n/g, '<br>')}</div>
                ${note ? `<div class="sp-confirm-note">${escapeHtml(note)}</div>` : ''}
                <div class="sp-confirm-actions">
                    <button class="sp-confirm-cancel">${escapeHtml(cancelText)}</button>
                    <button class="sp-confirm-ok">${escapeHtml(confirmText)}</button>
                </div>
            </div>
        </div>`);
        $ov.find('.sp-confirm-ok').on('click', () => finish(true));
        $ov.find('.sp-confirm-cancel').on('click', () => finish(false));
        $ov.on('click', function (e) { if (e.target === this) finish(false); });
        $(`#${MODAL_ID} .sp-sheet`).append($ov);
        eventSource.on(event_types.CHAT_CHANGED, onExternalClose);
    });
}

// Dynamic loading text: reflect whether memory is currently being built
function loadingHtml(baseText, abortId) {
    // BaiBaiBook mode has no built-in background queue — never show "bổ sung ký ức" text.
    const busy = !getSettings().useBaiBaiBook && memory.isMemoryBusy();
    const text = busy
        ? `Đang bổ sung ký ức và ${baseText}…`
        : `Đang ${baseText}…`;
    return `<div class="sp-loading">
        <div class="sp-spinner"></div>
        <p class="sp-loading-text">${escapeHtml(text)}</p>
        <button class="sp-abort-btn" id="${abortId}"><i class="fa-solid fa-circle-stop"></i>Dừng tạo</button>
    </div>`;
}

// ─── Generation ───────────────────────────────────────────────────────────────

async function triggerGenerate() {
    if (isGenerating) return;
    if (!await memoryPreCheckConfirm()) return;
    const key = getCacheKey();
    if (key) localStorage.removeItem(key);
    cachedSchedule = null;
    isGenerating = true;
    setExtBtnState('generating');
    if (!$(`#${MODAL_ID}`).is(':visible')) showPanel();
    setBody(loadingHtml('lên kế hoạch', 'sp-abort-generate'));
    runGenerate();
}

async function runGenerate() {
    // Snapshot view state — user may switch views while the request is in flight
    const viewSnap = currentView;
    const charSnap = charViewName;
    scheduleAbortController = new AbortController();
    try {
        const ctx      = getContext();
        const userName = ctx.name1 || 'Người dùng';
        const charName = viewSnap === 'char' ? (charSnap || ctx.name2 || 'Nhân vật') : (ctx.name2 || 'Nhân vật');
        const subject  = viewSnap === 'char' ? charName : userName;
        const raw      = await generate(ctx, userName, charName, viewSnap, scheduleAbortController.signal);
        const html     = renderSchedule(raw, subject, viewSnap);

        const cacheKey = getCacheKey(viewSnap, charSnap);
        if (cacheKey) localStorage.setItem(cacheKey, JSON.stringify({ raw, userName: subject, ts: Date.now() }));
        isGenerating = false;
        scheduleAbortController = null;
        setExtBtnState('done');

        if (viewSnap === 'char') charViewName = charSnap;

        const stillOnView = currentView === viewSnap &&
            (viewSnap !== 'char' || charViewName === charSnap);
        if (stillOnView) {
            cachedSchedule = html;
            if ($(`#${MODAL_ID}`).is(':visible')) setBody(html);
            else showToast('Điểm đã tạo xong, bấm để xem', () => { showPanel(); setBody(html); });
        } else {
            showToast('Điểm đã tạo xong, bấm để xem', () => {
                setView(viewSnap, charSnap);
                cachedSchedule = html;
                showPanel();
                setBody(html);
            });
        }
        setTimeout(() => setExtBtnState(null), 6000);
    } catch (err) {
        isGenerating = false;
        scheduleAbortController = null;
        setExtBtnState(null);
        if (err.name === 'AbortError') {
            if ($(`#${MODAL_ID}`).is(':visible') && currentView === viewSnap) showEmptyGenerate();
            return;
        }
        const errHtml = `<div class="sp-error"><i class="fa-solid fa-circle-exclamation"></i><p>Tạo thất bại: ${escapeHtml(err.message || 'Lỗi không xác định')}</p></div>`;
        if ($(`#${MODAL_ID}`).is(':visible') && currentView === viewSnap) setBody(errHtml);
        else showToast('Tạo Điểm thất bại, vui lòng thử lại', null, true);
    }
}

async function generate(ctx, userName, charName, perspective = 'user', signal = null) {
    const cfg = loadCfg();
    if (!cfg.url || !cfg.key) {
        if (!settingsOpen) toggleSettings();
        throw new Error('Vui lòng điền URL và Key của API tùy chỉnh trong phần cài đặt trước');
    }
    const prompt = buildPrompt(userName, charName, perspective);
    return callCustomApi(ctx, prompt, cfg, userName, charName, signal);
}

// Single fetch wrapper for all OpenAI-compatible /chat/completions calls.
async function postChatCompletion({ cfg, messages, maxTokens, temperature, signal = null } = {}) {
    if (!cfg?.url || !cfg?.key) throw new Error('Chưa cấu hình API');
    const body = { model: cfg.model || 'gpt-4o-mini', messages };
    if (Number.isFinite(maxTokens))   body.max_tokens  = maxTokens;
    if (Number.isFinite(temperature)) body.temperature = temperature;
    const res = await fetch(`${cfg.url}/chat/completions`, {
        method : 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.key}` },
        body   : JSON.stringify(body),
        signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 120)}`);
    return (await res.json()).choices?.[0]?.message?.content ?? '';
}

async function callCustomApi(ctx, prompt, cfg, userName, charName, signal = null) {
    const messages = await buildMessages(ctx, prompt, userName, charName);
    lastDebugPayload = { model: cfg.model || 'gpt-4o-mini', messages };
    return postChatCompletion({ cfg, messages, maxTokens: 8192, signal });
}

// Called by memory.js — minimal wrapper around user's configured API.
// Skips chat history / world info; just sends raw messages array through.
async function callMemoryApi(messages, signal = null) {
    return postChatCompletion({
        cfg: loadCfg(),
        messages,
        maxTokens: 800,     // summaries are short
        temperature: 0.3,   // low temp for factual extraction
        signal,
    });
}

// ─── World-info entry filter (per character) ──────────────────────────────────
// Stores disabled entry uids per character in extension_settings.
// Structure: extension_settings[PLUGIN_ID].wiFilter = { [characterId]: [key, ...] }
// where key = "worldName::uid" to survive re-imports and name collisions.

function getWiFilter() {
    const s = getSettings();
    if (!s.wiFilter) s.wiFilter = {};
    return s.wiFilter;
}

function getDisabledKeys(characterId) {
    if (!characterId) return new Set();
    return new Set(getWiFilter()[characterId] || []);
}

function setDisabledKeys(characterId, disabledSet) {
    if (!characterId) return;
    getWiFilter()[characterId] = [...disabledSet];
    saveSettingsDebounced();
}

// ─── Per-character narrative scale ──────────────────────────────────────────
// Controls the granularity of storyline events. 'auto' means the LLM decides
// from card context; explicit values override that.
// Stored: extension_settings[PLUGIN_ID].scale = { [characterId]: 'auto'|'macro'|'meso'|'micro' }
const SCALE_VALUES = ['auto', 'macro', 'meso', 'micro'];
const SCALE_LABELS = {
    auto : 'Tự động (do AI phán đoán theo cốt truyện)',
    macro: 'Vĩ mô (âm mưu / thế lực / đại cục thiên hạ)',
    meso : 'Trung mô (gia tộc / tổ chức / công sở / môn phái)',
    micro: 'Vi mô (quan hệ / tình cảm / đời thường)',
};

function getScaleMap() {
    const s = getSettings();
    if (!s.scale || typeof s.scale !== 'object') s.scale = {};
    return s.scale;
}

function getScale(characterId) {
    if (characterId == null) return 'auto';
    const v = getScaleMap()[characterId];
    return SCALE_VALUES.includes(v) ? v : 'auto';
}

function setScale(characterId, value) {
    if (characterId == null) return;
    getScaleMap()[characterId] = SCALE_VALUES.includes(value) ? value : 'auto';
    saveSettingsDebounced();
}

// Resolve the list of world-book names to load for the current character.
// Priority: character.data.extensions.world (primary linked), then character_book.name.
function getLinkedWorldNames(ctx) {
    const names = new Set();
    const char = ctx.characters?.[ctx.characterId] ?? {};
    const primary = String(char.data?.extensions?.world || '').trim();
    if (primary) names.add(primary);
    // Fallback: some cards only have the embedded name without linking
    const embeddedName = String(char.data?.character_book?.name || '').trim();
    if (embeddedName && !primary) names.add(embeddedName);
    return [...names];
}

// Returns live world-info entries for the current character. Uses ctx.loadWorldInfo
// (the live editable copy), NOT ctx.characters[].data.character_book (stale snapshot).
// Fallback to character_book if no linked world book exists.
// Each item: { key, uid, label, preview, content, source, embedded }
async function getCharBookEntries(ctx) {
    const items = [];
    const seen = new Set();

    // 1. Primary linked world book(s) via loadWorldInfo — live state
    const worldNames = getLinkedWorldNames(ctx);
    for (const name of worldNames) {
        try {
            const data = await ctx.loadWorldInfo(name);
            if (!data?.entries) continue;
            for (const [uid, entry] of Object.entries(data.entries)) {
                if (entry?.disable) continue;
                const label = entry.comment
                    || (Array.isArray(entry.key) ? entry.key.join(', ') : entry.key)
                    || `Mục ${uid}`;
                const preview = String(entry.content || '')
                    .replace(/\s+/g, ' ')
                    .slice(0, 120);
                const key = `${name}::${uid}`;
                if (seen.has(key)) continue;
                seen.add(key);
                items.push({
                    key, uid,
                    label,
                    preview,
                    content: entry.content || '',
                    source : name,
                    embedded: false,
                });
            }
        } catch { /* ignore individual load failure */ }
    }

    // 2. Fallback: character_book embedded in the card (only if no external world worked)
    if (items.length === 0) {
        const char = ctx.characters?.[ctx.characterId] ?? {};
        const charBook = char.data?.character_book;
        if (charBook?.entries?.length) {
            const bookName = charBook.name || 'World Info tích hợp sẵn của nhân vật';
            for (const e of charBook.entries) {
                if (e.disabled) continue;
                const uid = String(e.uid ?? e.id ?? '');
                const label = e.comment
                    || (Array.isArray(e.key) ? e.key.join(', ') : e.key)
                    || `Mục ${uid}`;
                const preview = String(e.content || '')
                    .replace(/\s+/g, ' ')
                    .slice(0, 120);
                const key = `${bookName}::${uid}`;
                if (seen.has(key)) continue;
                seen.add(key);
                items.push({
                    key, uid,
                    label,
                    preview,
                    content: e.content || '',
                    source : bookName,
                    embedded: true,
                });
            }
        }
    }

    return items;
}

async function buildWorldInfoContext(ctx) {
    const characterId = ctx.characterId;
    const disabledKeys = getDisabledKeys(characterId);
    const entries = await getCharBookEntries(ctx);
    const kept = entries
        .filter(e => !disabledKeys.has(e.key))
        .map(e => e.content)
        .filter(Boolean);
    if (!kept.length) return '';
    return `【World Info nhân vật】\n${kept.join('\n\n')}`;
}

// Memory-source dispatcher. When useBaiBaiBook is on, read the same history text
// BaiBaiBook injects into its own prompt; otherwise fall through to the built-in
// L0/L1 store. No fallback between the two — BaiBaiBook mode either returns its
// history or nothing (empty prompt block).
function getMemText() {
    const s = getSettings();
    if (s.useBaiBaiBook) {
        const api = globalThis.STBaiBaiBook;
        if (!api || typeof api.getInjectedHistory !== 'function') {
            if (!getMemText._bbbWarned) {
                getMemText._bbbWarned = true;
                console.info('[7dayscal] Dùng ký ức BaiBaiBook nhưng API chưa sẵn sàng, lần tạo này không có ký ức lịch sử được đưa vào');
            }
            return '';
        }
        try {
            return api.getInjectedHistory()?.relativeText || '';
        } catch (err) {
            console.warn('[7dayscal] BaiBaiBook getInjectedHistory lỗi:', err);
            return '';
        }
    }
    return memory.getMemoryContext();
}

async function buildMessages(ctx, prompt, userName, charName) {
    const char = ctx.characters?.[ctx.characterId] ?? {};
    const wiContext = await buildWorldInfoContext(ctx);

    // Story memory (Plan C: objective memory + view tag)
    const memText = getMemText();
    const memBlock = memText
        ? `【Kho ký ức câu chuyện】Dưới đây là bản tóm tắt khách quan do plugin này tự động tạo trong quá trình trò chuyện, phản ánh các sự kiện và cài cắm then chốt từ sớm nhất đến gần đây. Hãy **ưu tiên tin tưởng mô tả trong kho ký ức**, ngay cả khi nó mâu thuẫn với mô tả trước đó trong thẻ nhân vật/World Info (vì kho ký ức ghi lại trạng thái mới nhất sau các sự kiện). Ưu tiên chú ý những thông tin có ý nghĩa với ${currentView === 'char' ? charName : userName} theo góc nhìn của họ.\n\n${memText}`
        : '';

    const sys  = [
        `Bạn là một người quan sát kiêm trợ lý phân tích tường thuật, có nhiệm vụ phân tích câu chuyện giữa ${userName} và ${charName} theo góc nhìn ngôi thứ ba.`,
        `Không nhập vai bất kỳ nhân vật nào, không dùng ngôi thứ nhất. Mọi đầu ra phải được trần thuật ở ngôi thứ ba.`,
        char.description ? `【Thông tin nền của ${charName}】\n${char.description}` : '',
        char.personality ? `【Tính cách】${char.personality}` : '',
        char.scenario    ? `【Bối cảnh】${char.scenario}`    : '',
        wiContext,
        memBlock,
    ].filter(Boolean).join('\n\n');
    // Only take the last 10 AI replies (+ their paired user messages) to avoid
    // anchoring on dates from early in the conversation.
    const allMsgs = ctx.chat ?? [];
    let aiCount = 0;
    let startIdx = allMsgs.length;
    for (let i = allMsgs.length - 1; i >= 0; i--) {
        if (!allMsgs[i].is_user) aiCount++;
        if (aiCount >= 10) { startIdx = i; break; }
    }
    const history = allMsgs.slice(startIdx).map(m => ({
        role   : m.is_user ? 'user' : 'assistant',
        content: substituteParams(m.mes ?? ''),
    }));
    return [{ role: 'system', content: sys }, ...history, { role: 'user', content: prompt }];
}

// ─── Outline cache helpers ────────────────────────────────────────────────────

function getOutlineCacheKey(view, charName) {
    const chatId = getContext().chatId;
    const v = view ?? currentView;
    const c = charName ?? charViewName;
    return buildOutlineScopedCacheKey(chatId, v, c);
}

function getCreativeChatHistoryKey(view, charName) {
    const chatId = getContext().chatId;
    return buildCreativeChatHistoryKey(chatId, view ?? currentView, charName ?? charViewName);
}

function loadCreativeChatHistory(view, charName) {
    const key = getCreativeChatHistoryKey(view, charName);
    if (!key) {
        outlineChatHistory = [];
        return outlineChatHistory;
    }
    try {
        const saved = JSON.parse(localStorage.getItem(key) || '[]');
        outlineChatHistory = Array.isArray(saved) ? saved.filter(item => item?.role && item?.content) : [];
    } catch {
        outlineChatHistory = [];
    }
    return outlineChatHistory;
}

function saveCreativeChatHistory(view, charName) {
    const key = getCreativeChatHistoryKey(view, charName);
    if (!key) return;
    localStorage.setItem(key, JSON.stringify(outlineChatHistory));
}

function updateCreativeChatModeUI() {
    $('#sp-chat-input').attr('placeholder', getCreativeChatPlaceholder());
}

function renderCreativeChatHistory() {
    const $msgs = $('#sp-chat-msgs');
    $msgs.empty();
    outlineChatHistory.forEach((msg, idx) => {
        appendChatMsg(msg.role === 'assistant' ? 'ai' : msg.role, msg.content, idx);
    });
}

function loadCachedOutlineForCurrentChat(view, charName) {
    const key = getOutlineCacheKey(view, charName);
    if (!key) return null;
    try {
        const saved = JSON.parse(localStorage.getItem(key) || 'null');
        if (saved?.raw) return renderOutline(saved.raw);
    } catch { /* ignore */ }
    return null;
}

// ─── Inject ───────────────────────────────────────────────────────────────────

function makeInjectBtn(text) {
    const id = ++_injectIdSeq;
    _injectTexts[id] = text;
    return `<button class="sp-inject-btn" data-iid="${id}" title="Chèn vào ô nhập"><i class="fa-solid fa-arrow-right-to-bracket"></i></button>`;
}

function injectToST(text) {
    const $ta = $('#send_textarea');
    if (!$ta.length) { showToast('Không tìm thấy ô nhập', null, true); return; }
    const existing = $ta.val();
    const combined = existing && existing.trim() ? `${existing}\n${text}` : text;
    $ta.val(combined).trigger('input');
    showToast('Đã chèn vào ô nhập');
}

// ─── Outline chat ─────────────────────────────────────────────────────────────

function appendChatMsg(role, content, historyIndex = null) {
    const display = content.replace(/<outline_widget[\s\S]*?<\/outline_widget>/gi, '[↑ Đã tạo Diện mới]');
    const cls = role === 'user' ? 'sp-chat-msg-user' : role === 'ai' ? 'sp-chat-msg-ai' : 'sp-chat-msg-system';
    const $msg = $('<div>').addClass(`sp-chat-msg ${cls}`);
    const canAct = role !== 'system' && Number.isInteger(historyIndex);
    if (canAct) $msg.attr('data-idx', historyIndex);
    const contentHtml = escapeHtml(display).replace(/\n/g, '<br>');
    if (canAct) {
        const editBtn = role === 'user'
            ? '<button class="sp-chat-msg-edit" title="Sửa"><i class="fa-solid fa-pen"></i></button>'
            : '';
        $msg.html(`<div class="sp-chat-msg-content">${contentHtml}</div>` +
                  `<div class="sp-chat-msg-actions">${editBtn}` +
                  `<button class="sp-chat-msg-delete" title="Xóa"><i class="fa-solid fa-trash"></i></button></div>`);
    } else {
        $msg.html(contentHtml);
    }
    $msg.appendTo('#sp-chat-msgs');
    const el = document.getElementById('sp-chat-msgs');
    if (el) el.scrollTop = el.scrollHeight;
}

function startInlineEdit($msg, idx) {
    const original = outlineChatHistory[idx]?.content ?? '';
    $msg.find('.sp-chat-msg-content').replaceWith(
        `<textarea class="sp-chat-msg-editor">${escapeHtml(original)}</textarea>`
    );
    $msg.find('.sp-chat-msg-actions').replaceWith(
        '<div class="sp-chat-msg-actions sp-chat-msg-editing">' +
        '<button class="sp-chat-msg-edit-save">Lưu và gửi lại</button>' +
        '<button class="sp-chat-msg-edit-cancel">Hủy</button>' +
        '</div>'
    );
    const $ta = $msg.find('.sp-chat-msg-editor');
    $ta.trigger('focus');
    const val = $ta.val();
    $ta[0].setSelectionRange(val.length, val.length);

    $msg.find('.sp-chat-msg-edit-cancel').on('click', () => {
        renderCreativeChatHistory();
    });
    $msg.find('.sp-chat-msg-edit-save').on('click', () => {
        if (isOutlineChatting) return;
        const newText = $ta.val().trim();
        if (!newText) return;
        // Truncate from this user message onward (drops the paired AI reply too),
        // then rerun sendOutlineChat with the new text.
        outlineChatHistory.splice(idx);
        saveCreativeChatHistory();
        renderCreativeChatHistory();
        sendOutlineChat(newText);
    });
    $ta.on('keydown', e => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            $msg.find('.sp-chat-msg-edit-save').trigger('click');
        } else if (e.key === 'Escape') {
            e.preventDefault();
            renderCreativeChatHistory();
        }
    });
}

async function buildOutlineChatMessages(userMsg) {
    const ctx      = getContext();
    const userName = ctx.name1 || 'Người dùng';
    const charName = currentView === 'char' ? (charViewName || ctx.name2 || 'Nhân vật') : (ctx.name2 || 'Nhân vật');
    let outlineCtx = '';
    try {
        const key  = getOutlineCacheKey();
        const saved = key && JSON.parse(localStorage.getItem(key) || 'null');
        if (saved?.raw) outlineCtx = saved.raw;
    } catch { /* ignore */ }
    const wiContext = await buildWorldInfoContext(ctx);
    const sys = buildCreativeChatSystemPrompt({
        userName,
        charName,
        outlineRaw: outlineCtx,
        wiContext,
    });
    return [{ role: 'system', content: sys }, ...outlineChatHistory, { role: 'user', content: userMsg }];
}

let outlineChatAbortController = null;
const OUTLINE_HISTORY_CAP = 20;   // sliding window: keep last N messages, drop the rest

async function sendOutlineChat(userMsg) {
    if (isOutlineChatting) return;
    outlineChatHistory.push({ role: 'user', content: userMsg });
    // Sliding window: cap history growth so localStorage doesn't bloat.
    // When trim happens all indices shift, so re-render instead of append.
    let trimmed = false;
    if (outlineChatHistory.length > OUTLINE_HISTORY_CAP) {
        outlineChatHistory.splice(0, outlineChatHistory.length - OUTLINE_HISTORY_CAP);
        trimmed = true;
    }
    if (trimmed) renderCreativeChatHistory();
    else appendChatMsg('user', userMsg, outlineChatHistory.length - 1);
    saveCreativeChatHistory();
    isOutlineChatting = true;
    const chatIdSnap = getContext().chatId;
    outlineChatAbortController = new AbortController();
    const $dots = $('<div>').addClass('sp-chat-msg sp-chat-msg-ai sp-chat-thinking').text('…').appendTo('#sp-chat-msgs');
    const el = document.getElementById('sp-chat-msgs');
    if (el) el.scrollTop = el.scrollHeight;
    try {
        const cfg = loadCfg();
        if (!cfg.url || !cfg.key) { if (!settingsOpen) toggleSettings(); throw new Error('Vui lòng cấu hình API trước'); }
        const reply = await postChatCompletion({
            cfg,
            messages: await buildOutlineChatMessages(userMsg),
            maxTokens: 4096,
            signal: outlineChatAbortController.signal,
        });
        if (getContext().chatId !== chatIdSnap) { $dots.remove(); return; }
        outlineChatHistory.push({ role: 'assistant', content: reply });
        saveCreativeChatHistory();
        $dots.remove();
        appendChatMsg('ai', reply, outlineChatHistory.length - 1);
        if (/<outline_widget/i.test(reply)) {
            const pendingRaw = reply;
            const $btn = $('<button class="sp-apply-outline-btn">Áp dụng Diện này</button>');
            $btn.on('click', () => {
                const html = renderOutline(pendingRaw);
                setOutlineBody(html);
                cachedOutline = html;
                const key = getOutlineCacheKey();
                if (key) localStorage.setItem(key, JSON.stringify({ raw: pendingRaw, ts: Date.now() }));
                $btn.text('✓ Đã áp dụng').prop('disabled', true);
            });
            $('<div class="sp-chat-msg sp-chat-msg-system sp-apply-row"></div>').append($btn).appendTo('#sp-chat-msgs');
            const el2 = document.getElementById('sp-chat-msgs');
            if (el2) el2.scrollTop = el2.scrollHeight;
        }
    } catch (err) {
        $dots.remove();
        if (err?.name !== 'AbortError') appendChatMsg('system', `Gửi thất bại: ${err.message}`);
    }
    outlineChatAbortController = null;
    isOutlineChatting = false;
}

// ─── Space chat (Gian: off-scenario OOC) ─────────────────────────────────────
// Mirrors outline chat but talks to the user out of scene as a consultant / knowledge assistant.
// Same context sources (world info + memory + outline for reference), no
// <outline_widget> extraction.

function getSpaceChatHistoryKey(view, charName) {
    const chatId = getContext().chatId;
    return buildSpaceChatHistoryKey(chatId, view ?? currentView, charName ?? charViewName);
}

function loadSpaceChatHistory(view, charName) {
    const key = getSpaceChatHistoryKey(view, charName);
    if (!key) { spaceChatHistory = []; return spaceChatHistory; }
    try {
        const saved = JSON.parse(localStorage.getItem(key) || '[]');
        spaceChatHistory = Array.isArray(saved) ? saved.filter(item => item?.role && item?.content) : [];
    } catch { spaceChatHistory = []; }
    return spaceChatHistory;
}

function saveSpaceChatHistory(view, charName) {
    const key = getSpaceChatHistoryKey(view, charName);
    if (!key) return;
    localStorage.setItem(key, JSON.stringify(spaceChatHistory));
}

function renderSpaceChatHistory() {
    const $msgs = $('#sp-space-msgs');
    $msgs.empty();
    spaceChatHistory.forEach((msg, idx) => {
        appendSpaceChatMsg(msg.role === 'assistant' ? 'ai' : msg.role, msg.content, idx);
    });
}

function appendSpaceChatMsg(role, content, historyIndex = null) {
    const cls = role === 'user' ? 'sp-chat-msg-user' : role === 'ai' ? 'sp-chat-msg-ai' : 'sp-chat-msg-system';
    const $msg = $('<div>').addClass(`sp-chat-msg ${cls}`);
    const canAct = role !== 'system' && Number.isInteger(historyIndex);
    if (canAct) $msg.attr('data-idx', historyIndex);
    const contentHtml = escapeHtml(content).replace(/\n/g, '<br>');
    if (canAct) {
        const editBtn = role === 'user'
            ? '<button class="sp-chat-msg-edit" title="Sửa"><i class="fa-solid fa-pen"></i></button>'
            : '';
        $msg.html(`<div class="sp-chat-msg-content">${contentHtml}</div>` +
                  `<div class="sp-chat-msg-actions">${editBtn}` +
                  `<button class="sp-chat-msg-delete" title="Xóa"><i class="fa-solid fa-trash"></i></button></div>`);
    } else {
        $msg.html(contentHtml);
    }
    $msg.appendTo('#sp-space-msgs');
    const el = document.getElementById('sp-space-msgs');
    if (el) el.scrollTop = el.scrollHeight;
}

function startSpaceInlineEdit($msg, idx) {
    const original = spaceChatHistory[idx]?.content ?? '';
    $msg.find('.sp-chat-msg-content').replaceWith(
        `<textarea class="sp-chat-msg-editor">${escapeHtml(original)}</textarea>`
    );
    $msg.find('.sp-chat-msg-actions').replaceWith(
        '<div class="sp-chat-msg-actions sp-chat-msg-editing">' +
        '<button class="sp-chat-msg-edit-save">Lưu và gửi lại</button>' +
        '<button class="sp-chat-msg-edit-cancel">Hủy</button>' +
        '</div>'
    );
    const $ta = $msg.find('.sp-chat-msg-editor');
    $ta.trigger('focus');
    const val = $ta.val();
    $ta[0].setSelectionRange(val.length, val.length);

    $msg.find('.sp-chat-msg-edit-cancel').on('click', () => renderSpaceChatHistory());
    $msg.find('.sp-chat-msg-edit-save').on('click', () => {
        if (isSpaceChatting) return;
        const newText = $ta.val().trim();
        if (!newText) return;
        spaceChatHistory.splice(idx);
        saveSpaceChatHistory();
        renderSpaceChatHistory();
        sendSpaceChat(newText);
    });
    $ta.on('keydown', e => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            $msg.find('.sp-chat-msg-edit-save').trigger('click');
        } else if (e.key === 'Escape') {
            e.preventDefault();
            renderSpaceChatHistory();
        }
    });
}

async function buildSpaceChatMessages(userMsg) {
    const ctx      = getContext();
    const userName = ctx.name1 || 'Người dùng';
    const charName = currentView === 'char' ? (charViewName || ctx.name2 || 'Nhân vật') : (ctx.name2 || 'Nhân vật');
    let outlineCtx = '';
    try {
        const key   = getOutlineCacheKey();
        const saved = key && JSON.parse(localStorage.getItem(key) || 'null');
        if (saved?.raw) outlineCtx = saved.raw;
    } catch { /* ignore */ }
    const wiContext = await buildWorldInfoContext(ctx);
    const memText   = getMemText();
    const sys = buildSpaceChatSystemPrompt({
        userName,
        charName,
        outlineRaw: outlineCtx,
        wiContext,
        memText,
    });
    return [{ role: 'system', content: sys }, ...spaceChatHistory, { role: 'user', content: userMsg }];
}

const SPACE_HISTORY_CAP = 20;

async function sendSpaceChat(userMsg) {
    if (isSpaceChatting) return;
    spaceChatHistory.push({ role: 'user', content: userMsg });
    let trimmed = false;
    if (spaceChatHistory.length > SPACE_HISTORY_CAP) {
        spaceChatHistory.splice(0, spaceChatHistory.length - SPACE_HISTORY_CAP);
        trimmed = true;
    }
    if (trimmed) renderSpaceChatHistory();
    else appendSpaceChatMsg('user', userMsg, spaceChatHistory.length - 1);
    saveSpaceChatHistory();
    isSpaceChatting = true;
    const chatIdSnap = getContext().chatId;
    spaceChatAbortController = new AbortController();
    const $dots = $('<div>').addClass('sp-chat-msg sp-chat-msg-ai sp-chat-thinking').text('…').appendTo('#sp-space-msgs');
    const el = document.getElementById('sp-space-msgs');
    if (el) el.scrollTop = el.scrollHeight;
    try {
        const cfg = loadCfg();
        if (!cfg.url || !cfg.key) { if (!settingsOpen) toggleSettings(); throw new Error('Vui lòng cấu hình API trước'); }
        const reply = await postChatCompletion({
            cfg,
            messages: await buildSpaceChatMessages(userMsg),
            maxTokens: 4096,
            signal: spaceChatAbortController.signal,
        });
        if (getContext().chatId !== chatIdSnap) { $dots.remove(); return; }
        spaceChatHistory.push({ role: 'assistant', content: reply });
        saveSpaceChatHistory();
        $dots.remove();
        appendSpaceChatMsg('ai', reply, spaceChatHistory.length - 1);
    } catch (err) {
        $dots.remove();
        if (err?.name !== 'AbortError') appendSpaceChatMsg('system', `Gửi thất bại: ${err.message}`);
    }
    spaceChatAbortController = null;
    isSpaceChatting = false;
}




function renderEmptyOutlineState() {
    return `<div class="sp-empty"><i class="fa-solid fa-scroll"></i><p>Hiện chưa có Diện nào, bạn có thể trò chuyện trực tiếp trước, hoặc tạo một bản Diện làm điểm khởi đầu</p><button class="sp-gen-btn sp-outline-gen-btn" id="sp-gen-outline-now">Tạo Diện</button></div>`;
}

function setOutlineBody(html) { $('#sp-outline-beats').html(html); }

// ─── Outline generation ───────────────────────────────────────────────────────

async function triggerGenerateOutline() {
    if (isGeneratingOutline) return;
    if (!await memoryPreCheckConfirm()) return;
    const key = getOutlineCacheKey();
    if (key) localStorage.removeItem(key);
    cachedOutline = null;
    isGeneratingOutline = true;
    setOutlineBody(loadingHtml('phác thảo Diện', 'sp-abort-outline'));
    runGenerateOutline();
}

async function runGenerateOutline() {
    const viewSnap = currentView;
    const charSnap = charViewName;
    const chatIdSnap = getContext().chatId;
    outlineAbortController = new AbortController();
    try {
        const ctx      = getContext();
        const userName = ctx.name1 || 'Người dùng';
        const charName = viewSnap === 'char' ? (charSnap || ctx.name2 || 'Nhân vật') : (ctx.name2 || 'Nhân vật');
        const cfg = loadCfg();
        if (!cfg.url || !cfg.key) {
            if (!settingsOpen) toggleSettings();
            throw new Error('Vui lòng điền URL và Key của API tùy chỉnh trong phần cài đặt trước');
        }
        const prompt   = buildOutlinePrompt(userName, charName, viewSnap);
        const raw      = await callCustomApi(ctx, prompt, cfg, userName, charName, outlineAbortController.signal);

        if (getContext().chatId !== chatIdSnap) {
            isGeneratingOutline = false;
            outlineAbortController = null;
            return;
        }

        const html     = renderOutline(raw);
        const cacheKey = getOutlineCacheKey(viewSnap, charSnap);
        if (cacheKey) localStorage.setItem(cacheKey, JSON.stringify({ raw, ts: Date.now() }));
        isGeneratingOutline = false;
        outlineAbortController = null;
        cachedOutline = html;
        if (outlineMode) setOutlineBody(html);
        else showToast('Diện đã tạo xong, bấm để xem', () => {
            if (!outlineMode) $('.sp-view-btn[data-view="outline"]').trigger('click');
            showPanel();
        });
    } catch (err) {
        isGeneratingOutline = false;
        outlineAbortController = null;
        if (err.name === 'AbortError') {
            if (outlineMode && getContext().chatId === chatIdSnap) setOutlineBody(`<div class="sp-empty"><i class="fa-solid fa-scroll"></i><p>Đã dừng</p></div>`);
            return;
        }
        if (getContext().chatId !== chatIdSnap) return;
        const errHtml = `<div class="sp-error"><i class="fa-solid fa-circle-exclamation"></i><p>Tạo thất bại: ${escapeHtml(err.message || 'Lỗi không xác định')}</p></div>`;
        if (outlineMode) setOutlineBody(errHtml);
        else showToast('Tạo Diện thất bại, vui lòng thử lại', null, true);
    }
}

function buildOutlinePrompt(userName, charName, perspective = 'user') {
    const subject = perspective === 'char' ? charName : userName;
    return `Hãy tạm dừng nhập vai, đóng vai trò biên kịch cố vấn, dựa trên cốt truyện ở trên để tạo đại cương cho câu chuyện hiện tại.
【Quan trọng】Toàn bộ đầu ra phải dùng tiếng Việt (tên người, tên địa danh có thể giữ nguyên văn).

【Bước 1: Phân tích nền tảng câu chuyện】
Trước khi tạo các nút cốt truyện, hãy sắp xếp các nội dung sau trong phần chú thích (300 chữ trở lên):
① Trạng thái hiện tại: hiện trạng, mục tiêu riêng, mâu thuẫn chưa giải quyết của các nhân vật chính trong câu chuyện (bao gồm ${subject} và các nhân vật chủ chốt khác)
② Quan hệ chính - phụ giữa các nhân vật: nhân vật chính cốt lõi, vai phụ quan trọng, thế lực đối lập và trọng số của họ trong cốt truyện
③ Điểm hấp dẫn cảm xúc / sức hút cốt lõi: căng thẳng kịch tính cuốn hút nhất trong câu chuyện này là gì? (ví dụ "lợi dụng lẫn nhau nhưng nảy sinh tình cảm", "cùng chống địch nhưng bất đồng lý tưởng", "cứu chuộc và được cứu chuộc")
④ Hiện trạng và xu hướng phát triển của môi trường bên ngoài: cán cân thế lực hiện tại, khủng hoảng xã hội, sự kiện lớn sắp xảy ra..., cũng như chiều hướng tự nhiên nếu không có can thiệp
⑤ Mô hình cốt truyện: đây là câu chuyện thể loại gì? Động lực nội tại là gì? (ví dụ "cuộc đấu tranh sinh tồn dưới áp bức bên ngoài + diễn biến quan hệ nội bộ" hoặc "hành trình báo thù và cứu chuộc cá nhân")
⑥ Tổng hợp các tuyến truyện: liệt kê ít nhất hai tuyến truyện — 【Tuyến chính】(mục tiêu bên ngoài, nhiệm vụ, đối đầu thế lực bên ngoài) và 【Tuyến cảm xúc】(thay đổi quan hệ tình cảm giữa các nhân vật chính). Nếu cần có thể thêm tuyến trưởng thành cá nhân, tuyến đấu tranh thế lực...
⑦ Mô thức hành vi và đặc điểm phong cách ngôn ngữ của từng nhân vật chính, đảm bảo biểu hiện nhân vật trong các nút khớp với thiết định gốc

【Bước 2: Tạo các nút cốt truyện then chốt, mục tiêu 8 nút】
Các nút phải dựa trên phân tích ở trên, thể hiện mô hình cốt truyện bạn đã xác định.
- Tuyến truyện cần đẩy tiến theo hình xoắn ốc (tiến→lùi→tiến tiếp), không được phát triển theo đường thẳng.
- Các nút bao phủ trọn vẹn vòng cung câu chuyện: trạng thái mở đầu → cọ xát/thăm dò → lần đẩy tiến đầu tiên → vấp ngã/lùi bước → khủng hoảng bùng nổ → bước ngoặt then chốt → dư âm → thế cân bằng mới. Mỗi giai đoạn 1 nút.
- Nội dung Scene và Think của mỗi nút phải đầy đủ, không nén ngắn để giảm chất lượng.

【Yêu cầu về tiêu đề】Trong vòng 10 chữ, mang cảm giác có xuất xứ văn học — lấy từ nguyên câu hoặc cải biên từ thơ cổ có thật, cải biên từ lời bài hát có thật, hoặc mượn lời thoại từ tiểu thuyết/phim ảnh nổi tiếng. Phong cách tiêu đề giữa các nút không nên hoàn toàn giống nhau, ba loại thơ cổ/lời bài hát/tiểu thuyết mỗi loại phải dùng ít nhất một lần. Không tự bịa ra cụm từ văn vẻ không có xuất xứ.

【Giải thích các trường】
Beat: thời điểm diễn ra|tiêu đề|loại|thuộc tuyến truyện nào|kết quả
Scene: cảnh này thực tế đã xảy ra chuyện gì (80-120 chữ)
Subtext: câu nói ai đó không nói ra trong cảnh này, hoặc cảm xúc ẩn chứa trong một hành động vô thức (không quá 40 chữ)
Think: suy nghĩ sáng tác (100-150 chữ), phải bao gồm:
 ① Cách thể hiện sức hút cốt lõi và mô hình cốt truyện
 ② Trạng thái tâm lý hiện tại của (ít nhất một) nhân vật chính
 ③ Tác dụng đẩy tiến đối với từng tuyến truyện
 ④ Đang ở vị trí nào trong vòng xoắn ốc tiến lùi (so với nút trước đó)

【Định dạng đầu ra (tuân thủ nghiêm ngặt)】
<!-- Phân tích câu chuyện: (phân tích của bước 1, 300 chữ trở lên) -->
<outline_widget>
Beat: thời điểm diễn ra|tiêu đề|loại|thuộc tuyến truyện nào|kết quả
Scene: …
Subtext: …
Think: …
(tổng cộng 8 nút, mỗi nút lặp lại cấu trúc trên)
</outline_widget>`;}

// ─── Outline parse / render ───────────────────────────────────────────────────

function parseOutline(raw) {
    const m = raw.match(/<outline_widget[^>]*>([\s\S]*?)<\/outline_widget>/i);
    const content = m ? m[1] : raw;  // fallback: parse raw directly if no widget tag
    const beats = []; let cur = null;
    for (const line of content.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        if (/^Beat\s*:/i.test(t)) {
            if (cur) beats.push(cur);
            const parts = t.replace(/^Beat\s*:\s*/i, '').split('|');
            cur = {
                time   : (parts[0] || '').trim(),
                title  : (parts[1] || '').trim(),
                type   : (parts[2] || '').trim(),
                line   : (parts[3] || '').trim(),
                outcome: (parts[4] || '').trim(),
                scene  : '',
                subtext: '',
                think  : '',
            };
        } else if (/^Scene\s*:/i.test(t) && cur) {
            cur.scene = t.replace(/^Scene\s*:\s*/i, '').trim();
        } else if (/^Subtext\s*:/i.test(t) && cur) {
            cur.subtext = t.replace(/^Subtext\s*:\s*/i, '').trim();
        } else if (/^Think\s*:/i.test(t) && cur) {
            cur.think = t.replace(/^Think\s*:\s*/i, '').trim();
        }
    }
    if (cur) beats.push(cur);
    return beats;
}

function renderOutline(raw) {
    const beats = parseOutline(raw);
    const toolbar = `<div class="sp-panel-toolbar"><button class="sp-panel-refresh sp-refresh-outline" title="Tạo lại Diện"><i class="fa-solid fa-rotate-right"></i></button></div>`;
    if (beats.length === 0) return toolbar + `<div class="sp-raw">${escapeHtml(raw).replace(/\n/g, '<br>')}</div>`;
    const cards = beats.map((b, i) => {
        const injectParts = [`【Tham khảo nút cốt truyện】`, `${b.time}·《${b.title}》${b.type ? '·' + b.type : ''}${b.line ? '（' + b.line + '）' : ''}`];
        if (b.scene)   injectParts.push(b.scene);
        if (b.outcome) injectParts.push(`Kết quả: ${b.outcome}`);
        const injectBtn = makeInjectBtn(injectParts.join('\n'));
        return `
        <div class="sp-beat">
            <div class="sp-beat-head">
                <span class="sp-beat-index">${i + 1}</span>
                <span class="sp-beat-time">${escapeHtml(b.time)}</span>
                ${b.type ? `<span class="sp-beat-type">${escapeHtml(b.type)}</span>` : ''}
                ${b.line ? `<span class="sp-beat-line">${escapeHtml(b.line)}</span>` : ''}
                ${injectBtn}
            </div>
            <div class="sp-beat-title">${escapeHtml(b.title)}</div>
            ${b.outcome ? `<div class="sp-beat-outcome">${escapeHtml(cleanText(b.outcome))}</div>` : ''}
            ${b.scene   ? `<div class="sp-beat-scene">${escapeHtml(cleanText(b.scene))}</div>` : ''}
            ${b.subtext ? `<div class="sp-beat-subtext">"${escapeHtml(cleanText(b.subtext))}"</div>` : ''}
            ${b.think   ? `<details class="sp-beat-think"><summary>Suy nghĩ sáng tác</summary><p>${escapeHtml(cleanText(b.think))}</p></details>` : ''}
        </div>`;
    }).join('');
    // If we parsed few beats but the raw has substantial content, LLM likely
    // deviated from format — surface it so the user isn't silently truncated.
    const rawTail = beats.length < 3
        ? `<details class="sp-debug"><summary>⚠ Chỉ phân tích được ${beats.length} nút</summary><pre class="sp-debug-raw">${escapeHtml(raw)}</pre></details>`
        : '';
    return toolbar + cards + rawTail;
}


// ─── Storylines (Tuyến sự kiện) ──────────────────────────────────────────────

function getLinesCacheKey(view, charName) {
    const chatId = getContext().chatId;
    const v = view ?? currentView;
    const c = charName ?? charViewName;
    return buildLinesScopedCacheKey(chatId, v, c);
}

function loadCachedLinesForCurrentChat(view, charName) {
    const key = getLinesCacheKey(view, charName);
    if (!key) return null;
    try {
        const saved = JSON.parse(localStorage.getItem(key) || 'null');
        if (saved?.raw) return renderLines(saved.raw);
    } catch { /* ignore corrupt cache */ }
    return null;
}

function setLinesBody(html) { $('#sp-lines-list').html(html); }

function renderEmptyLinesState() {
    return `<div class="sp-empty"><i class="fa-solid fa-diagram-project"></i><p>Chưa có Tuyến nào đang theo dõi, có thể tạo một bản</p><button class="sp-gen-btn" id="sp-gen-lines-now">Tạo Tuyến</button></div>`;
}

async function triggerGenerateLines() {
    if (isGeneratingLines) return;
    if (!await memoryPreCheckConfirm()) return;
    // Manual refresh: clear cache so LLM generates fresh instead of just echoing
    // the previous raw. Auto-advance path (CHARACTER_MESSAGE_RENDERED) calls
    // runGenerateLines(true) directly and preserves previousRaw for continuity.
    const key = getLinesCacheKey();
    if (key) localStorage.removeItem(key);
    cachedLines = null;
    isGeneratingLines = true;
    setLinesBody(loadingHtml('suy diễn Tuyến', 'sp-abort-lines'));
    runGenerateLines();
}

async function runGenerateLines(silent = false) {
    const viewSnap = currentView;
    const charSnap = charViewName;
    const chatIdSnap = getContext().chatId;
    linesAbortController = new AbortController();
    try {
        const ctx      = getContext();
        const userName = ctx.name1 || 'Người dùng';
        const charName = viewSnap === 'char' ? (charSnap || ctx.name2 || 'Nhân vật') : (ctx.name2 || 'Nhân vật');
        const cfg = loadCfg();
        if (!cfg.url || !cfg.key) {
            if (!silent && !settingsOpen) toggleSettings();
            throw new Error('Vui lòng điền URL và Key của API tùy chỉnh trong phần cài đặt trước');
        }
        const cacheKey = getLinesCacheKey(viewSnap, charSnap);
        let previousRaw = '';
        try {
            const saved = cacheKey && JSON.parse(localStorage.getItem(cacheKey) || 'null');
            if (saved?.raw) previousRaw = saved.raw;
        } catch { /* ignore corrupt cache */ }
        const prompt = buildLinesPrompt(userName, charName, viewSnap, previousRaw, getScale(ctx.characterId));
        const raw    = await callCustomApi(ctx, prompt, cfg, userName, charName, linesAbortController.signal);

        // Chat may have switched while we were awaiting; do not touch cache or UI in that case
        if (getContext().chatId !== chatIdSnap) {
            isGeneratingLines = false;
            linesAbortController = null;
            return;
        }

        const html   = renderLines(raw);
        if (cacheKey) localStorage.setItem(cacheKey, JSON.stringify({ raw, ts: Date.now() }));
        isGeneratingLines = false;
        linesAbortController = null;
        cachedLines = html;
        // Panel body
        if (linesMode) setLinesBody(html);
        // Sync the inline block on the latest AI message — panel & inline share
        // the same cache; without this the message-level block shows stale data
        // until page reload.
        syncLatestInlineBlock(chatIdSnap);
        if (!linesMode && !silent) showToast('Tuyến đã tạo xong, bấm để xem', () => {
            if (!linesMode) $('.sp-view-btn[data-view="lines"]').trigger('click');
            showPanel();
        });
    } catch (err) {
        isGeneratingLines = false;
        linesAbortController = null;
        if (err.name === 'AbortError') {
            if (linesMode && getContext().chatId === chatIdSnap) setLinesBody(`<div class="sp-empty"><i class="fa-solid fa-diagram-project"></i><p>Đã dừng</p></div>`);
            return;
        }
        if (!silent && getContext().chatId === chatIdSnap) {
            const errHtml = `<div class="sp-error"><i class="fa-solid fa-circle-exclamation"></i><p>Tạo thất bại: ${escapeHtml(err.message || 'Lỗi không xác định')}</p></div>`;
            if (linesMode) setLinesBody(errHtml);
            else showToast('Tạo Tuyến thất bại, vui lòng thử lại', null, true);
        }
    }
}

function buildLinesPrompt(userName, charName, perspective = 'user', previousRaw = '', scale = 'auto') {
    const subject = perspective === 'char' ? charName : userName;

    // ─── Scale-specific guidance ──────────────────────────────────────────
    const SCALE_BLOCKS = {
        macro: `
【Quy mô tường thuật: Vĩ mô】
Thẻ nhân vật này thuộc tường thuật thế giới lớn — võ hiệp / tiên hiệp / triều đình / chiến tranh / tu chân / phiêu lưu dị giới / thời mạt thế, v.v.
- Chủ thể sự kiện nên là **thế lực / tổ chức / tập đoàn / triều đình / nhân vật lớn**, có thể có đại cục thiên hạ, đấu đá thế lực, âm mưu, ân oán giang hồ...
- Với tuyến sự kiện dạng xung đột, các trạng thái "âm ỉ/sắp bùng phát/đã bùng phát" dùng theo nghĩa đen (xung đột bạo lực, chiến sự, truy sát, chính biến...)
- Phạm vi ảnh hưởng của sự kiện: thành / nước / khu vực / thiên hạ
- Cho phép xuất hiện cài cắm mang tính vĩ mô (tin chiến sự từ xa, mật thư triều đình, biến động thế lực, tin đồn giang hồ...)`,
        meso : `
【Quy mô tường thuật: Trung mô】
Thẻ nhân vật này thuộc quy mô cộng đồng/tổ chức — công sở đô thị / gia tộc / thương giới / băng đảng / môn phái / hội nhóm / phá án / trinh thám, v.v.
- Chủ thể sự kiện nên là **nhân vật cụ thể + tổ chức vừa và nhỏ** (công ty, gia tộc, cộng đồng, băng đảng, môn phái, nhóm/tổ)
- Tuyến sự kiện dạng xung đột dùng "âm ỉ/sắp bùng phát/đã bùng phát" để diễn tả đấu đá nội bộ tổ chức, đấu tranh công sở, mâu thuẫn gia tộc, cạnh tranh thương mại, vụ án bí ẩn ngày càng nóng...
- Phạm vi ảnh hưởng của sự kiện: gia tộc / công ty / khu dân cư / trường học / một phần thành phố
- Cài cắm phần lớn là động cơ ngầm của nhân vật cụ thể, lập trường nội bộ tổ chức, giao dịch chưa công khai, manh mối khả nghi...
- **Tránh** các sự kiện quy mô thiên hạ / chiến tranh / triều đình; cũng **tránh** thay đổi tình cảm đơn thuần giữa hai người (đó là vi mô)`,
        micro: `
【Quy mô tường thuật: Vi mô】
Thẻ nhân vật này thuộc quy mô đời thường/quan hệ thân mật — học đường / yêu đương / sống chung / thầy trò / chữa lành / sống chậm, v.v.
- Chủ thể sự kiện là **vài người cụ thể** (${subject}, bạn thân / người nhà / bạn học / đồng nghiệp xung quanh)
- **Cấm** xuất hiện các khái niệm vĩ mô như "thế lực", "hành động tổ chức", "âm mưu", "triều đình", "chiến sự", "băng đảng"
- **Cấm** xuất hiện xung đột bạo lực, truy sát, đối kháng mang tính hệ thống, khủng hoảng lớn
- Các trạng thái "manh nha/âm ỉ/sắp bùng phát/đã bùng phát" của tuyến sự kiện dạng xung đột nên được hiểu là **nút thắt tâm lý hình thành / căng thẳng trong quan hệ / trước thềm giãi bày / bùng nổ cảm xúc** — chỉ liên quan đến động thái cảm xúc và quan hệ giữa những người cụ thể
- Tuyến sự kiện dạng đẩy tiến phù hợp để diễn tả: tiến triển thầm thích / chuẩn bị thi cử / kế hoạch làm thêm / mục tiêu học tập / hình thành thói quen / món quà bí mật đang chuẩn bị, v.v.
- Các loại cài cắm được phép:
  * Lời ai đó chưa nói ra / khoảnh khắc định nói rồi thôi
  * Căng thẳng ngầm trong một mối quan hệ
  * Nút thắt tâm lý, chuyện cũ, hiểu lầm chưa được giải quyết
  * Thay đổi nhỏ trong cuộc sống (thói quen mới, nơi chốn mới, người liên hệ mới)
  * Việc cụ thể còn treo lại trong gia đình hoặc trường học/công sở
- Phạm vi ảnh hưởng của sự kiện: cá nhân + nhóm bạn thân`,
    };

    const AUTO_HEADER = `
【Quy mô tường thuật: Tự động phán đoán】
Trước khi suy diễn, hãy phán đoán quy mô của câu chuyện hiện tại dựa trên mô tả thẻ nhân vật, thiết định bối cảnh, nội dung trò chuyện gần đây:
- **Vĩ mô**: liên quan thiên hạ / triều đình / thế lực / giang hồ / chiến sự / tu chân... — dùng sự kiện thuộc loại tường thuật hoành tráng
- **Trung mô**: liên quan tổ chức / công ty / gia tộc / môn phái / băng đảng — dùng tường thuật quy mô vừa, nhân vật cụ thể + tổ chức nhỏ
- **Vi mô**: học đường / yêu đương / đời thường / quan hệ thân mật — chỉ có con người cụ thể và cảm xúc, cấm các khái niệm vĩ mô như thế lực/âm mưu/xung đột bạo lực
Sau khi phán đoán, hãy chọn loại sự kiện đúng theo quy mô tương ứng một cách nghiêm ngặt, không lấy ví dụ vượt quy mô.`;

    const scaleBlock = SCALE_BLOCKS[scale] || AUTO_HEADER;

    return `Hãy tạm dừng nhập vai, đóng vai trò biên kịch cố vấn, dựa trên cốt truyện ở trên để theo dõi các "tuyến sự kiện" đang diễn ra trong câu chuyện hiện tại.
【Quan trọng】Toàn bộ đầu ra phải dùng tiếng Việt (tên người, tên địa danh có thể giữ nguyên văn).
${scaleBlock}

Tuyến sự kiện là những đầu việc chính độc lập với hành động trực tiếp của ${subject}, cần được theo dõi liên tục qua nhiều lượt. Mỗi tuyến thuộc một trong hai loại:
- Dạng xung đột (conflict): manh nha → âm ỉ → sắp bùng phát → đã bùng phát (hoặc đã tan biến)
- Dạng đẩy tiến (progress): chuẩn bị → thực hiện → then chốt → đã hoàn thành (hoặc đã thất bại)

【Thuộc tính đẩy tiến agency (bắt buộc)】
- player: sự kiện đẩy tiến phụ thuộc vào hành động chủ động của ${subject} (ví dụ: ủy thác mà ${subject} đã nhận lời, mối quan hệ đã kết, việc đã đảm nhận)
- world: sự kiện tự diễn biến ở tầng thế giới / người khác / môi trường, ${subject} không động vào nó vẫn tiến triển (ví dụ cụ thể xin xem loại tương ứng ở khối "Quy mô tường thuật" phía trên)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【Nhiệm vụ cốt lõi của mỗi lần suy diễn — thực hiện theo thứ tự này】
1. **Chủ động đào cài cắm mới**: trước tiên đọc lại toàn bộ cốt truyện gần đây, tìm ra những mầm mống sự kiện mới có thể bị bỏ sót, cài cắm, ẩn ý trong lời thoại NPC, chi tiết bối cảnh, thay đổi lập trường của nhân vật phụ..., đánh giá xem có đáng để tạo tuyến sự kiện mới không.
2. **Phán đoán gộp/tách**: nếu mầm mống mới là phần nối dài của cùng một sự việc với tuyến sự kiện đã có, thì cập nhật tuyến cũ (xem quy tắc gộp bên dưới); nếu là tuyến chính độc lập, thì tạo mới.
3. **Cập nhật tuyến sự kiện đã có**: đẩy tiến / đình trệ / kết thúc các tuyến sự kiện đã có dựa trên cốt truyện mới nhất.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

【Tạo mới hay gộp — tiêu chí phán đoán】
Ưu tiên cân nhắc tạo mới khi:
- Cốt truyện xuất hiện chủ thể độc lập mới (nhân vật mới / địa điểm mới / tổ chức mới / mối quan hệ mới) mang động cơ hoặc mục tiêu có thể tiếp diễn
- Đối thoại/cảnh đã có cài cắm mới (nhân vật lỡ lời, hành động bất thường, ẩn ý sâu xa)
- Xuất hiện tín hiệu bên ngoài mới (thay đổi môi trường, tin tức, tin đồn, hành động của phía khác, hoặc tuyên bố mới của nhân vật)
- Một nhân vật phụ lần đầu thể hiện lập trường hoặc kế hoạch

Gộp vào tuyến sự kiện đã có khi:
- Nội dung mới rõ ràng là giai đoạn tiếp theo hoặc bước con của sự kiện đã có
- Chủ thể, mục tiêu, động cơ hoàn toàn trùng với tuyến sự kiện đã có, chỉ khác chi tiết thực hiện

**Nguyên tắc phán đoán**: thà tạo mới rồi gộp sau, còn hơn vì "có liên quan chút ít" mà nhét hết vào tuyến cũ. Chỉ gộp khi "chắc chắn là cùng một sự việc"; không rõ thì tạo mới.

【Các trường hợp cấm tạo tuyến sự kiện — nghiêm ngặt nhưng chỉ áp dụng cho các loại sau】
- Việc đã hoàn thành/đã phân định thắng thua/không cần theo dõi tiếp
- Hành động cảnh đơn lẻ, tương tác đời thường, việc thông thường có thể khép lại ngay trong cảnh hiện tại
- Thuần cảm xúc, không khí, suy nghĩ nội tâm (chưa được thể hiện ra)
- Tách nhiều bước thực hiện của cùng một đầu việc thành nhiều tuyến khác nhau

【Ràng buộc nhịp độ đẩy tiến】
- Mỗi lần đẩy tiến thường chỉ tiến một giai đoạn; không có tín hiệu cốt truyện rõ ràng thì không nhảy qua nhiều giai đoạn.
- Tránh để nhiều tuyến sự kiện cùng lúc đi vào mức độ cao (đã bùng phát / then chốt) trong cùng một lần suy diễn.
- Khi tuyến sự kiện đã có không có tín hiệu tiến triển rõ ràng trong cốt truyện, dùng stall=true để giữ nguyên stage, và desc ghi rõ lý do đình trệ — đừng bịa ra sự đẩy tiến chỉ để trông có vẻ có thay đổi.
- Dạng xung đột đặc biệt cần kiềm chế: chỉ khi có dấu hiệu leo thang rõ ràng mới chuyển từ "manh nha" sang "âm ỉ".

【Phán định kết cục】
- "Đã bùng phát" / "Đã tan biến" / "Đã hoàn thành" / "Đã thất bại" là kết cục, một khi vào trạng thái này không được lùi lại.
- stall không phải là kết cục; chỉ cần vẫn còn khả năng phục hồi thì dùng stall=true, không đánh dấu kết cục.
- Những tuyến sự kiện đã kết thúc và đã qua nhiều lượt có thể không cần xuất ra nữa.

【Các tuyến sự kiện đang theo dõi hiện tại】
${previousRaw ? previousRaw : '(Không có, đây là lần tạo đầu tiên. Hãy rút ra 2-4 tuyến sự kiện từ cốt truyện hiện tại; lần tạo đầu không nên để cấp độ dạng xung đột vượt quá 2)'}

**Lưu ý**: dù đã có khá nhiều tuyến sự kiện, vẫn hãy đọc lại một lượt cốt truyện gần đây, chủ động tìm xem có mầm mống mới nào không. Lý tưởng là mỗi lần suy diễn đều có 1-2 tuyến mới hoặc có tiến triển thực chất, cốt truyện mới có sức sống. Tổng số không quá 6 tuyến; những sự kiện cũ đã kết thúc hoặc không còn quan trọng thì không cần xuất ra.

【Định dạng đầu ra (tuân thủ nghiêm ngặt, phải xuất đủ ba dòng)】
<storylines_widget>
Line: tên|loại(conflict/progress)|giai đoạn|cấp độ(1-4)|mốc thời gian(ví dụ "sáng nay"/"ba ngày nữa", cấm dùng "lượt thứ N")|agency(player/world)|stall(true/false)
Desc: mô tả trạng thái hiện tại, bối cảnh then chốt, các nhân vật/thế lực liên quan và lập trường của họ (60-100 chữ, viết về hiện trạng, không viết "sắp tới sẽ...")
Next: **bắt buộc phải xuất, không được bỏ qua**. Một câu đưa ra tín hiệu tương lai (20-40 chữ). Khi stall=true thì viết "điều kiện phục hồi" (điều gì kích hoạt để đẩy tiến trở lại); khi stall=false thì viết "bước tiếp theo" (hành động tiếp theo khả dĩ nhất, sự kiện xúc tác cho giai đoạn sau, hoặc bước ngoặt then chốt sắp xuất hiện).
(mỗi tuyến sự kiện lặp lại ba dòng trên)
</storylines_widget>`;
}

// ─── Storylines parse / render ────────────────────────────────────────────────

function parseLines(raw) {
    const m = raw.match(/<storylines_widget[^>]*>([\s\S]*?)<\/storylines_widget>/i);
    const content = m ? m[1] : raw;  // fallback: parse raw directly if no widget tag
    const lines = []; let cur = null;
    for (const rawLine of content.split('\n')) {
        const t = rawLine.trim();
        if (!t) continue;
        if (/^Line\s*:/i.test(t)) {
            if (cur) lines.push(cur);
            const parts = t.replace(/^Line\s*:\s*/i, '').split('|');
            const agencyRaw = (parts[5] || '').trim().toLowerCase();
            const stallRaw  = (parts[6] || '').trim().toLowerCase();
            cur = {
                name  : (parts[0] || '').trim(),
                type  : (parts[1] || '').trim(),
                stage : (parts[2] || '').trim(),
                level : (parts[3] || '').trim(),
                when  : (parts[4] || '').trim(),
                // Backward-compat migration: missing agency → 'world', missing stall → false
                agency: agencyRaw === 'player' ? 'player' : 'world',
                stall : stallRaw === 'true' || stallRaw === '1' || stallRaw === 'yes',
                desc  : '',
                next  : '',
            };
        } else if (/^Desc\s*:/i.test(t) && cur) {
            cur.desc = t.replace(/^Desc\s*:\s*/i, '').trim();
        } else if (/^Next\s*:/i.test(t) && cur) {
            cur.next = t.replace(/^Next\s*:\s*/i, '').trim();
        }
    }
    if (cur) lines.push(cur);
    return lines;
}

// ─── Agency SVG icons (person / globe) ────────────────────────────────────────
// Pure stroke, currentColor, 20×20 viewBox — inherits container text color.
const AGENCY_ICONS = {
    player: '<svg class="sp-agency-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-label="Cần thúc đẩy"><circle cx="10" cy="7" r="3"/><path d="M4 17 c1-3 4-5 6-5 s5 2 6 5"/></svg>',
    world : '<svg class="sp-agency-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-label="Tự diễn biến"><circle cx="10" cy="10" r="7"/><ellipse cx="10" cy="10" rx="3" ry="7"/><path d="M3 10 h14"/></svg>',
};
const AGENCY_LABELS = { player: 'Cần thúc đẩy', world: 'Tự diễn biến' };

function agencyBadge(agency) {
    const key = agency === 'player' ? 'player' : 'world';
    return `<span class="sp-agency-badge sp-agency-${key}" title="${AGENCY_LABELS[key]}">${AGENCY_ICONS[key]}</span>`;
}

const STAGE_COLORS = {
    'manh nha': '#d6b85a', 'âm ỉ': '#d98a3d', 'sắp bùng phát': '#cf5f3f', 'đã bùng phát': '#b93f3f', 'đã tan biến': '#888888',
    'chuẩn bị': '#7de9d9', 'thực hiện': '#58e8b3', 'then chốt': '#2a8a5d', 'đã hoàn thành': '#1b5e3b', 'đã thất bại': '#888888',
};

function renderLines(raw) {
    const lines = parseLines(raw);
    const toolbar = `<div class="sp-schedule-header">
        <span class="sp-user-chip">Sự kiện song song</span>
        <button class="sp-panel-refresh sp-refresh-lines" title="Tạo lại Tuyến"><i class="fa-solid fa-rotate-right"></i></button>
    </div>`;
    if (lines.length === 0) return toolbar + `<div class="sp-raw">${escapeHtml(raw).replace(/\n/g, '<br>')}</div>`;
    const cards = lines.map(l => {
        const levelNum  = parseInt(l.level, 10);
        const level     = Number.isFinite(levelNum) ? Math.max(1, Math.min(4, levelNum)) : 1;
        const stageColor = STAGE_COLORS[l.stage] || '#9aa6b2';
        const beadsHtml = Array.from({length: 4}, (_, i) =>
            `<span class="sp-bead${i < level ? ' sp-bead-on' : ''}" style="${i < level ? `background:${stageColor}` : ''}"></span>`
        ).join('');
        const injectParts = [`【Tham khảo Tuyến】${l.name}（${l.type}·${l.stage}${l.stall ? '·Đình trệ' : ''}）`];
        if (l.desc) injectParts.push(l.desc);
        if (l.next) injectParts.push((l.stall ? 'Điều kiện phục hồi: ' : 'Bước tiếp theo: ') + l.next);
        const injectBtn = makeInjectBtn(injectParts.join('\n'));
        const stallCls  = l.stall ? ' sp-line-stall' : '';
        const stallTag  = l.stall ? `<span class="sp-line-stall-tag">Đình trệ</span>` : '';
        const nextRow   = l.next
            ? `<div class="sp-line-next ${l.stall ? 'sp-line-next-stall' : 'sp-line-next-go'}">
                    <span class="sp-line-next-tag">${l.stall ? '⏸ Điều kiện phục hồi' : '→ Bước tiếp theo'}</span>
                    <span class="sp-line-next-text">${escapeHtml(cleanText(l.next))}</span>
               </div>`
            : '';
        return `
        <div class="sp-beat sp-line-card${stallCls}" style="border-left:3px solid ${stageColor}30">
            <div class="sp-beat-head">
                <span class="sp-beat-type" style="color:${stageColor}">${escapeHtml(l.stage)}</span>
                ${l.type ? `<span class="sp-beat-line">${escapeHtml(l.type)}</span>` : ''}
                <span class="sp-beat-time">${beadsHtml}</span>
                ${l.when ? `<span class="sp-beat-time">${escapeHtml(l.when)}</span>` : ''}
                ${stallTag}
                ${agencyBadge(l.agency)}
                ${injectBtn}
            </div>
            <div class="sp-beat-title">${escapeHtml(l.name)}</div>
            ${l.desc ? `<div class="sp-beat-scene">${escapeHtml(cleanText(l.desc))}</div>` : ''}
            ${nextRow}
        </div>`;
    }).join('');
    return toolbar + cards;
}


function buildPrompt(userName, charName, perspective = 'user') {
    const subject   = perspective === 'char' ? charName : userName;
    const companion = perspective === 'char' ? userName : charName;
    return `Hãy tạm dừng nhập vai, đứng ở góc nhìn người quan sát dựa trên cốt truyện ở trên, để tạo lịch trình cho ${subject}.
【Quan trọng】Toàn bộ đầu ra phải dùng tiếng Việt (tên người, tên địa danh có thể giữ nguyên văn).

Sự kiện chia làm ba loại:
- main (tuyến nổi): sự kiện ${subject} trực tiếp tham gia, đang diễn ra
- hidden (tuyến ngầm): cài cắm tiềm ẩn, hướng đi còn bỏ ngỏ
- bond (tuyến duyên): sự kiện có thể xảy ra hoặc sâu đậm thêm giữa ${subject} và ai đó (không giới hạn ở ${companion}, có thể là bất kỳ nhân vật quan trọng nào)

${subject} và ${companion} đều có cuộc sống riêng độc lập, sự kiện có thể liên quan đến bất kỳ NPC và bên thứ ba nào, không nhất thiết mỗi sự kiện đều phải xoay quanh tương tác giữa hai người.

Day 1-3 mỗi ngày tạo 1 đến 3 sự kiện; khối Future tạo 5 đến 10 sự kiện, không giới hạn khoảng thời gian.

【Giải thích các trường】
Định dạng: Event: type|title|description|time|location|diễn biến liên đới
- type chỉ có thể là main / hidden / bond
- description: theo góc nhìn của ${subject}, giọng điệu đời thường, từ 30 chữ trở lên
- diễn biến liên đới: diễn biến cùng thời điểm của các nhân vật khác liên quan đến sự kiện này, có thể là bất kỳ NPC hoặc bên thứ ba nào, từ 30 chữ trở lên; nếu không có nhân vật liên quan thì có thể để trống

【Giải thích về ngày tháng】
Day 1 nên bắt đầu từ mốc thời gian hiện tại của cốt truyện, suy diễn tiếp về sau. Nếu từ cốt truyện có thể suy ra rõ ngày hiện tại thì điền StartDate, nếu không thì bỏ qua. Không được điền lùi về ngày đã xảy ra trong quá khứ, Day 1 phải là thời điểm "hiện tại" của cốt truyện hoặc sau đó.

【Định dạng đầu ra (tuân thủ nghiêm ngặt, chỉ xuất theo cấu trúc sau)】
<!-- Suy nghĩ về lịch trình: (sắp xếp dựa trên suy diễn cốt truyện, 100 chữ trở lên) -->
<calendar_widget>
StartDate: YYYY-MM-DD (điền nếu suy ra được từ cốt truyện, nếu không thì bỏ qua dòng này)
Day: 1
Event: type|title|description|time|location|diễn biến liên đới
Event: type|title|description|time|location|diễn biến liên đới
Day: 2
Event: type|title|description|time|location|diễn biến liên đới
Event: type|title|description|time|location|diễn biến liên đới
Day: 3
Event: type|title|description|time|location|diễn biến liên đới
Event: type|title|description|time|location|diễn biến liên đới
Future:
Event: type|title|description|time|location|diễn biến liên đới
</calendar_widget>

【Giải thích về Future】
Khối Future thu thập các đầu việc tương lai xuất hiện trong cốt truyện, không giới hạn thời gian.
Cho phép suy đoán hợp lý dựa trên chiều hướng cốt truyện, nhưng không được bịa đặt những giao ước hay lời hứa chưa từng được nhắc đến trong cốt truyện.`;
}

// ─── Settings ─────────────────────────────────────────────────────────────────

async function fetchModels() {
    const url = $('#sp-cfg-url').val().trim().replace(/\/$/, '');
    const key = ($('#sp-cfg-key').data('real') || $('#sp-cfg-key').val()).trim();
    if (!url || !key) { showToast('Vui lòng điền URL và Key trước', null, true); return; }

    const $btn = $('#sp-fetch-models');
    $btn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i>');
    try {
        const res = await fetch(`${url}/models`, {
            headers: { 'Authorization': `Bearer ${key}` },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const models = (data.data || data.models || [])
            .map(m => (typeof m === 'string' ? m : m.id))
            .filter(Boolean).sort();
        if (!models.length) throw new Error('API không trả về model nào');

        // Replace input with a native <select> — browser handles the popup
        // (Android → fullscreen picker with search, desktop → dropdown with
        // scrollbar). No `appearance: none` here on purpose: users need the
        // visible dropdown arrow to know it's clickable, and the native picker
        // is the most reliable cross-platform choice for long lists (180+).
        const current = loadCfg().model || '';
        const opts = models.map(m =>
            `<option value="${escapeAttr(m)}"${m === current ? ' selected' : ''}>${escapeHtml(m)}</option>`
        ).join('');
        $('#sp-cfg-model').replaceWith(
            `<select id="sp-cfg-model" class="sp-model-select">${opts}</select>`
        );
        if (!current) $('#sp-cfg-model').val(models[0]);
        showToast(`Đã tải ${models.length} model`);
    } catch (err) {
        showToast(`Lấy model thất bại: ${err.message}`, null, true);
    } finally {
        $btn.prop('disabled', false).html('<i class="fa-solid fa-list"></i>');
    }
}

function toggleSettings() {
    settingsOpen = !settingsOpen;
    const $overlay = $('#sp-settings-overlay');
    if (settingsOpen) {
        renderWiList();     // async, fire-and-forget — fills list when done
        renderScaleRow();   // per-character scale radios (sync)
        renderMemorySection();   // memory status + settings sync
        $overlay.stop(true).css({ display: 'flex', opacity: 0 }).animate({ opacity: 1 }, 180);
    } else {
        $overlay.stop(true).animate({ opacity: 0 }, 150, function () { $(this).css('display', 'none'); });
    }
    $(`#${MODAL_ID} .sp-settings-btn`).toggleClass('sp-btn-active', settingsOpen);
    syncMobileViewport();
}

// ─── Memory section renderer + handlers ─────────────────────────────────────
function renderMemorySection() {
    const s = getSettings();
    const useBbb = !!s.useBaiBaiBook;
    $('#sp-mem-source-bbb').prop('checked', useBbb);
    if (useBbb) {
        $('#sp-mem-internal').hide();
        $('#sp-mem-bbb-status').show();
        const api = globalThis.STBaiBaiBook;
        if (api && typeof api.getInjectedHistory === 'function') {
            let coverageMsg = 'BaiBaiBook đã sẵn sàng';
            try {
                const cov = api.getInjectedHistory()?.coverage;
                if (cov?.complete === false) coverageMsg += ` (thiếu tóm tắt của ${cov.missingAiFloors?.length ?? '?'} tin nhắn)`;
                else coverageMsg += ' (đã bao phủ đầy đủ)';
            } catch {}
            $('#sp-mem-bbb-status').html(`<i class="fa-solid fa-circle-check" style="color:var(--cardhub-accent,#7c9)"></i> ${escapeHtml(coverageMsg)}`);
        } else {
            $('#sp-mem-bbb-status').html('<i class="fa-solid fa-triangle-exclamation" style="color:#e0a54e"></i> API BaiBaiBook chưa sẵn sàng; khi tạo Điểm / Tuyến / Diện / Gian sẽ không đưa ký ức lịch sử vào');
        }
        return;
    }
    $('#sp-mem-internal').show();
    $('#sp-mem-bbb-status').hide();
    $('#sp-mem-enabled').prop('checked', s.memoryEnabled !== false);
    $('#sp-mem-l0').val(Number.isFinite(+s.memoryL0Group) ? +s.memoryL0Group : 5);
    $('#sp-mem-l1').val(Number.isFinite(+s.memoryL1Group) ? +s.memoryL1Group : 10);
    $('#sp-mem-skipshort').val(Number.isFinite(+s.memorySkipShort) ? +s.memorySkipShort : 50);
    refreshMemoryStatus();
}

function refreshMemoryStatus() {
    const r = memory.getHealthReport();
    const rows = [
        `<div class="sp-mem-stat"><span class="sp-mem-stat-k">Tổng số tin nhắn AI</span><span class="sp-mem-stat-v">${r.totalAi}</span></div>`,
        `<div class="sp-mem-stat"><span class="sp-mem-stat-k">Số nhóm ổn định</span><span class="sp-mem-stat-v">${r.totalGroups}</span></div>`,
        `<div class="sp-mem-stat"><span class="sp-mem-stat-k">Đã tạo L0</span><span class="sp-mem-stat-v">${r.withL0}</span></div>`,
        `<div class="sp-mem-stat"><span class="sp-mem-stat-k">Đang chờ tạo</span><span class="sp-mem-stat-v${r.pending > 0 ? ' sp-mem-warn' : ''}">${r.pending}</span></div>`,
        `<div class="sp-mem-stat"><span class="sp-mem-stat-k">Thất bại vĩnh viễn</span><span class="sp-mem-stat-v${r.permaFailed > 0 ? ' sp-mem-warn' : ''}">${r.permaFailed}</span></div>`,
        `<div class="sp-mem-stat"><span class="sp-mem-stat-k">Số chương L1</span><span class="sp-mem-stat-v">${r.l1Chapters}</span></div>`,
    ];
    if (r.paused) rows.push(`<div class="sp-mem-alert">⚠ Hệ thống ký ức đã tạm dừng: ${escapeHtml(r.lastError || 'thất bại liên tiếp')}. Bấm bổ sung hoặc xây lại để khôi phục.</div>`);
    if (r.busy)   rows.push(`<div class="sp-mem-alert sp-mem-alert-info">🔄 Hệ thống ký ức đang xử lý ở nền</div>`);
    $('#sp-mem-status').html(rows.join(''));
}

function bindMemoryHandlers() {
    $('#sp-mem-source-bbb').on('change', function () {
        getSettings().useBaiBaiBook = this.checked;
        saveSettingsDebounced();
        if (this.checked) memory.abortRebuild();
        renderMemorySection();
    });
    $('#sp-mem-enabled').on('change', function () {
        getSettings().memoryEnabled = this.checked;
        saveSettingsDebounced();
    });
    $('#sp-mem-l0').on('change', function () {
        const v = Math.max(1, Math.min(30, parseInt(this.value, 10) || 5));
        getSettings().memoryL0Group = v;
        this.value = v;
        saveSettingsDebounced();
    });
    $('#sp-mem-l1').on('change', function () {
        const v = Math.max(2, Math.min(30, parseInt(this.value, 10) || 10));
        getSettings().memoryL1Group = v;
        this.value = v;
        saveSettingsDebounced();
    });
    $('#sp-mem-skipshort').on('change', function () {
        const v = Math.max(0, Math.min(500, parseInt(this.value, 10) || 50));
        getSettings().memorySkipShort = v;
        this.value = v;
        saveSettingsDebounced();
    });
    $('#sp-mem-check').on('click', function () {
        refreshMemoryStatus();
        showToast('Đã làm mới trạng thái ký ức');
    });
    $('#sp-mem-fill').on('click', async function () {
        if ($(this).prop('disabled')) return;
        setMemoryProgressVisible(true);
        $(this).prop('disabled', true);
        try {
            await memory.fillMissing(({ current, total, done }) => {
                updateMemoryProgress(current, total);
                if (current % 3 === 0 || done) refreshMemoryStatus();
            });
            showToast('Bổ sung hoàn tất');
        } catch (err) {
            showToast('Bổ sung thất bại: ' + err.message, null, true);
        } finally {
            $(this).prop('disabled', false);
            setMemoryProgressVisible(false);
            refreshMemoryStatus();
        }
    });
    $('#sp-mem-rebuild').on('click', async function () {
        const r = memory.getHealthReport();
        const cost = r.totalGroups;
        const ok = await spConfirm({
            title  : 'Xây lại từ đầu',
            body   : `Sẽ xóa toàn bộ tóm tắt và tạo lại theo các nhóm hiện tại, cần khoảng ${cost} lần gọi API L0 + một số lần nén L1.`,
            note   : 'Có thể dừng trong lúc xây lại. Các Điểm / Tuyến / Diện đã có không bị ảnh hưởng.',
            confirmText: 'Bắt đầu xây lại',
            cancelText : 'Hủy',
        });
        if (!ok) return;
        if ($(this).prop('disabled')) return;
        setMemoryProgressVisible(true);
        $(this).prop('disabled', true);
        try {
            await memory.rebuildAll(({ current, total, done, aborted }) => {
                updateMemoryProgress(current, total, aborted);
                if (current % 3 === 0 || done || aborted) refreshMemoryStatus();
            });
            showToast('Xây lại hoàn tất');
        } catch (err) {
            showToast('Xây lại thất bại: ' + err.message, null, true);
        } finally {
            $(this).prop('disabled', false);
            setMemoryProgressVisible(false);
            refreshMemoryStatus();
        }
    });
    $('#sp-mem-progress-abort').on('click', () => memory.abortRebuild());
}

function setMemoryProgressVisible(visible) {
    $('#sp-mem-progress').toggle(!!visible);
    if (visible) updateMemoryProgress(0, 0);
}

function updateMemoryProgress(current, total, aborted = false) {
    $('#sp-mem-progress-count').text(aborted ? `Đã dừng (${current}/${total})` : `${current}/${total}`);
    const pct = total > 0 ? Math.round((current / total) * 100) : 0;
    $('#sp-mem-progress-fill').css('width', pct + '%');
}

// Renders the narrative-scale radio group into #sp-scale-row using the current
// character's saved value. Regenerated each time settings opens (character can
// change between opens).
function renderScaleRow() {
    const $row = $('#sp-scale-row');
    if (!$row.length) return;
    const ctx = getContext();
    const cid = ctx.characterId;
    const current = getScale(cid);
    const opts = SCALE_VALUES.map(v => `
        <label class="sp-mode-opt">
            <input type="radio" name="sp-lines-scale" value="${v}"${v === current ? ' checked' : ''}>
            <span>${escapeHtml(SCALE_LABELS[v])}</span>
        </label>`).join('');
    $row.html(opts);
}

// Render world-info entry checklist for the current character into #sp-wi-list.
// Perf: builds one HTML string + inserts once, uses event delegation on the list root.
let _wiEntryCache = new Map();   // key → entry object, for eye-button popup lookup

async function renderWiList() {
    const ctx = getContext();
    const characterId = ctx.characterId;
    const $list = $('#sp-wi-list');
    $list.html('<span class="sp-cfg-hint">Đang tải các mục World Info…</span>');

    let entries;
    try {
        entries = await getCharBookEntries(ctx);
    } catch (err) {
        $list.html(`<span class="sp-cfg-hint">Tải thất bại: ${escapeHtml(err.message || 'Lỗi không xác định')}</span>`);
        return;
    }

    if (!entries.length) {
        $list.html('<span class="sp-cfg-hint">Nhân vật hiện tại chưa gắn mục World Info nào</span>');
        return;
    }

    // Cache entries for the eye-button popup
    _wiEntryCache = new Map(entries.map(e => [e.key, e]));

    const disabledKeys = getDisabledKeys(characterId);

    // Group by source
    const groups = new Map();
    for (const e of entries) {
        if (!groups.has(e.source)) groups.set(e.source, []);
        groups.get(e.source).push(e);
    }

    // Build HTML in one pass
    const parts = [];
    parts.push(`<div class="sp-wi-all-row">
        <label class="sp-wi-toggle-all">
            <input type="checkbox" id="sp-wi-select-all"> Chọn tất cả / Bỏ chọn tất cả
        </label>
        <span class="sp-wi-count">${entries.length} mục</span>
    </div>`);

    for (const [source, group] of groups) {
        parts.push(`<div class="sp-wi-group">
            <div class="sp-wi-source-label">${escapeHtml(source)} <span class="sp-wi-group-count">${group.length} mục</span></div>
            <div class="sp-wi-items">`);
        for (const e of group) {
            const checked = !disabledKeys.has(e.key);
            parts.push(`<div class="sp-wi-card${checked ? '' : ' sp-wi-card-off'}" data-key="${escapeAttr(e.key)}" role="button" tabindex="0">
                <div class="sp-wi-card-head">
                    <input type="checkbox" class="sp-wi-cb" data-key="${escapeAttr(e.key)}"${checked ? ' checked' : ''}>
                    <span class="sp-wi-label">${escapeHtml(e.label)}</span>
                </div>
                <div class="sp-wi-card-body">
                    <div class="sp-wi-preview">${e.preview ? escapeHtml(e.preview) + '…' : '<span class="sp-wi-empty">(Không có nội dung)</span>'}</div>
                    <button class="sp-wi-view-btn" type="button" title="Xem toàn văn" data-key="${escapeAttr(e.key)}"><i class="fa-regular fa-eye"></i></button>
                </div>
            </div>`);
        }
        parts.push(`</div></div>`);
    }

    // Single DOM write
    $list[0].innerHTML = parts.join('');

    // Event delegation — one handler for the whole list, regardless of entry count
    $list.off('.wi').on('click.wi', '.sp-wi-view-btn', function (ev) {
        ev.stopPropagation();
        const key = $(this).data('key');
        const entry = _wiEntryCache.get(key);
        if (entry) showWiEntryFull(entry);
    }).on('click.wi', '.sp-wi-card', function (ev) {
        if ($(ev.target).closest('.sp-wi-view-btn').length) return;
        const $card = $(this);
        const $cb   = $card.find('.sp-wi-cb');
        if (ev.target !== $cb[0]) {
            $cb.prop('checked', !$cb.prop('checked'));
        }
        $card.toggleClass('sp-wi-card-off', !$cb.prop('checked'));
        syncWiSelectAll();
    }).on('keydown.wi', '.sp-wi-card', function (ev) {
        if (ev.key !== ' ' && ev.key !== 'Enter') return;
        ev.preventDefault();
        const $card = $(this);
        const $cb   = $card.find('.sp-wi-cb');
        $cb.prop('checked', !$cb.prop('checked'));
        $card.toggleClass('sp-wi-card-off', !$cb.prop('checked'));
        syncWiSelectAll();
    }).on('change.wi', '#sp-wi-select-all', function () {
        const checked = this.checked;
        $list.find('.sp-wi-cb').prop('checked', checked);
        $list.find('.sp-wi-card').toggleClass('sp-wi-card-off', !checked);
    });

    syncWiSelectAll();
}

function syncWiSelectAll() {
    const $cbs = $('#sp-wi-list .sp-wi-cb');
    if (!$cbs.length) return;
    const total   = $cbs.length;
    const checked = $cbs.filter(':checked').length;
    const $all = $('#sp-wi-select-all')[0];
    if (!$all) return;
    $all.checked       = checked === total;
    $all.indeterminate = checked > 0 && checked < total;
}

// Full-text popup for a single world-info entry
function showWiEntryFull(entry) {
    $('#sp-wi-fullview').remove();
    const $overlay = $(`<div id="sp-wi-fullview" class="sp-wi-fullview">
        <div class="sp-wi-fullview-sheet">
            <div class="sp-wi-fullview-head">
                <div class="sp-wi-fullview-title">
                    <div class="sp-wi-fullview-source">${escapeHtml(entry.source)}</div>
                    <div class="sp-wi-fullview-label">${escapeHtml(entry.label)}</div>
                </div>
                <button class="sp-icon-btn sp-wi-fullview-close" title="Đóng"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div class="sp-wi-fullview-body">${escapeHtml(entry.content || '').replace(/\n/g, '<br>')}</div>
        </div>
    </div>`);
    $overlay.on('click', function (e) {
        if (e.target === this) $overlay.remove();
    });
    $overlay.find('.sp-wi-fullview-close').on('click', () => $overlay.remove());
    $(`#${MODAL_ID} .sp-sheet`).append($overlay);
}

function toggleKeyVisibility() {
    const $el = $('#sp-cfg-key'), $icon = $('#sp-key-toggle i');
    if ($el.attr('type') === 'password') {
        $el.attr('type', 'text').val($el.data('real') || $el.val());
        $icon.removeClass('fa-eye').addClass('fa-eye-slash');
    } else {
        const r = $el.val(); $el.data('real', r).attr('type', 'password').val(maskKey(r));
        $icon.removeClass('fa-eye-slash').addClass('fa-eye');
    }
}

function saveSettings() {
    const $k = $('#sp-cfg-key'), key = ($k.data('real') || $k.val()).trim();
    saveCfg({ url: $('#sp-cfg-url').val().trim().replace(/\/$/, ''), key, model: $('#sp-cfg-model').val().trim() });
    saveLinesInterval($('#sp-lines-interval').val());
    saveLinesMode($('input[name="sp-lines-mode"]:checked').val());
    // Save world-info entry filter and narrative scale for current character
    const ctx = getContext();
    if (ctx.characterId != null) {
        const disabled = new Set();
        $('#sp-wi-list .sp-wi-cb').each(function () {
            if (!this.checked) disabled.add($(this).data('key'));
        });
        setDisabledKeys(ctx.characterId, disabled);
        const scaleVal = $('input[name="sp-lines-scale"]:checked').val() || 'auto';
        setScale(ctx.characterId, scaleVal);
    }
    $k.data('real', key).val(maskKey(key)).attr('type', 'password');
    const $m = $('#sp-cfg-msg'); $m.text('Đã lưu ✓'); setTimeout(() => $m.text(''), 2000);
    const hasApi = !!(loadCfg().url && loadCfg().key);
    $('#sp-settings-overlay .sp-api-notice')
        .removeClass('sp-notice-ok sp-notice-warn')
        .addClass(hasApi ? 'sp-notice-ok' : 'sp-notice-warn')
        .html(`<i class="fa-solid ${hasApi ? 'fa-circle-check' : 'fa-triangle-exclamation'}"></i>
            ${hasApi ? 'Đã cấu hình API riêng, việc tạo ở nền không ảnh hưởng đến trò chuyện'
                     : 'Chưa cấu hình API riêng: trong lúc tạo sẽ <b>chiếm dụng luồng chat</b>'}`);
    setTimeout(() => { if (settingsOpen) toggleSettings(); }, 400);
}

function applyTheme(theme) {
    currentTheme = theme;
    const forced = (getSettings().themeMode || 'auto') !== 'auto';
    const $modal = $(`#${MODAL_ID}`);
    const $fab   = $(`#${FAB_ID} .sp-fab-btn`);
    $modal.removeClass('sp-night sp-day sp-forced-day sp-forced-night').addClass(`sp-${theme}`);
    $fab.removeClass('sp-night sp-day sp-forced-day sp-forced-night').addClass(`sp-${theme}`);
    if (forced) {
        $modal.addClass(`sp-forced-${theme}`);
        $fab.addClass(`sp-forced-${theme}`);
    }
}

// ─── Theme mode toggle (day / night / auto) ─────────────────────────────────
// Auto follows ST theme; day/night force a fallback so users on transparent
// ST themes still get a readable panel.
function themeToggleIcon() {
    const mode = getSettings().themeMode || 'auto';
    if (mode === 'day')   return 'fa-sun';
    if (mode === 'night') return 'fa-moon';
    return 'fa-circle-half-stroke';   // auto
}

function themeToggleTitle() {
    const mode = getSettings().themeMode || 'auto';
    if (mode === 'day')   return 'Giao diện: Ban ngày (bấm để chuyển sang ban đêm)';
    if (mode === 'night') return 'Giao diện: Ban đêm (bấm để chuyển sang theo SillyTavern)';
    return 'Giao diện: Theo SillyTavern (bấm để chuyển sang ban ngày)';
}

function cycleThemeMode() {
    const cur  = getSettings().themeMode || 'auto';
    const next = cur === 'auto' ? 'day' : cur === 'day' ? 'night' : 'auto';
    getSettings().themeMode = next;
    saveSettingsDebounced();
    applyTheme(getEffectiveTheme());
    // Update this button's icon + tooltip in place
    const $btn = $(`#${MODAL_ID} .sp-theme-toggle-btn`);
    $btn.attr('title', themeToggleTitle());
    $btn.find('i').attr('class', `fa-solid ${themeToggleIcon()}`);
}

// ─── Drag (desktop only) ──────────────────────────────────────────────────────

function onDragStart(e) {
    // Skip on mobile — sheet is near-fullscreen and shouldn't move.
    if (isMobile()) return;
    // Ignore drags starting on interactive elements inside the header.
    if ($(e.target).closest('.sp-icon-btn, .sp-sub-btn, button, a, input, textarea').length) return;
    e.preventDefault();
    const sheet = document.querySelector(`#${MODAL_ID} .sp-sheet`);

    // Snap from CSS-transform centering to explicit px coords for drag math.
    // MUST cancel the CSS animation first — animation fill-mode has higher cascade
    // priority than inline styles, so transform:'none' alone won't override it.
    if (sheet.style.transform !== 'none') {
        sheet.style.animation = 'none';
        const snap = sheet.getBoundingClientRect();
        sheet.style.transform = 'none';
        sheet.style.right     = 'auto';
        sheet.style.left      = snap.left + 'px';
        sheet.style.top       = snap.top  + 'px';
    }

    const cx   = e.touches ? e.touches[0].clientX : e.clientX;
    const cy   = e.touches ? e.touches[0].clientY : e.clientY;
    const rect = sheet.getBoundingClientRect();
    dragState  = { startX: cx, startY: cy, origLeft: rect.left, origTop: rect.top };

    $(document).on('mousemove.spdrag', onDragMove).on('mouseup.spdrag', onDragEnd);
    document.addEventListener('touchmove', onDragMove, { passive: false });
    document.addEventListener('touchend',  onDragEnd);
    document.body.style.cursor = 'grabbing';
}

function onDragMove(e) {
    if (!dragState) return;
    e.preventDefault();
    const cx = e.touches ? e.touches[0].clientX : e.clientX;
    const cy = e.touches ? e.touches[0].clientY : e.clientY;
    const sheet = document.querySelector(`#${MODAL_ID} .sp-sheet`);
    const left = Math.max(0, Math.min(dragState.origLeft + cx - dragState.startX, window.innerWidth  - sheet.offsetWidth));
    const top  = Math.max(0, Math.min(dragState.origTop  + cy - dragState.startY, window.innerHeight - 60));
    sheet.style.left  = left + 'px';
    sheet.style.top   = top  + 'px';
    sheet.style.right = 'auto';
}

function onDragEnd() {
    if (!dragState) return;
    const sheet = document.querySelector(`#${MODAL_ID} .sp-sheet`);
    const rect  = sheet.getBoundingClientRect();
    if (!isMobile()) {
        localStorage.setItem(POS_KEY, JSON.stringify({ left: rect.left, top: rect.top }));
    }
    dragState = null;
    $(document).off('mousemove.spdrag mouseup.spdrag');
    document.removeEventListener('touchmove', onDragMove);
    document.removeEventListener('touchend',  onDragEnd);
    document.body.style.cursor = '';
}

// ─── Resize ───────────────────────────────────────────────────────────────────

function onResizeStart(e) {
    // Resize is desktop-only. On mobile the sheet is near-fullscreen and the
    // handle is hidden; any resize event on mobile is stray (e.g. bubbling
    // from the outline divider) — ignore it so the sheet doesn't shrink.
    if (isMobile()) return;
    e.preventDefault();
    e.stopPropagation();
    const sheet = document.querySelector(`#${MODAL_ID} .sp-sheet`);

    // Desktop sheet uses `right: 20px` as its horizontal anchor. If we grow
    // width while `right` is fixed, the LEFT edge moves outward instead of
    // the right edge. Snap to left-anchored inline coords before resizing.
    if (!sheet.style.left || sheet.style.right !== 'auto') {
        const snap = sheet.getBoundingClientRect();
        sheet.style.left  = snap.left + 'px';
        sheet.style.top   = snap.top  + 'px';
        sheet.style.right = 'auto';
    }

    sheet.style.willChange = 'width, height';
    document.body.style.userSelect = 'none';
    const cx = e.touches ? e.touches[0].clientX : e.clientX;
    const cy = e.touches ? e.touches[0].clientY : e.clientY;
    resizeState = {
        startX: cx, startY: cy,
        origW : sheet.offsetWidth, origH : sheet.offsetHeight,
    };
    $(document).on('mousemove.spresize', onResizeMove).on('mouseup.spresize', onResizeEnd);
    document.addEventListener('touchmove', onResizeMove, { passive: false });
    document.addEventListener('touchend',  onResizeEnd);
}

function onResizeMove(e) {
    if (!resizeState) return;
    e.preventDefault();
    const touch = e.touches?.[0] ?? e.changedTouches?.[0];
    const cx = touch ? touch.clientX : e.clientX;
    const cy = touch ? touch.clientY : e.clientY;
    if (resizeRAF) return;
    resizeRAF = requestAnimationFrame(() => {
        resizeRAF = null;
        const sheet = document.querySelector(`#${MODAL_ID} .sp-sheet`);
        const mobile = isMobile();
        // On mobile, we ALSO override max-width (CSS media query caps it at 340px);
        // without this, inline width can't exceed the cap.
        const maxW = mobile
            ? Math.min(window.innerWidth - 10, 500)
            : window.innerWidth - 10;
        const w = Math.max(280, Math.min(maxW, resizeState.origW + cx - resizeState.startX));
        const h = Math.max(300, Math.min(window.innerHeight - 10, resizeState.origH + cy - resizeState.startY));
        sheet.style.width     = w + 'px';
        sheet.style.height    = h + 'px';
        sheet.style.maxHeight = h + 'px';
        if (mobile) {
            sheet.style.maxWidth = w + 'px';
            // Recenter after resize: keep translateX(-50%) if still set, else pin left
            if (!sheet.style.left || sheet.style.left === '50%') {
                sheet.style.left = '50%';
            }
        }
    });
}

function onResizeEnd() {
    if (!resizeState) return;
    if (resizeRAF) { cancelAnimationFrame(resizeRAF); resizeRAF = null; }
    const sheet = document.querySelector(`#${MODAL_ID} .sp-sheet`);
    sheet.style.willChange = '';
    document.body.style.userSelect = '';
    localStorage.setItem(SIZE_KEY, JSON.stringify({ width: sheet.offsetWidth, height: sheet.offsetHeight }));
    resizeState = null;
    $(document).off('mousemove.spresize mouseup.spresize');
    document.removeEventListener('touchmove', onResizeMove);
    document.removeEventListener('touchend',  onResizeEnd);
}

function restoreOutlineChatHeight() {
    const h = parseInt(localStorage.getItem('sp-outline-chat-h')) || 210;
    const el = document.getElementById('sp-outline-chat');
    if (el) el.style.height = h + 'px';
}

function positionPanel() {
    const sheet = document.querySelector(`#${MODAL_ID} .sp-sheet`);
    if (!sheet) return;
    if (isMobile()) {
        sheet.style.left      = '';
        sheet.style.top       = '';
        sheet.style.right     = '';
        sheet.style.height    = '';
        sheet.style.transform = '';
        syncMobileViewport();
        bindViewportSync();
        return;
    }
    const pos = JSON.parse(localStorage.getItem(POS_KEY) || 'null');
    if (pos) {
        sheet.style.left  = Math.min(pos.left, window.innerWidth  - sheet.offsetWidth)  + 'px';
        sheet.style.top   = Math.min(pos.top,  window.innerHeight - 60) + 'px';
        sheet.style.right = 'auto';
    }
}

function bindViewportSync() {
    if (viewportSyncBound) return;
    viewportSyncBound = true;
    const onViewportChange = () => syncMobileViewport();
    window.addEventListener('resize', onViewportChange);
    window.addEventListener('orientationchange', onViewportChange);
    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', onViewportChange);
        window.visualViewport.addEventListener('scroll', onViewportChange);
    }
}

function syncMobileViewport() {
    if (!isMobile()) return;
    const root  = document.getElementById(MODAL_ID);
    const sheet = document.querySelector(`#${MODAL_ID} .sp-sheet`);
    if (!root || !sheet || root.style.display === 'none') return;

    // Read safe-area insets from CSS env() via a probe element.
    // Fallback to 0 when unsupported (older Android browsers).
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;visibility:hidden;top:env(safe-area-inset-top,0px);bottom:env(safe-area-inset-bottom,0px)';
    document.body.appendChild(probe);
    const cs = getComputedStyle(probe);
    const safeTop = parseFloat(cs.top) || 0;
    const safeBot = parseFloat(cs.bottom) || 0;
    document.body.removeChild(probe);

    const vv = window.visualViewport;
    const vh = Math.max(320, Math.round((vv?.height || window.innerHeight)));
    const top = 20 + safeTop;
    const bottomGap = 20 + safeBot;
    const maxH = Math.max(260, vh - top - bottomGap);

    sheet.style.top = `${top}px`;
    sheet.style.height = `${maxH}px`;
    sheet.style.maxHeight = `${maxH}px`;
}

// ─── Toast (top) ──────────────────────────────────────────────────────────────

function injectToastContainer() {
    if (!$('#sp-toast-wrap').length) document.documentElement.insertAdjacentHTML('beforeend', '<div id="sp-toast-wrap"></div>');
}

function showToast(msg, onClick, isError = false) {
    const $t = $(`<div class="sp-toast${isError ? ' sp-toast-error' : ''}">
        <i class="fa-solid ${isError ? 'fa-circle-exclamation' : 'fa-calendar-check'}"></i>
        <span>${escapeHtml(msg)}</span>
    </div>`);
    $('#sp-toast-wrap').append($t);
    requestAnimationFrame(() => $t.addClass('sp-toast-show'));
    if (onClick) $t.css('cursor', 'pointer').on('click', () => { onClick(); $t.remove(); });
    setTimeout(() => { $t.removeClass('sp-toast-show'); setTimeout(() => $t.remove(), 350); }, 4000);
}

// ─── Rendering ────────────────────────────────────────────────────────────────

const TYPE_META = {
    main  : { icon: 'fa-bolt',      label: 'Tuyến nổi', cls: 'sp-type-world'     },
    hidden: { icon: 'fa-eye-slash', label: 'Tuyến ngầm', cls: 'sp-type-major'     },
    bond  : { icon: 'fa-heart',     label: 'Tuyến duyên', cls: 'sp-type-character' },
};

function renderSchedule(raw, userName, perspective = 'user') {
    const { days, future, startDate } = parseCalendar(raw);
    const hasFuture = future && future.events.length > 0;
    const chipCls   = perspective === 'char' ? 'sp-char-chip' : 'sp-user-chip';
    const header = `<div class="sp-schedule-header">
        <span class="${chipCls}">${escapeHtml(userName)}</span>
        <span class="sp-schedule-label">· Điểm</span>
        <button class="sp-panel-refresh sp-refresh-schedule" title="Tạo lại Điểm"><i class="fa-solid fa-rotate-right"></i></button>
    </div>`;
    if (days.length === 0 && !hasFuture) return header + `<div class="sp-raw">${escapeHtml(raw).replace(/\n/g, '<br>')}</div>`;

    const WEEKDAYS = ['CN','T2','T3','T4','T5','T6','T7'];
    const totalTabs = days.length + (hasFuture ? 1 : 0);

    const tabs = days.map((_, i) => {
        let numLabel = String(i + 1);
        let wdLabel = '';
        if (startDate) {
            const d = new Date(startDate);
            d.setDate(d.getDate() + i);
            wdLabel  = WEEKDAYS[d.getDay()];
            numLabel = `${d.getMonth() + 1}/${d.getDate()}`;
        }
        return `<button class="sp-tab${i === 0 ? ' sp-tab-active' : ''}" data-day="${i}">
            <span class="sp-tab-num">${numLabel}</span>
            ${wdLabel ? `<span class="sp-tab-wd">${wdLabel}</span>` : ''}
        </button>`;
    });
    if (hasFuture) tabs.push(`<button class="sp-tab" data-day="${days.length}">
        <span class="sp-tab-num">Tương lai</span>
    </button>`);

    const panels = days.map(day =>
        `<div class="sp-day-panel" style="width:calc(100%/${totalTabs})">${day.events.map(renderEvent).join('')}</div>`
    );
    if (hasFuture) panels.push(
        `<div class="sp-day-panel sp-future-panel" style="width:calc(100%/${totalTabs})">${future.events.map(renderEvent).join('')}</div>`
    );

    const debug = days.length < 3 ? `
        <details class="sp-debug"><summary>⚠ Chỉ phân tích được ${days.length} ngày</summary>
        <pre class="sp-debug-raw">${escapeHtml(raw)}</pre></details>` : '';

    return `${header}<div class="sp-tab-bar" data-total="${totalTabs}">${tabs.join('')}</div>
        <div class="sp-days-wrap"><div class="sp-days-track" data-total="${totalTabs}" style="width:${totalTabs * 100}%">${panels.join('')}</div></div>${debug}`;
}

function parseCalendar(raw) {
    const m = raw.match(/<calendar_widget[^>]*>([\s\S]*?)<\/calendar_widget>/i);
    // Strip HTML comments across the whole widget body before splitting into lines.
    // LLM often emits multi-line <!-- Suy nghĩ về lịch trình: ... --> blocks; per-line startsWith
    // would only skip the first line and treat the rest as content.
    const content = (m ? m[1] : raw).replace(/<!--[\s\S]*?-->/g, '');

    const dateMatch = content.match(/^StartDate:\s*(\d{4}-\d{2}-\d{2})/m);
    let startDate = null;
    if (dateMatch) {
        const d = new Date(dateMatch[1]);
        if (!isNaN(d)) startDate = d;
    }

    const days = []; let cur = null; let inFuture = false; let future = null;
    for (const line of content.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        if (/^Day\s*:?\s*\d+/i.test(t) || /^第[一二三四五六七\d]+天/.test(t)) {
            if (cur && !inFuture) days.push(cur);
            cur = { events: [] }; inFuture = false; continue;
        }
        if (/^Future\s*:/i.test(t) || /^未来\s*:/i.test(t)) {
            if (cur && !inFuture) days.push(cur);
            future = { events: [] }; cur = future; inFuture = true; continue;
        }
        if (/^Event\s*:/i.test(t)) {
            if (!cur) cur = { events: [] };
            const parts = t.replace(/^Event\s*:\s*/i, '').split('|');
            if (parts.length >= 4) cur.events.push({
                type: (parts[0]||'user').trim().toLowerCase(), title: (parts[1]||'').trim(),
                desc: (parts[2]||'').trim(), time: (parts[3]||'').trim(),
                location: (parts[4]||'').trim(), npcAction: (parts[5]||'').trim(),
            });
        }
    }
    if (cur && !inFuture) days.push(cur);
    return { days: days.filter(d => d.events.length > 0), future, startDate };
}

function renderEvent(ev) {
    const meta = TYPE_META[ev.type] || TYPE_META.main;
    const injectParts = ['【Tham khảo Điểm】'];
    if (ev.time) injectParts.push(`Thời gian: ${ev.time}`);
    injectParts.push(ev.title);
    if (ev.desc)      injectParts.push(ev.desc);
    if (ev.location)  injectParts.push(`Địa điểm: ${ev.location}`);
    if (ev.npcAction) injectParts.push(`Diễn biến liên đới: ${ev.npcAction}`);
    const injectBtn = makeInjectBtn(injectParts.join('\n'));
    return `<div class="sp-event ${meta.cls}">
        <div class="sp-event-head">
            <span class="sp-type-badge"><i class="fa-solid ${meta.icon}"></i>${escapeHtml(meta.label)}</span>
            <span class="sp-event-title">${escapeHtml(ev.title)}</span>
            ${ev.time ? `<span class="sp-event-time"><i class="fa-regular fa-clock"></i> ${escapeHtml(ev.time)}</span>` : ''}
            ${injectBtn}
        </div>
        ${ev.desc ? `<p class="sp-event-desc">${escapeHtml(ev.desc)}</p>` : ''}
        <div class="sp-event-meta">
            ${ev.location  ? `<span class="sp-event-loc"><i class="fa-solid fa-location-dot"></i>${escapeHtml(ev.location)}</span>` : ''}
            ${ev.npcAction ? `<span class="sp-event-npc"><i class="fa-solid fa-link"></i>${escapeHtml(ev.npcAction)}</span>` : ''}
        </div>
    </div>`;
}

function escapeHtml(s)  { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function escapeAttr(s)  { return String(s).replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function cleanText(s) {
    return String(s)
        .replace(/<ruby[^>]*>[\s\S]*?<\/ruby>/gi, (m) =>
            m.replace(/<rt[^>]*>[\s\S]*?<\/rt>/gi, '').replace(/<\/?ruby[^>]*>/gi, ''))
        .replace(/<rt[^>]*>[\s\S]*?<\/rt>/gi, '')
        .replace(/<[^>]+>/g, '')
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/\*(.+?)\*/g, '$1')
        .replace(/_{1,2}(.+?)_{1,2}/g, '$1')
        .replace(/~~(.+?)~~/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .trim();
}

